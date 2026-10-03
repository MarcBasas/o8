import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
const directory = mkdtempSync(join(tmpdir(), 'o8-composer-operator-'));
const token = 'fixture-operator-credential-0123456789';
const worker = 'fixture-worker-credential-0123456789';
writeFileSync(join(directory, 'ws-token'), token);
writeFileSync(join(directory, 'worker-token'), worker);
const socketPath = join(directory, 'app.sock');
writeFileSync(`${socketPath}.token`, 'fixture-native-auth');
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
vi.stubEnv('TAURI_MCP_AUTH_TOKEN', 'fixture-native-auth');
const { panelGateMiddleware } = await import('@/middleware');
const { POST } = await import('@/app/api/mcp/route');
const { closeDb } = await import('@/lib/db');
const sockets = new Set<Socket>();
let mutations = 0;
let drop = false;
const requestId = 'fixture-request-0001';
const bridge = {
  inspect: () => ({ status: 'ready', composer_id: 'fixture-composer' }),
  attach: (args: Record<string, unknown>) => { mutations++; return { status: 'pending', request_id: args.request_id, composer_id: args.composer_id }; },
  status: (id: string) => ({ status: 'completed', request_id: id, composer_id: 'fixture-composer' }),
};
const server = createServer(socket => {
  sockets.add(socket);
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      expect(request.authToken).toBe('fixture-native-auth');
      expect(request.command).toBe('execute_js');
      expect(request.payload.window_label).toBe('main');
      const result = runInNewContext(request.payload.code, { window: { __o8ComposerImages__: bridge } });
      if (drop) { socket.destroy(); return; }
      socket.write(JSON.stringify({ id: request.id, success: true, data: { result } }) + '\n');
    }
  });
});
beforeAll(async () => { await new Promise<void>(resolve => server.listen(socketPath, resolve)); });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
async function rpc(method: string, params?: Record<string, unknown>, bearer = token) {
  const request = new NextRequest('http://127.0.0.1/api/mcp', {
    method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
  });
  const gate = panelGateMiddleware(request);
  if (gate.status !== 200) return { denied: gate.status };
  const response = await POST(request);
  return response.json();
}
const args = () => ({
  composer_id: 'fixture-composer', request_id: crypto.randomUUID(), filename: 'fixture.png', media_type: 'image/png',
  data_base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64'),
});
describe('operator HTTP catalog/auth -> actual client authenticated socket image calls', () => {
  it('refuses anonymous and worker principals before host/client mutation', async () => {
    for (const bearer of ['', worker, 'invalid-credential']) {
      expect(await rpc('tools/call', { name: 'o8_view_attach_image', arguments: args() }, bearer)).toHaveProperty('denied');
    }
    expect(mutations).toBe(0);
  });
  it('discovers the operator tool and round-trips correlated receipts through the public entry', async () => {
    const list = await rpc('tools/list');
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('o8_view_attach_image');
    const inspection = await rpc('tools/call', { name: 'o8_view_inspect_composer', arguments: {} });
    expect(JSON.parse(inspection.result.content[0].text).composer_id).toBe('fixture-composer');
    const payload = args();
    const attached = await rpc('tools/call', { name: 'o8_view_attach_image', arguments: payload });
    expect(JSON.parse(attached.result.content[0].text)).toMatchObject({ status: 'pending', request_id: payload.request_id });
    const status = await rpc('tools/call', { name: 'o8_view_image_attachment_status', arguments: { request_id: payload.request_id } });
    expect(JSON.parse(status.result.content[0].text)).toMatchObject({ status: 'completed', request_id: payload.request_id });
  });
  it('never replays an attachment after an authenticated write loses its response', async () => {
    const before = mutations; drop = true;
    const payload = args();
    const result = await rpc('tools/call', { name: 'o8_view_attach_image', arguments: payload });
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ code: 'outcome_unknown', request_id: payload.request_id, composer_id: payload.composer_id });
    expect(result.result.isError).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mutations).toBe(before + 1);
  });
});
