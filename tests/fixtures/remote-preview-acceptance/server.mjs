import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Remote preview acceptance</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#13151c;color:#f1f2f6;padding:40px}main{max-width:680px;margin:40px auto}h1{font-size:28px}p{line-height:1.6;color:#c2c7d2}button{font:inherit;padding:12px 20px;border-radius:8px;border:1px solid #8792a4;background:#222b3a;color:white}pre{white-space:pre-wrap;padding:20px;background:#20232e;border-radius:8px}</style>
</head><body><main><h1>Remote preview acceptance</h1><p>This page is served by the scoped Linux task service.</p><button id="increment">Count: 0</button><pre id="receipt">Loading worker receipt...</pre></main><script src="/fixture.js"></script></body></html>`;
const javascript = `let count=0;document.getElementById('increment').onclick=()=>{document.getElementById('increment').textContent='Count: '+(++count)};fetch('/receipt').then(r=>r.json()).then(r=>{document.getElementById('receipt').textContent=JSON.stringify(r,null,2)});`;
const server = createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200); response.end('healthy'); return; }
  if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(javascript); return; }
  if (request.url === '/receipt') {
    let receipt = { state: 'service ready; waiting for worker receipt' };
    try { receipt = JSON.parse(readFileSync('tests/fixtures/remote-preview-acceptance/receipt.json', 'utf8')); } catch {}
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(receipt)); return;
  }
  if (request.url !== '/') { response.writeHead(404); response.end('not found'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
});
server.listen(Number(process.env.PORT), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
