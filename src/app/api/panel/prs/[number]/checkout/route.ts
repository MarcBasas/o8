import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getGitHubPullRequestHeadRef } from '@/lib/github-broker/actions';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { taskDraftGit } from '@/lib/mcp/task-draft-git';

export const dynamic = 'force-dynamic';

function githubSlug(remote: string | null | undefined): string | null {
  if (!remote) return null;
  try { const url = new URL(remote.replace(/^git@github\.com:/, 'https://github.com/')); return url.hostname === 'github.com' && ['https:', 'ssh:'].includes(url.protocol) ? url.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase() : null; } catch { return null; }
}

/** Review checkouts use the governed workspace lifecycle, never the current branch. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ number: string }> }) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const number = Number((await params).number);
  const body = await request.json().catch(() => null) as { repo?: unknown; repoPath?: unknown; commitSha?: unknown } | null;
  if (!Number.isSafeInteger(number) || number < 1 || !body || typeof body.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(body.repo) || typeof body.repoPath !== 'string' || typeof body.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(body.commitSha)) return NextResponse.json({ error: 'Repository, local path and reviewed commit are required.' }, { status: 400 });
  try {
    const repo = await findRepoByLocalPath(body.repoPath);
    if (!repo || githubSlug(repo.remoteUrl) !== body.repo.toLowerCase()) return NextResponse.json({ error: 'Select the matching local repository before checking out.' }, { status: 409 });
    const origin = (await taskDraftGit(repo.localPath, ['remote', 'get-url', 'origin'])).trim();
    if (githubSlug(origin) !== body.repo.toLowerCase()) return NextResponse.json({ error: 'The local origin no longer matches this pull request.' }, { status: 409 });
    const head = await getGitHubPullRequestHeadRef(body.repo, number);
    if (head.sha.toLowerCase() !== body.commitSha.toLowerCase()) return NextResponse.json({ error: 'The pull request changed. Refresh before checking out.' }, { status: 409 });
    await taskDraftGit(repo.localPath, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/pull/${number}/head`]);
    // Check the immutable object, not FETCH_HEAD, which another fetch can replace.
    const sha = (await taskDraftGit(repo.localPath, ['rev-parse', '--verify', `${head.sha}^{commit}`])).trim();
    if (sha !== head.sha) throw new Error('The reviewed commit could not be verified.');
    const worktree = await getWorktreeManager(repo.localPath).create({
      agentType: 'review', taskName: `pr-${number}-${sha.slice(0, 8)}`, baseBranch: sha,
      managed: true, materializationOnly: true, skipSetup: true, envMode: 'skip', envFiles: [], isolationPreference: 'git-worktree',
    });
    if ((await taskDraftGit(worktree.path, ['rev-parse', 'HEAD'])).trim() !== sha) return NextResponse.json({ error: 'The workspace was created but its commit could not be verified.', workspace: { path: worktree.path, branch: worktree.branch } }, { status: 409 });
    return NextResponse.json({ ok: true, workspace: { path: worktree.path, branch: worktree.branch, commitSha: sha } }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Checkout could not be confirmed. Check workspaces before trying again.' }, { status: 502 });
  }
}
