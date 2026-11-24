import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  allowedDevOrigins: ['192.168.1.14', 'localhost', '127.0.0.1', '*.lhr.life'],
};

export default nextConfig;
