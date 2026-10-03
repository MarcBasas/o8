import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

const directory = mkdtempSync(join(tmpdir(), 'o8-input-socket-'));
const socketPath = join(directory, 'app.sock');
writeFileSync(`${socketPath}.token`, 'fixture-native-auth');
vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
vi.stubEnv('TAURI_MCP_AUTH_TOKEN', 'fixture-native-auth');
const sockets = new Set<Socket>();
const clients: O8WebviewClient[] = [];
let mode: 'success' | 'timeout' | 'landed' | 'drop' | 'hold' = 'success';
let writes: Record<string, unknown>[] = [];
let held: (() => void) | undefined;
const server = createServer(socket => {
  sockets.add(socket);
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      expect(request.authToken).toBe('fixture-native-auth'); expect(request.payload.window_label).toBe('main');
      const respond = (success: boolean, data?: unknown, error?: string) => socket.write(JSON.stringify({ id: request.id, success, data, error }) + '\n');
      if (request.command === 'type_into_focused') {
        writes.push(request.payload);
        if (mode === 'drop') { socket.destroy(); continue; }
        if (mode === 'timeout' || mode === 'landed') { respond(false, undefined, 'eval_and_await failed for type_into_focused: timed out after 10 seconds'); continue; }
        if (mode === 'hold' && writes.length === 1) { held = () => respond(true, { charsTyped: String(request.payload.text).length }); continue; }
        respond(true, { charsTyped: String(request.payload.text).length });
      } else {
        expect(request.command).toBe('execute_js');
        const readback = String(request.payload.code).includes('value.endsWith(');
        respond(true, { result: readback ? mode === 'landed' ? 'true' : 'false' : JSON.stringify({ ok: true }) });
      }
    }
  });
});
beforeAll(async () => { await new Promise<void>(resolve => server.listen(socketPath, resolve)); });
beforeEach(() => { mode = 'success'; writes = []; held = undefined; });
afterAll(async () => {
  for (const client of clients) client.dispose(); for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
function tool() {
  const client = new O8WebviewClient(); clients.push(client); return createO8WebviewToolHandlers(() => client).o8_view_type;
}
function result(response: Awaited<ReturnType<ReturnType<typeof tool>>>) {
  const content = response.content[0]; if (content.type !== 'text') throw new Error('Expected text result'); return content.text;
}
describe('registered view typing -> authenticated actual client socket', () => {
  it('requests the unpaced native mode through the registered tool', async () => {
    const response = await tool()({ text: 'append\nline' });
    expect(response.isError).not.toBe(true); expect(JSON.parse(result(response))).toMatchObject({ ok: true });
    expect(writes).toEqual([{ window_label: 'main', text: 'append\nline', delay_ms: 0 }]);
  });
  it.each(['timeout', 'drop'] as const)('never replays an uncertain %s write', async kind => {
    mode = kind; const response = await tool()({ text: 'unsent-marker' });
    expect(response.isError).toBe(true); expect(writes).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 25)); expect(writes).toHaveLength(1);
  });
  it('retains readback reconciliation after acknowledgement timeout without repeating the write', async () => {
    mode = 'landed'; const response = await tool()({ text: 'unsent-marker' });
    expect(JSON.parse(result(response))).toMatchObject({ ok: true, warning: expect.any(String) }); expect(writes).toHaveLength(1);
  });
  it('keeps concurrent typing serialized until the first acknowledgement', async () => {
    mode = 'hold'; const type = tool(); const first = type({ text: 'first' }); const second = type({ text: 'second' });
    await vi.waitFor(() => expect(held).toBeTypeOf('function'));
    expect(writes.map(write => write.text)).toEqual(['first']); held!();
    await Promise.all([first, second]); expect(writes.map(write => write.text)).toEqual(['first', 'second']);
  });
});
