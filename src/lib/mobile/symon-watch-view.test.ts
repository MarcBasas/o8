import { describe, expect, it } from 'vitest';
import type { SymonWatchRecord } from '@/lib/automations/symon-watch';
import { mobileSymonWatch } from './symon-watch-view';

function watch(overrides: Partial<SymonWatchRecord> = {}): SymonWatchRecord {
  return {
    id: 'watch-1',
    condition: 'The release lane is ready',
    then: 'plan',
    say: 'Approve the release lane.',
    steps: ['o8_approve_item', 'o8_dispatch'],
    sessionId: 'symon-session-1',
    sourceKind: 'packet',
    sourceId: 'packet-1',
    eventTypes: ['review_requested'],
    repoPath: '/repo/o8',
    deadline: null,
    parkedAt: null,
    announcedAt: null,
    state: 'watching',
    lastFireAt: null,
    lastErrorMessage: null,
    fuzzyCondition: null,
    evaluation: null,
    lastLedgerEvent: null,
    ...overrides,
  };
}

describe('mobileSymonWatch', () => {
  it('uses the confirm-card phrases for saved plan steps', () => {
    expect(mobileSymonWatch(watch()).summary).toBe(
      'Approve the release lane. Then: approve the item, dispatch a worker.',
    );
  });

  it('keeps an unknown saved tool visible with a spaced fallback', () => {
    expect(mobileSymonWatch(watch({ steps: ['future_tool_call'] })).summary).toBe(
      'Approve the release lane. Then: future tool call.',
    );
    expect(mobileSymonWatch(watch({ steps: ['constructor'] })).summary).toBe(
      'Approve the release lane. Then: constructor.',
    );
  });
});
