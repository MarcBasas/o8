import { revokeReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { launchRuntimeSurface } from '@/lib/runtime/actions';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { createLane } from '@/lib/lane/registry';
import { withAccountStateAdmission } from '@/lib/auth/account-state';
import { readActiveIdentity } from '@/lib/github-broker/managed';
import { withTaskDraftAccountAdmission } from './task-draft-account';
import { exactKeys, normalizedText, object, TaskDraftError } from './task-draft-contract';
import { findTaskDraft, type TaskDraftRecord } from './task-draft-store';
import { operatorAccount, readExecutionSession, reconcileTaskExecution } from './task-execution-admission';
import { executionReceipt, readTaskExecution, reserveTaskExecution, taskBinding, withTaskExecutionLock,
  writeTaskExecution, type TaskExecutionRecord } from './task-execution-store';
import { prepareTaskExecutionWorkspace, verifyTaskSource } from './task-execution-workspace';

function promptFor(draft: TaskDraftRecord): string {
  return [draft.contract.objective, 'Read-only task. Report evidence to stdout; never modify files or contact o8 APIs.',
    `Requested file scope: ${draft.contract.allowedFiles.join(', ')}`,
    `Acceptance evidence: ${draft.contract.evidence.join('\n')}`,
    `Sealed task contract: ${JSON.stringify(draft.contract.sealedTaskContract)}`].join('\n\n');
}
async function fail(draft: TaskDraftRecord): Promise<void> {
  await withTaskExecutionLock(draft.taskId, async () => {
    const record = readTaskExecution(draft);
    if (record && !record.stopRequestedAt && !['completed', 'stopped'].includes(record.state)) {
      writeTaskExecution({ ...record, state: record.runId ? 'uncertain' : 'blocked', errorCode: 'launch_held' });
    }
  });
}
async function launch(draft: TaskDraftRecord, record: TaskExecutionRecord): Promise<void> {
  try {
    await prepareTaskExecutionWorkspace(draft, record);
    const lane = createLane({ repoPath: draft.snapshot.repoPath, projectId: draft.contract.projectId,
      worktreePath: record.workspacePath, runtime: record.runtime, branch: '', baseBranch: draft.snapshot.revision,
      label: `Controlled task ${draft.taskId}`, ownership: 'managed', actor: 'user' });
    await withTaskExecutionLock(draft.taskId, async () => {
      const current = readTaskExecution(draft)!;
      if (current.state !== 'accepted' || current.laneId) throw new TaskDraftError('execution_already_reserved', 409);
      writeTaskExecution({ ...current, laneId: lane.id });
    });
    const result = await launchRuntimeSurface({ runtime: record.runtime, model: record.model, effort: record.effort,
      ...(record.runtime === 'claude-code' ? { claudeCodeModel: record.model, claudeCodeCarrier: 'native' } : {}),
      executionPolicy: 'single-attempt', controlledTask: taskBinding(record), clientMutationId: record.attemptId,
      cwd: record.workspacePath, repoPath: record.workspacePath, projectRepoPath: draft.snapshot.repoPath,
      existingLaneId: lane.id, isolate: false, skipSetup: true, workMode: 'read-only',
      taskName: `Controlled task ${draft.taskId}`, prompt: promptFor(draft) });
    if (!result.ok) await fail(draft);
  } catch { await fail(draft); }
}

/** Stop is a local safety decision: no current launch entitlement or old sign-in epoch is required. */
async function stop(taskId: string, hash: string) {
  return withAccountStateAdmission(async () => {
    const draft = findTaskDraft(taskId, readActiveIdentity() ?? undefined);
    if (draft.contractHash !== hash) throw new TaskDraftError('contract_conflict', 409);
    const target = await withTaskExecutionLock(taskId, async () => {
      const record = readTaskExecution(draft);
      if (!record) throw new TaskDraftError('execution_unavailable', 409);
      const stopped = { ...record, state: 'stop_requested' as const,
        stopRequestedAt: record.stopRequestedAt ?? new Date().toISOString() };
      writeTaskExecution(stopped); // Publication/sync uncertainty forbids subsequent signals.
      if (stopped.runId) revokeReadOnlyWorkerToken(stopped.runId);
      if (stopped.runId) readExecutionSession(stopped);
      return stopped;
    });
    if (target.surfaceId && target.runId) await escalateInterruptOwnedSurface(target.surfaceId);
    return withTaskExecutionLock(taskId, async () => {
      const latest = await reconcileTaskExecution(readTaskExecution(draft)!);
      writeTaskExecution(latest);
      return executionReceipt(latest, true);
    });
  });
}

export async function controlTaskExecution(input: unknown) {
  const args = object(input);
  exactKeys(args, ['action', 'taskId', 'contractHash']);
  if (!['launch', 'inspect', 'stop'].includes(String(args.action))) throw new TaskDraftError('invalid_action');
  const taskId = normalizedText(args.taskId, 36);
  const hash = normalizedText(args.contractHash, 64);
  if (args.action === 'stop') return stop(taskId, hash);
  let draft!: TaskDraftRecord;
  const admitted = await withTaskDraftAccountAdmission(operatorAccount(), undefined, async (account) => {
    draft = findTaskDraft(taskId, account.accountId);
    if (hash !== draft.contractHash) throw new TaskDraftError('contract_conflict', 409);
    return withTaskDraftAccountAdmission(operatorAccount(), draft.account, async () => {
      const previous = readTaskExecution(draft);
      if (args.action === 'launch') {
        if (!previous) await verifyTaskSource(draft);
        return reserveTaskExecution(draft);
      }
      if (!previous) throw new TaskDraftError('execution_unavailable', 409);
      return { record: previous, created: false };
    });
  });
  if (admitted.created) await launch(draft, admitted.record);
  const latest = await withTaskDraftAccountAdmission(operatorAccount(), draft.account,
    () => withTaskExecutionLock(taskId, async () => {
      const record = await reconcileTaskExecution(readTaskExecution(draft)!);
      writeTaskExecution(record);
      return record;
    }));
  return executionReceipt(latest, !admitted.created);
}
