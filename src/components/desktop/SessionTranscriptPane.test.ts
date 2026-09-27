// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { FleetAgent } from './thoughts/types';
import { SessionTranscriptPane } from './SessionTranscriptPane';

vi.mock('./orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('./workspace-terminal/AgentTilePane', () => ({
  AgentTilePane: ({ agent }: { agent: FleetAgent | null }) => createElement('output', null, agent?.status ?? 'unknown'),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('refreshes mounted owned-worker runtime evidence on lifecycle changes and stops after unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let status = 'running';
  const fetchSummary = vi.fn(async () => new Response(JSON.stringify({
    session: { sessionKey: 'codex-owned:worker-proof', status },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchSummary);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SessionTranscriptPane, { sessionKey: 'codex-owned:worker-proof' })));
    expect(host.textContent).toBe('running');
    for (const next of ['completed', 'failed', 'interrupted', 'idle']) {
      status = next;
      await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
      expect(host.textContent).toBe(next);
    }
    await act(async () => root.unmount());
    const calls = fetchSummary.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
    expect(fetchSummary).toHaveBeenCalledTimes(calls);
  } finally {
    if (host.childNodes.length) await act(async () => root.unmount());
    host.remove();
  }
});
