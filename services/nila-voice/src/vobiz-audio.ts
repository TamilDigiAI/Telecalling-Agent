/**
 * Vobiz Bidirectional Audio Format & Sample-Rate Conversion Utilities.
 *
 * Vobiz <Stream> inbound formats:
 *   - audio/x-l16;rate=8000 | audio/x-l16;rate=16000
 *   - audio/x-mulaw;rate=8000
 *
 * Vobiz WebSocket `playAudio` outbound formats:
 *   - audio/x-l16 (sampleRate: 8000 | 16000 | 24000) — raw signed 16-bit LE mono PCM (no WAV header)
 *   - audio/x-mulaw (sampleRate: 8000)
 */

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

/**
 * Decodes G.711 mu-law bytes (8kHz) into signed 16-bit little-endian linear PCM.
 */
export function ulawToPcm16(ulawBuffer: Buffer): Buffer {
  const out = Buffer.alloc(ulawBuffer.length * 2);
  for (let i = 0; i < ulawBuffer.length; i++) {
    const uVal = (~ulawBuffer[i]) & 0xff;
    const sign = uVal & 0x80;
    const exponent = (uVal >> 4) & 0x07;
    const mantissa = uVal & 0x0f;
    let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
    sample -= ULAW_BIAS;
    if (sign !== 0) sample = -sample;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

/**
 * Encodes signed 16-bit little-endian linear PCM into G.711 mu-law bytes.
 */
export function pcm16ToUlaw(pcmBuffer: Buffer): Buffer {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const out = Buffer.alloc(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    let sign = 0;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }
    if (sample > ULAW_CLIP) sample = ULAW_CLIP;
    sample += ULAW_BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
      // find highest set bit
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  return out;
}

/**
 * Linearly resamples mono 16-bit LE PCM between sample rates (e.g. 8000 <-> 16000 <-> 24000).
 */
export function resamplePcm16(pcmBuffer: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || pcmBuffer.length < 2) {
    return Buffer.from(pcmBuffer);
  }
  const inSamples = Math.floor(pcmBuffer.length / 2);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = (i * fromRate) / toRate;
    const idx0 = Math.min(inSamples - 1, Math.floor(srcPos));
    const idx1 = Math.min(inSamples - 1, idx0 + 1);
    const frac = srcPos - idx0;
    const s0 = pcmBuffer.readInt16LE(idx0 * 2);
    const s1 = pcmBuffer.readInt16LE(idx1 * 2);
    const interpolated = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return out;
}

/**
 * Parses a RIFF/WAVE header (such as Sarvam Bulbul v3 WAV output), verifies its actual sample rate,
 * and returns the stripped raw PCM bytes alongside the true sample rate so Vobiz playAudio
 * always declares the exact sampleRate matching the raw bytes.
 */
export function parseWavAndStripHeader(wavBuffer: Buffer): {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
} {
  if (
    wavBuffer.length >= 44 &&
    wavBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    wavBuffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    let offset = 12;
    let sampleRate = 24000;
    let channels = 1;
    let bitsPerSample = 16;
    let dataOffset = 44;
    let dataSize = wavBuffer.length - 44;

    while (offset + 8 <= wavBuffer.length) {
      const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
      const chunkSize = wavBuffer.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ' && offset + 24 <= wavBuffer.length) {
        channels = wavBuffer.readUInt16LE(offset + 10);
        sampleRate = wavBuffer.readUInt32LE(offset + 12);
        bitsPerSample = wavBuffer.readUInt16LE(offset + 22);
      } else if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = Math.min(chunkSize, wavBuffer.length - dataOffset);
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    return {
      pcm: wavBuffer.subarray(dataOffset, dataOffset + dataSize),
      sampleRate,
      channels,
      bitsPerSample,
    };
  }

  // Fallback: assume raw 16kHz 16-bit mono PCM if no RIFF header
  return {
    pcm: wavBuffer,
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  };
}

/**
 * Wraps raw 16-bit LE mono PCM bytes in a standard RIFF/WAVE header for Sarvam Saaras STT.
 */
export function wrapPcm16AsWav(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcmBuffer.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Converts incoming Vobiz media bytes (based on negotiated mediaFormat) into 16kHz 16-bit mono PCM
 * ready for Sarvam Saaras STT.
 */
export function convertIncomingVobizAudioToSarvamPcm16k(
  rawPayload: Buffer,
  contentType: string,
  sampleRate: number
): Buffer {
  const normalizedType = contentType.toLowerCase();
  let pcm: Buffer;
  let effectiveRate = sampleRate || 8000;

  if (normalizedType.includes('mulaw') || normalizedType.includes('pcmu')) {
    pcm = ulawToPcm16(rawPayload);
    effectiveRate = sampleRate || 8000;
  } else {
    pcm = rawPayload;
  }

  return resamplePcm16(pcm, effectiveRate, 16000);
}

/**
 * Computes RMS energy (0..1) of a 16-bit mono PCM frame for barge-in & silence detection.
 */
export function computePcm16Rms(pcmBuffer: Buffer): number {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = pcmBuffer.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / sampleCount);
}

/**
 * Splits raw 16-bit mono PCM into fixed-duration chunks (default 40ms) for Vobiz `playAudio` frames.
 */
export function chunkPcm16ForVobizPlayAudio(
  pcmBuffer: Buffer,
  sampleRate: number,
  chunkMs = 40
): Buffer[] {
  const bytesPerChunk = Math.max(320, Math.floor((sampleRate * 2 * chunkMs) / 1000));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcmBuffer.length; offset += bytesPerChunk) {
    chunks.push(pcmBuffer.subarray(offset, Math.min(offset + bytesPerChunk, pcmBuffer.length)));
  }
  return chunks;
}
