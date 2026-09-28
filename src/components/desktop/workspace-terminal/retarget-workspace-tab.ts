import type { TerminalTab } from './types';

/** An explicit project choice owns an unsent tab; it is no longer a boot restore. */
export function retargetWorkspaceTab(tabs: TerminalTab[], tabId: string, repoPath: string, repoName?: string | null): TerminalTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId && tab.kind === 'orchestrator');
  if (index < 0) return tabs;
  const tab = tabs[index];
  const freshSpawn = !tab.orchestratorThreadId && !tab.id.startsWith('thoughts-') ? true : tab.freshSpawn;
  if (tab.repo?.localPath === repoPath && tab.freshSpawn === freshSpawn) return tabs;
  const next = [...tabs];
  next[index] = {
    ...tab,
    // Prevent last-thread adoption and preserve this page across scope changes.
    freshSpawn,
    repo: { name: repoName || repoPath.split('/').pop() || repoPath, localPath: repoPath },
  };
  return next;
}
