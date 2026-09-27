import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('connected automation prewarm', () => {
  it('deduplicates the warm read and reuses fresh schedules for instant entry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, installed: true, jobs: [{ id: 'daily', enabled: true }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const cache = await import('./connected-cache');
    const [first, second] = await Promise.all([cache.loadConnectedAutomations(), cache.loadConnectedAutomations()]);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.readConnectedAutomationsSnapshot()?.jobs?.[0]?.id).toBe('daily');
    await cache.loadConnectedAutomations();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await cache.loadConnectedAutomations(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates after a mutation so an old in-flight read cannot recache stale jobs', async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, jobs: [{ id: 'new' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const cache = await import('./connected-cache');
    const old = cache.loadConnectedAutomations();
    cache.invalidateConnectedAutomations();
    await cache.loadConnectedAutomations(true);
    resolveOld?.(new Response(JSON.stringify({ ok: true, jobs: [{ id: 'old' }] }), { status: 200 }));
    await old;
    expect(cache.readConnectedAutomationsSnapshot()?.jobs?.[0]?.id).toBe('new');
  });
});
