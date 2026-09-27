import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { publishPersistedChatHistory } from './usePersistChatThread';

interface ComposerRepoTargetOptions {
  activeThreadId: string | null;
  applyRepoPath: (repoPath: string) => void;
  ownerTabId?: string;
  scopeTabId?: string;
  threadIdRef: RefObject<string | null>;
  workspaceTargets: OrchestratorWorkspaceTarget[];
}

export function useComposerRepoTarget({
  activeThreadId,
  applyRepoPath,
  ownerTabId,
  scopeTabId,
  threadIdRef,
  workspaceTargets,
}: ComposerRepoTargetOptions) {
  const queuedWriteRef = useRef<Promise<void>>(Promise.resolve());
  const selectedWriteRef = useRef<{ key: string; threadId: string; token: object; failed: boolean; promise: Promise<boolean> } | null>(null);
  const [targetSaveErrorThreadId, setTargetSaveErrorThreadId] = useState<string | null>(null);

  const persistSelection = useCallback((repoPath: string) => {
    const threadId = threadIdRef.current;
    if (!threadId) return;
    const key = JSON.stringify([threadId, repoPath]);
    if (selectedWriteRef.current?.key === key && !selectedWriteRef.current.failed) return;
    setTargetSaveErrorThreadId(null);
    const target = workspaceTargets.find((entry) => entry.localPath === repoPath);
    const token = {};
    // PATCH is the operator's explicit retarget. Ordinary transcript POSTs
    // remain sticky so stale clients cannot silently move an existing thread.
    const promise = queuedWriteRef.current.then(async () => {
      try {
        const response = await fetch('/api/v2/chat-history', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tabId: threadId,
            repoPath,
            repoName: target?.repoName ?? null,
            repoBranch: target?.branch ?? null,
            remoteUrl: null,
          }),
        });
        if (!response.ok) return false;
        if (selectedWriteRef.current?.token === token) publishPersistedChatHistory(threadId);
        return true;
      } catch {
        return false;
      }
    });
    queuedWriteRef.current = promise.then(() => undefined);
    const selectedWrite = { key, threadId, token, failed: false, promise };
    selectedWriteRef.current = selectedWrite;
    void promise.then((ok) => {
      selectedWrite.failed = !ok;
      if (selectedWriteRef.current === selectedWrite && !ok) setTargetSaveErrorThreadId(threadId);
    });
  }, [threadIdRef, workspaceTargets]);

  const ensureSelectedRepoPersisted = useCallback(async (signal: AbortSignal) => {
    const selected = selectedWriteRef.current;
    const threadId = threadIdRef.current;
    if (!selected || selected.threadId !== threadId) return true;
    if (signal.aborted) return false;
    return new Promise<boolean>((resolve) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(false); };
      signal.addEventListener('abort', onAbort, { once: true });
      void selected.promise.then((ok) => {
        signal.removeEventListener('abort', onAbort);
        resolve(!signal.aborted && ok
          && selectedWriteRef.current === selected && threadIdRef.current === threadId);
      });
    });
  }, [threadIdRef]);

  const selectRepoPath = useCallback((next: string) => {
    applyRepoPath(next);
    persistSelection(next);
    if (!ownerTabId || typeof window === 'undefined') return;
    const target = workspaceTargets.find((entry) => entry.localPath === next);
    window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
      detail: { tabId: ownerTabId, repoPath: next, repoName: target?.repoName ?? null },
    }));
  }, [applyRepoPath, ownerTabId, persistSelection, workspaceTargets]);

  // The outer empty-state picker also emits this event. Isolated panels apply
  // their own choice locally, while only workspace-owned panels bind a tab.
  useEffect(() => {
    if (typeof window === 'undefined' || !scopeTabId) return;
    const onScope = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; repoPath?: string | null }>).detail;
      if (detail?.tabId !== scopeTabId) return;
      const next = typeof detail.repoPath === 'string' && detail.repoPath.trim() ? detail.repoPath : '';
      applyRepoPath(next);
      persistSelection(next);
    };
    window.addEventListener('o8:select-workspace-scope', onScope as EventListener);
    return () => window.removeEventListener('o8:select-workspace-scope', onScope as EventListener);
  }, [applyRepoPath, persistSelection, scopeTabId]);

  return { selectRepoPath, ensureSelectedRepoPersisted,
    targetSaveError: targetSaveErrorThreadId !== null && targetSaveErrorThreadId === activeThreadId };
}
