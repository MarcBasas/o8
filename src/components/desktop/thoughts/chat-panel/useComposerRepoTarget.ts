import { useCallback, useEffect } from 'react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';

interface ComposerRepoTargetOptions {
  applyRepoPath: (repoPath: string) => void;
  ownerTabId?: string;
  scopeTabId?: string;
  workspaceTargets: OrchestratorWorkspaceTarget[];
}

export function useComposerRepoTarget({
  applyRepoPath,
  ownerTabId,
  scopeTabId,
  workspaceTargets,
}: ComposerRepoTargetOptions) {
  const selectRepoPath = useCallback((next: string) => {
    applyRepoPath(next);
    if (!ownerTabId || typeof window === 'undefined') return;
    const target = workspaceTargets.find((entry) => entry.localPath === next);
    window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
      detail: { tabId: ownerTabId, repoPath: next, repoName: target?.repoName ?? null },
    }));
  }, [applyRepoPath, ownerTabId, workspaceTargets]);

  // The outer empty-state picker also emits this event. Isolated panels apply
  // their own choice locally, while only workspace-owned panels bind a tab.
  useEffect(() => {
    if (typeof window === 'undefined' || !scopeTabId) return;
    const onScope = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; repoPath?: string | null }>).detail;
      if (detail?.tabId !== scopeTabId) return;
      applyRepoPath(typeof detail.repoPath === 'string' && detail.repoPath.trim() ? detail.repoPath : '');
    };
    window.addEventListener('o8:select-workspace-scope', onScope as EventListener);
    return () => window.removeEventListener('o8:select-workspace-scope', onScope as EventListener);
  }, [applyRepoPath, scopeTabId]);

  return selectRepoPath;
}
