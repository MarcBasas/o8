import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readActiveIdentity } from '@/lib/github-broker/managed';
import { requireTaskDraftAccount } from '@/lib/mcp/task-draft-account';
import { TaskDraftError } from '@/lib/mcp/task-draft-contract';
import { listTaskDrafts } from '@/lib/mcp/task-draft-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local operator inspection only; there is deliberately no dispatch mutation. */
export async function GET(request: Request): Promise<Response> {
  const role = resolveRequestPrincipal(request);
  if (role !== 'operator') return NextResponse.json({ error: 'operator_required' }, { status: role === 'anonymous' ? 401 : 403 });
  try {
    const admission = { accountId: readActiveIdentity() ?? undefined, expiresAt: Infinity };
    const account = await requireTaskDraftAccount(admission);
    const drafts = listTaskDrafts(account.accountId).map((draft) => ({
      taskId: draft.taskId, createdAt: draft.createdAt, state: draft.state, executionEnabled: false,
      sessionCurrent: draft.account.epoch === account.epoch, policy: draft.policy,
      contract: draft.contract, revision: draft.snapshot.revision, rulesDigest: draft.snapshot.rulesDigest,
    }));
    await requireTaskDraftAccount(admission, account);
    return NextResponse.json({ ok: true, drafts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TaskDraftError ? error.code : 'draft_store_unavailable' },
      { status: error instanceof TaskDraftError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
