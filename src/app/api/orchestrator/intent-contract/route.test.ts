import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({
  directory: '', role: 'operator', authenticated: true, validate: vi.fn(),
}));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.directory }));
vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => state.authenticated ? null : NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipalContext: () => ({ role: state.role }) }));
vi.mock('@/lib/orchestrator/aodl-validation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/aodl-validation')>(),
  validateAodlIntent: state.validate,
}));

const { POST, GET } = await import('./route');
const { IntentContractError, intentInputHash, readAuthoredDocument } = await import('@/lib/orchestrator/aodl-validation');

function document(revision = 0, budget = 100) {
  return JSON.stringify({
    specVersion: '0.2', graphId: 'intent-example', revision,
    intentGraph: { nodes: [{ id: 'task', kind: 'task', ports: [], capabilities: ['read'] }], edges: [] },
    policies: { kinds: [] }, constraints: { budgets: { tokens: budget }, termination: { on: 'verified' } },
    provenance: { sourceHash: '0'.repeat(64) },
  });
}

function request(body: string) {
  return new NextRequest('http://localhost/api/orchestrator/intent-contract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
}
function query(revision = '0', id = 'intent-example') {
  return new NextRequest(`http://localhost/api/orchestrator/intent-contract?id=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision)}`);
}

beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'o8-intent-contract-'));
  state.role = 'operator'; state.authenticated = true;
  state.validate.mockReset();
  // The Python validator is a separate protocol boundary, not a mocked filesystem.
  state.validate.mockImplementation(async (raw: string) => {
    const doc = readAuthoredDocument(raw);
    return { document: raw, ref: {
      id: doc.graphId, revision: doc.revision, sourceHash: '0'.repeat(64),
      inputSha256: intentInputHash(raw), validatorRevision: 'a'.repeat(16),
      semanticFingerprint: `aodl-canon-1:${intentInputHash(raw)}`,
    } };
  });
});
afterEach(async () => { await rm(state.directory, { recursive: true, force: true }); });

describe('operator authored-intent persistence', () => {
  it('writes then reads the immutable record through the route', async () => {
    const result = await POST(request(document()));
    expect(result.status).toBe(200);
    const created = await result.json();
    expect(created.record.document).toBe(document());
    expect(await (await GET(query())).json()).toEqual(created);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
  });

  it('replays identical input without changing the recorded creation time', async () => {
    const first = await (await POST(request(document()))).json();
    const second = await (await POST(request(document()))).json();
    expect(second).toEqual(first);
  });

  it('rejects different content for the same revision without overwriting', async () => {
    await POST(request(document()));
    const result = await POST(request(document(0, 200)));
    expect(result.status).toBe(409);
    expect((await (await GET(query())).json()).record.document).toBe(document());
  });

  it('retains the old revision when the operator creates a new one', async () => {
    await POST(request(document()));
    await POST(request(document(1, 200)));
    expect((await (await GET(query())).json()).record.document).toBe(document());
    expect((await (await GET(query('1'))).json()).record.document).toBe(document(1, 200));
  });

  it('publishes one winner for concurrent conflicting submissions', async () => {
    const results = await Promise.all([POST(request(document())), POST(request(document(0, 200)))]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const key = createHash('sha256').update('intent-example').digest('hex');
    expect(await readdir(join(state.directory, 'intent-contracts', key))).toEqual(['0.json']);
  });

  it('serves persisted state after the route module is reloaded', async () => {
    const saved = await (await POST(request(document()))).json();
    vi.resetModules();
    const fresh = await import('./route');
    expect(await (await fresh.GET(query())).json()).toEqual(saved);
  });

  it.each(['worker', 'device', 'spectator'])('refuses the %s principal before validation', async (role) => {
    state.role = role;
    expect((await POST(request(document()))).status).toBe(403);
    expect((await GET(query())).status).toBe(403);
    expect(state.validate).not.toHaveBeenCalled();
    expect(await readdir(state.directory)).toEqual([]);
  });

  it('refuses unauthenticated access', async () => {
    state.authenticated = false;
    expect((await POST(request(document()))).status).toBe(401);
    expect(state.validate).not.toHaveBeenCalled();
  });

  it('rechecks the operator after validation before writing', async () => {
    const regular = state.validate.getMockImplementation()!;
    state.validate.mockImplementationOnce(async (raw: string) => {
      const value = await regular(raw);
      state.role = 'worker';
      return value;
    });
    expect((await POST(request(document()))).status).toBe(403);
    expect(await readdir(state.directory)).toEqual([]);
  });

  it.each([['aodl_rejected', 400], ['aodl_not_configured', 503]])('does not write after %s', async (code, status) => {
    state.validate.mockRejectedValueOnce(new IntentContractError(code as string, status as number));
    expect((await POST(request(document()))).status).toBe(status);
    expect(await readdir(state.directory)).toEqual([]);
  });

  it('refuses runtime projections at the authored-document boundary', async () => {
    const doc = JSON.parse(document()); doc.observedGraph = doc.intentGraph;
    expect((await POST(request(JSON.stringify(doc)))).status).toBe(400);
    expect(await readdir(state.directory)).toEqual([]);
  });

  it('bounds the actual request body, not the declared content length', async () => {
    const req = new NextRequest('http://localhost/api/orchestrator/intent-contract', {
      method: 'POST', headers: { 'Content-Length': '1' }, body: ' '.repeat(128 * 1024 + 1),
    });
    expect((await POST(req)).status).toBe(413);
    expect(state.validate).not.toHaveBeenCalled();
  });

  it('returns a truthful missing record and rejects malformed identifiers', async () => {
    expect((await GET(query())).status).toBe(404);
    for (const revision of ['', '-1', '01', '1.5', '9007199254740992']) {
      expect((await GET(query(revision))).status).toBe(400);
    }
    expect((await GET(query('0', '../other'))).status).toBe(400);
  });

  it('rejects damaged stored content instead of returning it as validated', async () => {
    await POST(request(document()));
    const key = createHash('sha256').update('intent-example').digest('hex');
    const path = join(state.directory, 'intent-contracts', key, '0.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.document = document(0, 200);
    await writeFile(path, JSON.stringify(record), 'utf8');
    expect((await GET(query())).status).toBe(500);
  });
});
