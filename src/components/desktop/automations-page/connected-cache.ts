export interface ConnectedJob {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: { kind: 'cron' | 'every' | 'at' | 'unknown'; expr: string | null; tz: string | null; everyMs: number | null; at: string | null };
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  lastDeliveryStatus: string | null;
}

export interface ConnectedResponse {
  ok: boolean;
  available?: boolean;
  installed?: boolean;
  jobs?: ConnectedJob[];
  job?: ConnectedJob;
  error?: string;
}

const FRESH_MS = 15_000;
// Reopen instantly after a slow CLI read, then revalidate on mount.
const VISIBLE_STALE_MS = 5 * 60_000;
interface CacheState {
  snapshot: { value: ConnectedResponse; at: number } | null;
  inFlight: Promise<ConnectedResponse> | null;
  generation: number;
}

const fallbackState: CacheState = { snapshot: null, inFlight: null, generation: 0 };

function cacheState(): CacheState {
  if (typeof window === 'undefined') return fallbackState;
  // The dashboard prewarm and lazy page may load in separate hot-reload chunks.
  const host = window as Window & { __o8ConnectedAutomationsCache?: CacheState };
  return host.__o8ConnectedAutomationsCache ??= { snapshot: null, inFlight: null, generation: 0 };
}

export function readConnectedAutomationsSnapshot(): ConnectedResponse | null {
  const { snapshot } = cacheState();
  return snapshot && Date.now() - snapshot.at < VISIBLE_STALE_MS ? snapshot.value : null;
}

export async function loadConnectedAutomations(force = false): Promise<ConnectedResponse> {
  const state = cacheState();
  if (!force && state.snapshot && Date.now() - state.snapshot.at < FRESH_MS) return state.snapshot.value;
  if (state.inFlight) return state.inFlight;
  const requestGeneration = state.generation;
  const request = (async () => {
    const response = await fetch('/api/automations/connected', { cache: 'no-store' });
    const result = await response.json() as ConnectedResponse;
    if (!response.ok || !result.ok) throw new Error(result.error ?? 'Connected agent scheduler unavailable.');
    if (requestGeneration === state.generation) state.snapshot = { value: result, at: Date.now() };
    return result;
  })();
  state.inFlight = request;
  try {
    return await request;
  } finally {
    if (state.inFlight === request) state.inFlight = null;
  }
}

export function invalidateConnectedAutomations(): void {
  const state = cacheState();
  state.generation += 1;
  state.snapshot = null;
  state.inFlight = null;
}

export function prefetchConnectedAutomations(): void {
  void loadConnectedAutomations().catch(() => undefined);
}
