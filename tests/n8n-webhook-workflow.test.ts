import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as exotelDialPost } from '@/app/api/webhooks/n8n/exotel-dial/route';
import { GET, POST } from '@/app/api/webhooks/n8n/lead-intake/route';

describe('n8n Google Sheet -> Nila Picks Exotel -> Call Qualified Lead -> CRM & Sheet -> Follow-Up Loop', () => {
  it('validates the 8-node closed-loop n8n workflow JSON with Exotel dial and follow-up loop back to Nila', () => {
    const workflowPath = path.resolve(
      process.cwd(),
      'n8n/digianchorz-nila-google-sheet-crm-workflow.json'
    );
    expect(fs.existsSync(workflowPath)).toBe(true);

    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8')) as {
      id: string;
      name: string;
      nodes: Array<{ name: string; type: string; parameters: Record<string, unknown> }>;
      connections: Record<
        string,
        { main: Array<Array<{ node: string; type: string; index: number }>> }
      >;
    };

    expect(workflow.id).toBe('digianchorzNila01');
    expect(workflow.nodes).toHaveLength(8);

    const nodeNames = workflow.nodes.map((n) => n.name);
    expect(nodeNames).toContain(
      '3. Nila Picks Exotel Number (09513886363) & Calls Qualified Lead'
    );
    expect(nodeNames).toContain('4. Nila Voice Qualification & Update CRM Dashboard');
    expect(nodeNames).toContain('5. Update Google Sheet Row (Outcome, Temp & Callback)');
    expect(nodeNames).toContain(
      '6. Needs Follow-Up Call Again? (Callback / Warm / No Answer)'
    );
    expect(nodeNames).toContain(
      '7. Wait for Follow-Up Window & Loop Back to Nila -> Exotel -> CRM -> Sheet'
    );

    // Verify closed-loop connection from Node 7 back to Node 3 (Nila Picks Exotel Number)
    const waitLoopTargets =
      workflow.connections[
        '7. Wait for Follow-Up Window & Loop Back to Nila -> Exotel -> CRM -> Sheet'
      ]?.main?.[0] ?? [];
    expect(waitLoopTargets[0]?.node).toBe(
      '3. Nila Picks Exotel Number (09513886363) & Calls Qualified Lead'
    );
  });

  it('picks Exotel number 09513886363, calls qualified lead, updates CRM & Google Sheet, and flags follow-up loop when needed', async () => {
    const healthRes = await GET();
    expect(healthRes.status).toBe(200);

    // Step 1 (Node 3): Nila picks Exotel number 09513886363 and dials the qualified lead
    const dialReq = new NextRequest('http://localhost:3000/api/webhooks/n8n/exotel-dial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'Lead ID': 'GSHEET-N8N-TEST-01',
        Name: 'Senthil Kumar (Karur)',
        Phone: '6383939949',
        Service: 'Meta Ads for Facebook and Instagram lead generation',
        Source: 'Google Sheet Lead Form',
        exotelAccountSid: 'digianchorz1',
        exotelCallerId: '09513886363',
        exotelAppId: '1370873',
        attemptNumber: 1,
      }),
    });

    const dialRes = await exotelDialPost(dialReq);
    expect(dialRes.status).toBe(200);
    const dialData = await dialRes.json();
    expect(dialData.ok).toBe(true);
    expect(dialData.exotelPicked.agentName).toBe('Nila');
    expect(dialData.exotelPicked.exotelCallerId).toBe('09513886363');
    expect(dialData.exotelPicked.exotelAccountSid).toBe('digianchorz1');

    // Step 2 (Node 4): Nila voice qualification, CRM update, 20-column Sheet write-back, and follow-up loop evaluation
    const intakeReq = new NextRequest('http://localhost:3000/api/webhooks/n8n/lead-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...dialData,
        'Calling Eligibility': 'ELIGIBLE',
        'Eligibility Reference': 'N8N-FORM-CONSENT-01',
        'Do Not Call': 'FALSE',
        row_number: 3,
        includeAudio: false,
      }),
    });

    const res = await POST(intakeReq);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.lead.phoneE164).toBe('+916383939949');
    expect(data.lead.leadTemperature).toBe('HOT');
    expect(data.lead.callOutcome).toBe('CALLBACK_REQUESTED');
    expect(data.telephony.exotelCallerId).toBe('09513886363');
    expect(data.crmUpdate.follow_up_task_id).toBeTruthy();

    // Verify 20-column Google Sheet write-back row
    expect(data.sheetWriteBackRow['CRM Lead ID']).toBe(data.lead.id);
    expect(data.sheetWriteBackRow['Call Outcome']).toBe('CALLBACK_REQUESTED');
    expect(data.sheetWriteBackRow['Lead Temperature']).toBe('HOT');
    expect(data.sheetWriteBackRow['Sync Status']).toBe('SYNCED');
    expect(data.sheetWriteBackRow['Automation Do Not Call']).toBe('FALSE');

    // Verify closed-loop follow-up evaluation (Node 6 -> Node 7 -> Node 3)
    expect(data.followUpLoop.needsFollowUpAgain).toBe(true);
    expect(data.followUpLoop.exotelCallerId).toBe('09513886363');
    expect(data.followUpLoop.routeBackTo).toBe(
      '3. Nila Picks Exotel Number (09513886363) & Calls Qualified Lead'
    );
  });
});
