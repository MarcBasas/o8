import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));
export const cache = join(root, 'node_modules', '.cache', 'intent-continuity-demo');
const source = join(cache, 'source');
const aliases = {
  'next/server': join(root, 'fixtures', 'next-server.mjs'),
  '@/lib/panel/auth': join(root, 'fixtures', 'auth.mjs'),
  '@/lib/auth/principal': join(root, 'fixtures', 'principal.mjs'),
  '@/lib/data-dir-migration': join(root, 'fixtures', 'data-dir.mjs'),
  '@/lib/orchestrator/aodl-validation': join(source, 'aodl-validation.ts'),
  '@/lib/orchestrator/intent-contract-store': join(source, 'intent-contract-store.ts'),
  '@/lib/mobile/ripple-contract': join(source, 'ripple-contract.ts'),
  '@/lib/models': join(root, 'fixtures', 'models.mjs'),
  '@/lib/format/relative-time': join(root, 'fixtures', 'relative-time.mjs'),
  'demo:mobile-ripple-overlay': join(source, 'mobile-ripple-overlay.tsx'),
  'demo:ripple-contract': join(source, 'ripple-contract.ts'),
};
const pinnedSources = {
  name: 'pinned-demo-sources',
  setup(builder) {
    builder.onResolve({ filter: /^(?:@\/|next\/server$|demo:)/ }, args =>
      aliases[args.path] ? { path: aliases[args.path] } : undefined);
  },
};
await mkdir(cache, { recursive: true });
await build({
  entryPoints: [join(source, 'route.ts')], outfile: join(cache, 'route.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', plugins: [pinnedSources],
});
await build({
  entryPoints: [join(source, 'aodl-validation.ts')], outfile: join(cache, 'aodl-validation.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
});
await build({
  entryPoints: [join(root, 'ripple-preview.jsx')], outfile: join(cache, 'ripple-preview.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [pinnedSources],
});
console.log('Built the unchanged pinned route and mobile component.');
