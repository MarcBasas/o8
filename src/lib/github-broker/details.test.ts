import { beforeEach, describe, expect, it, vi } from 'vitest';

const { githubInstallationFetch } = vi.hoisted(() => ({ githubInstallationFetch: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch }));
import { fetchGitHubPullRequestDetail } from './details';

const pull = { number: 7, title: 'Change', state: 'open', draft: true, html_url: 'https://github.com/example/repo/pull/7', user: { login: 'author', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, labels: [{ name: 'ui' }], requested_reviewers: [{ login: 'reviewer' }], head: { sha: 'head', ref: 'work' }, base: { ref: 'main' } };
beforeEach(() => vi.clearAllMocks());

describe('pull request detail reads', () => {
  it('starts files, checks and reviews together instead of waiting for a large file response', async () => {
    const finish = new Map<string, (value: { response: Response }) => void>();
    githubInstallationFetch.mockImplementation((_repo: string, path: string) => path.endsWith('/pulls/7')
      ? Promise.resolve({ response: Response.json(pull) })
      : new Promise<{ response: Response }>((resolve) => { finish.set(path, resolve); }));
    const pending = fetchGitHubPullRequestDetail('example/repo', 7);
    await vi.waitFor(() => expect(finish.size).toBe(3));
    finish.get('/repos/example/repo/pulls/7/files?per_page=100')!({ response: Response.json([{ filename: 'app.ts', additions: 27, deletions: 4, patch: '@@ diff' }]) });
    finish.get('/repos/example/repo/commits/head/check-runs?per_page=100')!({ response: Response.json({ check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/repo/actions/runs/1' }] }) });
    finish.get('/repos/example/repo/pulls/7/reviews?per_page=100')!({ response: Response.json([{ state: 'APPROVED' }, { state: 'COMMENTED' }]) });
    expect(await pending).toMatchObject({ number: 7, draft: true, avatarUrl: pull.user.avatar_url, labels: ['ui'], requestedReviewers: ['reviewer'], files: [{ path: 'app.ts', patch: '@@ diff' }], statusCheckRollup: [{ name: 'unit', conclusion: 'success', url: 'https://github.com/example/repo/actions/runs/1' }], reviewDecision: 'APPROVED' });
  });

  it('preserves file errors and tolerates unavailable optional checks and reviews', async () => {
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/7')) return { response: Response.json(pull) };
      if (path.includes('/files?')) return { response: Response.json([{ filename: 'app.ts' }]) };
      throw new Error('Optional read unavailable');
    });
    expect(await fetchGitHubPullRequestDetail('example/repo', 7)).toMatchObject({ files: [{ path: 'app.ts' }], statusCheckRollup: [], reviewDecision: null });
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({ response: path.endsWith('/pulls/7') ? Response.json(pull) : Response.json({ message: 'Files unavailable' }, { status: 502 }) }));
    await expect(fetchGitHubPullRequestDetail('example/repo', 7)).rejects.toThrow('Pull request changes could not be read');
  });
});
