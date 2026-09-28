// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationsPage } from './AutomationsPage';

afterEach(() => {
  delete (window as Window & { __o8ConnectedAutomationsCache?: unknown }).__o8ConnectedAutomationsCache;
  vi.unstubAllGlobals();
});

it('shows connected schedules without empty Mine or placeholder Team tabs', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/automations') return Response.json({ automations: [] });
    if (url === '/api/panel/repos') return Response.json({ repos: [] });
    if (url === '/api/automations/connected') return Response.json({ ok: true, available: true, jobs: [{
      id: 'job-1', name: 'Daily planning check-in', agentId: 'agent', enabled: true,
      schedule: { kind: 'every', expr: null, tz: null, everyMs: 3_600_000, at: null },
      nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastDeliveryStatus: null,
    }] });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AutomationsPage, { currentOwner: 'operator' })));
    await vi.waitFor(() => expect(host.textContent).toContain('Daily planning check-in'));
    expect(host.textContent).toContain('1 active');
    expect(host.textContent).not.toContain('Mine');
    expect(host.textContent).not.toContain('Team');
    expect(host.textContent).not.toContain('Let agents handle the repeat work');
    const scroller = host.querySelector<HTMLElement>('div[style*="overflow-y: auto"]');
    expect(scroller?.style.scrollbarWidth).toBe('none');
    expect(scroller?.style.overflowY).toBe('auto');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
