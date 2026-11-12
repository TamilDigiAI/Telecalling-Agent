import { NextResponse } from 'next/server';
import {
  requireWorkspaceActionContext,
  WorkspaceAccessDeniedError,
} from '@/lib/auth/workspace-guard';
import {
  processPendingSheetSyncJobs,
  pullLeadsFromGoogleSheet,
} from '@/lib/sheets/google-sheets-sync';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const { supabase, workspace, user } = await requireWorkspaceActionContext();
    const [pullResult, pushResult] = await Promise.all([
      pullLeadsFromGoogleSheet(
        supabase,
        workspace.id,
        workspace.google_sheet_id,
        workspace.google_sheet_tab || 'Leads',
        user.id
      ),
      processPendingSheetSyncJobs(supabase, workspace.id),
    ]);

    return NextResponse.json({
      ok: true,
      sheetId: workspace.google_sheet_id,
      sheetTab: workspace.google_sheet_tab || 'Leads',
      pullResult,
      pushResult,
    });
  } catch (err) {
    if (err instanceof WorkspaceAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Google Sheets sync failed' },
      { status: 500 }
    );
  }
}
