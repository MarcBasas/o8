import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ repo: vi.fn(), head: vi.fn(), remote: 'https://github.com/example/repo.git', loseMaterializationReceipt: false }));
vi.mock('@/lib/repos/registry', async (original) => ({ ...await original<typeof import('@/lib/repos/registry')>(), findRepoByLocalPath: mocks.repo }));
vi.mock('@/lib/github-broker/actions', () => ({ getGitHubPullRequestHeadRef: mocks.head }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({ ...await original<typeof import('@/lib/worktree/storage-telemetry')>(), measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })) }));
// Only the GitHub origin identity is substituted. Fetch, materialization,
// admission and persisted ownership use real Git and the real manager.
vi.mock('@/lib/mcp/task-draft-git', async (original) => {
  const actual = await original<typeof import('@/lib/mcp/task-draft-git')>();
  return { ...actual, taskDraftGit: (repo: string, args: string[]) => args.join(' ') === 'remote get-url origin' ? Promise.resolve(mocks.remote) : actual.taskDraftGit(repo, args) };
});
// Fault injection loses only the process receipt after real Git has created
// the workspace; storage admission and durable ownership remain real.
vi.mock('@/lib/worktree/materialization-execution', async (original) => {
  const actual = await original<typeof import('@/lib/worktree/materialization-execution')>();
  return { ...actual, materializationAwareExecFile: async (...args: Parameters<typeof actual.materializationAwareExecFile>) => {
    const result = await actual.materializationAwareExecFile(...args);
    if (mocks.loseMaterializationReceipt && args[0] === 'git' && args[1].includes('worktree') && args[1].includes('add')) { mocks.loseMaterializationReceipt = false; throw new Error('Synthetic lost materialization receipt'); }
    return result;
  } };
});
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-pr-checkout-')));
const repoPath = path.join(root, 'repo'); const origin = path.join(root, 'origin.git'); const data = path.join(root, 'data');
mkdirSync(repoPath); mkdirSync(data);
process.env.O8_DATA_DIR = data; process.env.CORTEX_IDE_DATA_DIR = data; process.env.O8_WORKTREE_ROOT = path.join(root, 'workspaces');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(repoPath, 'init', '-q', '-b', 'main'); git(repoPath, 'config', 'user.name', 'o8 test'); git(repoPath, 'config', 'user.email', 'o8-test@example.test');
writeFileSync(path.join(repoPath, 'code.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-qm', 'base');
const base = git(repoPath, 'rev-parse', 'HEAD');
git(repoPath, 'checkout', '-qb', 'review-source'); writeFileSync(path.join(repoPath, 'code.txt'), 'reviewed\n');
// PR-controlled executables and source configuration must never run just
// because a reader creates a review workspace.
mkdirSync(path.join(repoPath, 'node_modules/typescript/bin'), { recursive: true });
writeFileSync(path.join(repoPath, 'tsconfig.json'), '{}');
writeFileSync(path.join(repoPath, 'node_modules/typescript/bin/tsc'), `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'typecheck-ran'))}, 'executed');`);
writeFileSync(path.join(repoPath, '.gitattributes'), '*.audit filter=review-audit\n'); writeFileSync(path.join(repoPath, 'change.audit'), 'review content\n');
git(repoPath, 'add', '-f', '.'); git(repoPath, 'commit', '-qm', 'reviewed'); const sha = git(repoPath, 'rev-parse', 'HEAD');
git(repoPath, 'clone', '--bare', '-q', repoPath, origin); git(origin, 'update-ref', 'refs/pull/7/head', sha); git(repoPath, 'remote', 'add', 'origin', origin); git(repoPath, 'checkout', '-q', 'main');
writeFileSync(path.join(repoPath, 'code.txt'), 'staged operator work\n'); git(repoPath, 'add', 'code.txt'); writeFileSync(path.join(repoPath, 'code.txt'), 'newer operator work\n'); writeFileSync(path.join(repoPath, 'draft.txt'), 'private draft\n');
const hooks = path.join(root, 'source-hooks'); mkdirSync(hooks);
for (const hook of ['post-checkout', 'reference-transaction']) { const script = path.join(hooks, hook); writeFileSync(script, `#!/bin/sh\nprintf executed > '${path.join(root, 'hook-ran')}'\n`); chmodSync(script, 0o700); }
git(repoPath, 'config', 'core.hooksPath', hooks);
git(repoPath, 'config', 'filter.review-audit.smudge', `printf executed > '${path.join(root, 'filter-ran')}'; cat`);
git(repoPath, 'config', 'filter.review-audit.required', 'true');
const { POST } = await import('./route'); const { closeDb } = await import('@/lib/db'); const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const request = (body: unknown, host = '127.0.0.1') => POST(new NextRequest(`http://${host}/api/panel/prs/7/checkout`, { method: 'POST', headers: { host, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ number: '7' }) });
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
describe('PR review checkout entry point', () => {
  it('materializes the reviewed head with durable ownership and preserves staged, unstaged and draft files', async () => {
    mocks.repo.mockResolvedValue({ localPath: repoPath, remoteUrl: mocks.remote }); mocks.head.mockResolvedValue({ sha });
    const status = git(repoPath, 'status', '--porcelain'); const staged = git(repoPath, 'diff', '--cached');
    const response = await request({ repo: 'example/repo', repoPath, commitSha: sha }); const body = await response.json();
    expect(response.status).toBe(201); expect(body.ok).toBe(true); expect(git(body.workspace.path, 'rev-parse', 'HEAD')).toBe(sha); expect(readFileSync(path.join(body.workspace.path, 'code.txt'), 'utf8')).toBe('reviewed\n');
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(base); expect(git(repoPath, 'branch', '--show-current')).toBe('main'); expect(git(repoPath, 'status', '--porcelain')).toBe(status); expect(git(repoPath, 'diff', '--cached')).toBe(staged); expect(readFileSync(path.join(repoPath, 'draft.txt'), 'utf8')).toBe('private draft\n');
    const metadata = await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.readAll()); expect(Object.values(metadata).some((entry) => entry.branchName === body.workspace.branch && entry.materializationIdentity)).toBe(true);
    expect(['typecheck-ran', 'hook-ran', 'filter-ran'].filter((file) => existsSync(path.join(root, file)))).toEqual([]);
    expect(readFileSync(path.join(body.workspace.path, 'change.audit'), 'utf8')).toBe('review content\n');
  }, 30_000);
  it('keeps recoverable ownership after materialization succeeds but its receipt is lost', async () => {
    mocks.repo.mockResolvedValue({ localPath: repoPath, remoteUrl: mocks.remote }); mocks.head.mockResolvedValue({ sha });
    const before = await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.readAll());
    mocks.loseMaterializationReceipt = true;
    const response = await request({ repo: 'example/repo', repoPath, commitSha: sha }); expect(response.status).toBe(502);
    const after = await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.readAll());
    const entries = Object.entries(after).filter(([id]) => !before[id]); expect(entries).toHaveLength(1);
    const [, entry] = entries[0]; expect(entry.status).toBe('creating'); expect(entry.materializationIdentity).toBeDefined();
    expect(git(entry.materializationIdentity!.canonicalPath, 'rev-parse', 'HEAD')).toBe(sha);
    expect(['typecheck-ran', 'hook-ran', 'filter-ran'].filter((file) => existsSync(path.join(root, file)))).toEqual([]);
  }, 30_000);

  it('refuses an unauthorized request before repository or Git access', async () => {
    mocks.repo.mockClear(); expect((await request({ repo: 'example/repo', repoPath, commitSha: sha }, 'remote.test')).status).toBe(401); expect(mocks.repo).not.toHaveBeenCalled();
  });
  it('rejects a misleading origin host and a newer remote head before materialization', async () => {
    const before = git(repoPath, 'worktree', 'list', '--porcelain');
    mocks.remote = 'https://evilgithub.com/example/repo.git'; mocks.repo.mockResolvedValue({ localPath: repoPath, remoteUrl: 'https://github.com/example/repo.git' });
    expect((await request({ repo: 'example/repo', repoPath, commitSha: sha })).status).toBe(409);
    mocks.remote = 'https://github.com/example/repo.git'; mocks.head.mockResolvedValue({ sha: 'b'.repeat(40) });
    expect((await request({ repo: 'example/repo', repoPath, commitSha: sha })).status).toBe(409); expect(git(repoPath, 'worktree', 'list', '--porcelain')).toBe(before);
  });
});
