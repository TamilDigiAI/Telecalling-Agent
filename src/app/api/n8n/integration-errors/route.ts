import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_WORKSPACE_SLUG } from '@/lib/env';
import {
  getServerAutomationSupabaseClient,
  sanitizeIntegrationErrorMessage,
  verifyN8nBackendAuth,
} from '@/lib/n8n/auth';
import type { IntegrationErrorRecord, Workspace } from '@/types/crm';

export const runtime = 'nodejs';

/**
 * POST /api/n8n/integration-errors
 * Invoked by n8n Workflow C ("Nila — Integration Errors") on any workflow failure.
 * Persists a sanitized error record for display on the CRM Integrations page.
 */
export async function POST(request: NextRequest) {
  try {
    if (!verifyN8nBackendAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized n8n request' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      source?: IntegrationErrorRecord['source'];
      workflowName?: string;
      executionId?: string;
      nodeName?: string;
      errorCode?: string;
      message?: string;
      metadata?: Record<string, unknown>;
      workspaceSlug?: string;
    };

    const workspaceSlug = body.workspaceSlug?.trim() || DEFAULT_WORKSPACE_SLUG;
    const supabase = await getServerAutomationSupabaseClient();

    const { data: wsData } = await supabase
      .from('workspaces')
      .select('*')
      .eq('slug', workspaceSlug)
      .maybeSingle();

    const workspace = wsData as Workspace | null;
    if (!workspace) {
      return NextResponse.json({ error: `Workspace "${workspaceSlug}" not found` }, { status: 404 });
    }

    const sanitizedMessage = sanitizeIntegrationErrorMessage(
      body.message || 'Unhandled n8n workflow error'
    );

    const safeMetadata: Record<string, unknown> = {};
    if (body.metadata && typeof body.metadata === 'object') {
      for (const [k, v] of Object.entries(body.metadata)) {
        if (/token|secret|key|auth|password/i.test(k)) continue;
        safeMetadata[k] = typeof v === 'string' ? sanitizeIntegrationErrorMessage(v) : v;
      }
    }

    const { data: inserted, error } = await supabase
      .from('integration_errors')
      .insert({
        workspace_id: workspace.id,
        source: body.source || 'n8n',
        workflow_name: body.workflowName || null,
        execution_id: body.executionId || null,
        node_name: body.nodeName || null,
        error_code: body.errorCode || null,
        sanitized_message: sanitizedMessage,
        metadata: safeMetadata,
        resolved: false,
      })
      .select('*')
      .single();

    if (error || !inserted) {
      throw error || new Error('Failed to record integration error');
    }

    return NextResponse.json({
      ok: true,
      errorRecord: inserted,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to log integration error' },
      { status: 500 }
    );
  }
}
