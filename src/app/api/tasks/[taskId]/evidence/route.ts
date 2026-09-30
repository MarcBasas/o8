import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getTaskPoolTask } from '@/lib/tasks/pool';
import { readRemoteTaskEvidence } from '@/lib/tasks/remote-evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role === 'worker' || principal.role === 'device' || principal.role === 'spectator') {
    return NextResponse.json({ error: 'Remote task evidence is available in the operator panel.' }, { status: 403, headers });
  }

  const { taskId } = await context.params;
  const jobId = request.nextUrl.searchParams.get('jobId')?.trim() ?? '';
  const attempt = Number(request.nextUrl.searchParams.get('attempt'));
  if (!taskId?.trim() || !jobId || !Number.isSafeInteger(attempt) || attempt < 0) {
    return NextResponse.json({ error: 'Task, job, and attempt are required.' }, { status: 400, headers });
  }

  try {
    const task = await getTaskPoolTask(taskId);
    if (!task) return NextResponse.json({ error: 'Task not found.' }, { status: 404, headers });
    if (!task.packetId || !task.execution || task.execution.jobId !== jobId || task.execution.attempt !== attempt) {
      return NextResponse.json({ error: 'The remote execution changed. Refresh the task before opening evidence.' }, { status: 409, headers });
    }
    const evidence = readRemoteTaskEvidence(DEFAULT_CLOUD_TEAM_ID, jobId, attempt);
    const current = await getTaskPoolTask(taskId);
    if (!current?.execution || current.packetId !== task.packetId
      || current.execution.jobId !== jobId || current.execution.attempt !== attempt || !evidence.available) {
      return NextResponse.json({ error: 'The remote execution changed. Refresh the task before opening evidence.' }, { status: 409, headers });
    }
    return NextResponse.json({
      schema: 'o8/task.remote-evidence/v1',
      packetId: task.packetId,
      jobId,
      attempt,
      status: current.execution.status,
      leaseState: current.execution.leaseState,
      logs: evidence.logs,
      files: evidence.files,
      logsTruncated: evidence.logsTruncated,
      filesTruncated: evidence.filesTruncated,
      workspaceAccess: 'unavailable',
      previewAccess: 'unavailable',
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'Unable to read remote task evidence.' }, { status: 500, headers });
  }
}
