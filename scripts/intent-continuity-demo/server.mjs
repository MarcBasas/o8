import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { action, cache, root } from './lab.mjs';

const files = new Map([
  ['/', [join(root, 'index.html'), 'text/html; charset=utf-8']],
  ['/demo-ui.js', [join(root, 'demo-ui.js'), 'application/javascript']],
  ['/ripple-preview.js', [join(cache, 'ripple-preview.js'), 'application/javascript']],
]);
export function makeServer() {
  return createServer(async (request, response) => {
    const address = response.socket?.localPort;
    const expected = '127.0.0.1:' + address;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin' };
    function send(status, value, kind = 'application/json') {
      response.writeHead(status, { ...headers, 'Content-Type': kind });
      response.end(kind === 'application/json' ? JSON.stringify(value) : value);
    }
    if (request.headers.host !== expected
      || ![undefined, 'http://' + expected].includes(request.headers.origin)) {
      send(403, { error: 'loopback_origin_required' });
      return;
    }
    const pathname = new URL(request.url, 'http://' + expected).pathname;
    try {
      if (request.method === 'GET' && files.has(pathname)) {
        const [file, kind] = files.get(pathname);
        send(200, await readFile(file), kind);
        return;
      }
      if (request.method !== 'POST' || pathname !== '/action') {
        send(404, { error: 'not_found' });
        return;
      }
      let input = '';
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 512) {
          send(413, { error: 'demo_request_too_large' });
          return;
        }
        input += chunk.toString('utf8');
      }
      const value = JSON.parse(input);
      if (!value || typeof value.name !== 'string' || typeof value.id !== 'string') {
        send(400, { error: 'invalid_demo_request' });
        return;
      }
      send(200, await action(value.name, value.id));
    } catch {
      send(400, { error: 'invalid_demo_request' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = makeServer();
  server.requestTimeout = 10000;
  server.listen(0, '127.0.0.1', async () => {
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    await mkdir(join(root, 'receipts'), { recursive: true });
    await writeFile(join(root, 'receipts', 'server.json'),
      JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log('Open ' + url);
    console.log('Private synthetic demo. No model calls or task dispatch.');
  });
}
