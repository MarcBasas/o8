import { constants as bufferConstants } from 'node:buffer';
import { getHeapStatistics } from 'node:v8';
import { nextInlineIssueNumbers } from './shared';
import type { LoadedIssue } from './types';

const TITLE_MAX = 72;

function deriveTitle(task: string): string {
  const firstLine = task.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function resolveSpawnCount(count: unknown): number {
  if (count === undefined) return 1;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('count must be a positive safe integer.');
  }
  return count;
}

/**
 * This endpoint materializes the entire batch in arrays and serialized mission
 * snapshots. Reject a request that cannot fit before allocating any issues.
 * Budget two bytes per JSON character, 4 KiB of packet metadata/object overhead,
 * and eight live copies for creation, dispatch, and persistence. These are
 * conservative allocation estimates, not a worker concurrency or fleet cap.
 */
export function assertSpawnBatchMaterializable(task: string, count: number, constraints = ''): void {
  const bytesPerPacket = JSON.stringify({ task, constraints }).length * 2 + 4096;
  const snapshotBytes = bytesPerPacket * count;
  if (count > 0xffff_ffff
    || snapshotBytes > bufferConstants.MAX_STRING_LENGTH * 2
    || snapshotBytes * 8 > getHeapStatistics().total_available_size) {
    throw new Error('Spawn batch exceeds this process\'s array, serialization, or available heap capacity. Submit smaller batches; no tasks were created.');
  }
}

/**
 * Turn a free-form task into inline LoadedIssues for a gateless worktree spawn —
 * the seam voice ("spawn two agents on the auth refactor") and the canvas
 * `spawn-agents` verb both hit. Synthetic numbers start at 90001 with no URL, so
 * `isInlineIssue` treats them as ad-hoc tasks (inline/{slug} branches).
 *
 * For count > 1 the agents race the SAME task in independent worktrees; titles
 * carry an `(i/N)` suffix so the per-agent branch slugs (and card labels) stay
 * unique — they feed the mission branch target's `inline/{number}-{slug}` prefix.
 */
export function buildInlineIssuesFromPrompt(task: string, count = 1): LoadedIssue[] {
  const body = task.trim();
  if (!body) {
    throw new Error('task is required.');
  }
  const baseTitle = deriveTitle(body) || 'Inline task';
  const n = resolveSpawnCount(count);
  assertSpawnBatchMaterializable(body, n);

  const numbers = nextInlineIssueNumbers(n);
  return Array.from({ length: n }, (_unused, index) => ({
    number: numbers[index]!,
    title: n === 1 ? baseTitle : `${baseTitle} (${index + 1}/${n})`,
    body,
    url: '',
  }));
}
