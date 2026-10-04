import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { action, readDocument, root } from './lab.mjs';
import { makeServer } from './server.mjs';

if (process.argv[2] === 'read') {
  console.log(JSON.stringify(await readDocument(process.argv[3], 0)));
  process.exit(0);
}
const id = 'demo-' + randomUUID();
const checks = [];
function check(name, pass) {
  assert.equal(pass, true, name);
  checks.push({ name, pass });
}
const invalid = await action('invalid', id);
check('Actual Python checker rejects a reviewer with merge capability',
  invalid.status === 400 && invalid.error === 'aodl_rejected');
const first = await action('save', id);
check('Actual route accepts and stores version 0', first.status === 200 && first.record.ref.revision === 0);
const replay = await action('replay', id);
check('Identical retry returns original record', replay.status === 200 && replay.record.createdAt === first.record.createdAt);
const conflict = await action('overwrite', id);
check('Changed instructions cannot overwrite version 0', conflict.status === 409 && conflict.error === 'intent_revision_conflict');
const second = await action('new-version', id);
check('Version 1 stores changed instructions', second.status === 200 && second.record.ref.revision === 1);
const original = await action('read-original', id);
check('Original version remains unchanged', original.status === 200 && original.record.document === first.record.document);
const worker = await action('worker', id);
check('Route refuses the fixture worker principal', worker.status === 403);
const mixed = await action('mix-plan', id);
check('Route refuses a runtime plan in authored instructions', mixed.status === 400 && mixed.error === 'runtime_projection_not_authored_intent');
const child = spawnSync(process.execPath, [join(root, 'verify.mjs'), 'read', id], { cwd: root, encoding: 'utf8', timeout: 10000 });
assert.equal(child.status, 0, child.stderr);
const restarted = JSON.parse(child.stdout);
check('New process reads the persisted original', restarted.status === 200 && restarted.record.document === first.record.document);
check('Stored instruction version has an AODL fingerprint', /^aodl-canon-1:[a-f0-9]{64}$/.test(first.record.ref.semanticFingerprint));
const server = makeServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
try {
  const page = await fetch(url);
  check('HTTP entry serves the interactive screens', page.status === 200 && (await page.text()).includes('experiment-panel'));
  const saved = await fetch(url + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ name: 'save', id: 'demo-' + randomUUID() }) });
  check('Browser action reaches the real storage route', saved.status === 200 && (await saved.json()).record.ref.revision === 0);
  const denied = await fetch(url + '/action', { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
  check('HTTP entry refuses a foreign origin', denied.status === 403);
  const unknown = await fetch(url + '/sources.json');
  check('HTTP entry serves only declared files', unknown.status === 404);
  const oversized = await fetch(url + '/action', { method: 'POST', body: 'x'.repeat(513) });
  check('HTTP entry refuses oversized fixture requests', oversized.status === 413);
} finally {
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
}
const result = {
  createdAt: new Date().toISOString(), passed: checks.length, total: checks.length, checks,
  fixtureBoundaries: ['Next request/response', 'Authentication and operator principal', 'Private data directory', 'Synthetic task'],
  notProven: ['Real bearer authentication', 'Installed app integration', 'Mission dispatch or real harness handoff', 'Power-loss durability'],
};
await mkdir(join(root, 'receipts'), { recursive: true });
await writeFile(join(root, 'receipts', 'local-code.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
