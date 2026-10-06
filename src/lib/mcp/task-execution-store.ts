import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { withAccountStateAdmission } from '@/lib/auth/account-state';
import { canonical, TaskDraftError } from './task-draft-contract';
import { atomicWriteTaskState, syncTaskDirectories, taskDraftRoot, type TaskDraftRecord } from './task-draft-store';

export interface ControlledTaskBinding { taskId: string; attemptId: string; contractHash: string }
export interface TaskExecutionRecord extends ControlledTaskBinding {
  version: 1;
  account: TaskDraftRecord['account'];
  runtime: TaskDraftRecord['contract']['runtime'];
  model: string;
  effort: TaskDraftRecord['contract']['effort'];
  createdAt: string;
  state: 'accepted' | 'spawn_reserved' | 'running' | 'uncertain' | 'blocked' | 'stop_requested' | 'stopped' | 'completed';
  workspacePath: string;
  surfaceId?: string;
  laneId?: string;
  runId?: string;
  stopRequestedAt?: string;
  reviewRequired: true;
  errorCode?: string;
}

function directory(name: string): string {
  const path = join(taskDraftRoot(), name);
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (created) syncTaskDirectories(path);
  return path;
}
function file(taskId: string): string { return join(directory('executions'), `${taskId}.json`); }
function reservation(taskId: string): string { return join(directory('execution-reservations'), taskId); }
export function executionWorkspace(attemptId: string): string { return join(realpathSync(directory('workspaces')), attemptId); }
export function taskBinding(value: ControlledTaskBinding): ControlledTaskBinding {
  return { taskId: value.taskId, attemptId: value.attemptId, contractHash: value.contractHash };
}

export function readTaskExecution(draft: TaskDraftRecord): TaskExecutionRecord | null {
  if (!existsSync(file(draft.taskId))) {
    if (existsSync(reservation(draft.taskId))) throw new TaskDraftError('execution_uncertain', 409);
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(file(draft.taskId), 'utf8')) as TaskExecutionRecord;
    if (!existsSync(reservation(draft.taskId)) || value.version !== 1 || value.reviewRequired !== true
      || value.taskId !== draft.taskId || value.contractHash !== draft.contractHash
      || canonical(value.account) !== canonical(draft.account) || value.runtime !== draft.contract.runtime
      || value.model !== draft.contract.model || value.effort !== draft.contract.effort
      || !/^[a-f0-9-]{36}$/.test(value.attemptId) || value.workspacePath !== executionWorkspace(value.attemptId)
      || !['accepted', 'spawn_reserved', 'running', 'uncertain', 'blocked', 'stop_requested', 'stopped', 'completed'].includes(value.state)
      || (value.surfaceId && (!value.surfaceId.startsWith(`${value.runtime}-owned:`) || /[/\\]/.test(value.surfaceId)))) {
      throw new Error('Invalid execution binding');
    }
    return value;
  } catch { throw new TaskDraftError('execution_uncertain', 409); }
}
export function writeTaskExecution(value: TaskExecutionRecord): void { atomicWriteTaskState(file(value.taskId), value); }
export function withTaskExecutionLock<T>(_taskId: string, action: () => Promise<T>): Promise<T> {
  // Reuse the installation lease's dead/inactive exact-reservation recovery and
  // asynchronous release. Controlled task writes and account changes serialize.
  return withAccountStateAdmission(action);
}

/** The reservation is permanent, including a crash before its receipt is published. */
export async function reserveTaskExecution(draft: TaskDraftRecord): Promise<{ record: TaskExecutionRecord; created: boolean }> {
  const previous = readTaskExecution(draft);
  if (previous) return { record: previous, created: false };
  return withTaskExecutionLock(draft.taskId, async () => {
    const repeated = readTaskExecution(draft);
    if (repeated) return { record: repeated, created: false };
    try {
      mkdirSync(reservation(draft.taskId), { mode: 0o700 });
      const fd = openSync(directory('execution-reservations'), 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch { throw new TaskDraftError('execution_uncertain', 409); }
    const attemptId = randomUUID();
    const record: TaskExecutionRecord = { version: 1, taskId: draft.taskId, attemptId,
      contractHash: draft.contractHash, account: { ...draft.account }, runtime: draft.contract.runtime,
      model: draft.contract.model, effort: draft.contract.effort, createdAt: new Date().toISOString(),
      state: 'accepted', workspacePath: executionWorkspace(attemptId), reviewRequired: true };
    writeTaskExecution(record);
    return { record, created: true };
  });
}

export function executionReceipt(record: TaskExecutionRecord, replayed: boolean) {
  return { taskId: record.taskId, attemptId: record.attemptId, contractHash: record.contractHash,
    state: record.state, runtime: record.runtime, model: record.model, effort: record.effort,
    surfaceId: record.surfaceId ?? null, replayed, reviewRequired: true, retryAllowed: false,
    completed: record.state === 'completed', stopped: record.state === 'stopped', errorCode: record.errorCode ?? null };
}
