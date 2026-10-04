import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NextRequest } from './fixtures/next-server.mjs';

export const root = dirname(fileURLToPath(import.meta.url));
export const cache = join(root, 'node_modules', '.cache', 'intent-continuity-demo');
const config = JSON.parse(await readFile(join(cache, 'config.json'), 'utf8'));
process.env.O8_AODL_PYTHON = config.python;
process.env.O8_AODL_SOURCE_DIR = config.sourceDir;
process.env.O8_AODL_VALIDATOR_REVISION = config.validatorRevision;
process.env.INTENT_DEMO_DATA_DIR = join(cache, 'private-demo-data');
const { POST, GET } = await import(pathToFileURL(join(cache, 'route.mjs')).href);
const { validateAodlIntent } = await import(pathToFileURL(join(cache, 'aodl-validation.mjs')).href);

export function document(id, revision = 0, changed = false) {
  const goal = changed ? 'Make checkout respond in 120 ms. Keep the layout. Do not deploy.'
    : 'Make checkout respond in 150 ms. Keep the layout. Do not deploy.';
  return JSON.stringify({
    specVersion: '0.2', graphId: id, revision,
    intentGraph: { nodes: [{ id: 'checkout', kind: 'task', ports: [], capabilities: ['read', 'execute'] }], edges: [] },
    policies: { kinds: [] },
    constraints: { budgets: { tokens: 10000 }, termination: { on: 'verified' }, goal },
    provenance: { sourceHash: createHash('sha256').update(goal).digest('hex') },
  });
}

export async function postDocument(raw, role = 'operator') {
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/intent-contract', {
    method: 'POST', body: raw,
    headers: { 'x-demo-fixture-auth': 'operator', 'x-demo-fixture-role': role },
  }));
  return { status: response.status, ...(await response.json()) };
}

export async function readDocument(id, revision) {
  const response = await GET(new NextRequest('http://localhost/api/orchestrator/intent-contract?id='
    + encodeURIComponent(id) + '&revision=' + revision, {
    headers: { 'x-demo-fixture-auth': 'operator', 'x-demo-fixture-role': 'operator' },
  }));
  return { status: response.status, ...(await response.json()) };
}

export async function action(name, id) {
  if (!/^demo-[a-f0-9-]{1,64}$/.test(id)) throw new Error('Invalid synthetic fixture identity');
  if (name === 'check') {
    return { status: 200, ok: true, validated: await validateAodlIntent(document(id)) };
  }
  if (name === 'save' || name === 'replay') return postDocument(document(id));
  if (name === 'overwrite') return postDocument(document(id, 0, true));
  if (name === 'new-version') return postDocument(document(id, 1, true));
  if (name === 'read-original') return readDocument(id, 0);
  if (name === 'worker') return postDocument(document(id), 'worker');
  if (name === 'mix-plan') return postDocument(JSON.stringify({ ...JSON.parse(document(id)), plan: {} }));
  if (name === 'invalid') {
    const value = JSON.parse(document(id));
    value.intentGraph.nodes[0] = { id: 'reviewer', kind: 'verifier', ports: [], capabilities: ['merge'], authorityCeiling: ['merge'] };
    return postDocument(JSON.stringify(value));
  }
  throw new Error('Unknown demo action');
}
