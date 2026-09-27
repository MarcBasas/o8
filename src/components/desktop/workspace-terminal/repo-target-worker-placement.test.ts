// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueOutsideWorkerSplit, resetOutsideWorkerSplitsForTest } from '@/lib/orchestrator/outside-worker-split';
import type { PersistedTabState } from '@/lib/terminal/tab-state';
import { useOutsideWorkerSplitMount } from './use-outside-worker-split-mount';
import { useSessionTiles } from './use-session-tiles';
import { useWorkspaceTerminalController } from './useWorkspaceTerminalController';
import type { TerminalTab, WorkspaceTerminalProps } from './types';

vi.mock('@/lib/operator/use-experimental-chat', () => ({ useExperimentalChatFlag: () => false }));
vi.mock('@/lib/operator/use-experimental-canvas', () => ({ useExperimentalCanvasFlag: () => false }));

const OLD_REPO = '/repo/original';
const NEW_REPO = '/repo/selected';
const THREAD_ID = 'thoughts-repo-target';
const ACTIVE_THREAD_ID = 'thoughts-other-tab';
const WORKER_KEY = 'codex-owned:repo-target-worker';

function WorkerPane({ active, tab }: { active: boolean; tab: TerminalTab }) {
  const tiles = useSessionTiles({
    tabId: tab.id,
    repoPath: tab.repo?.localPath ?? '',
    workspaceId: 'target-workspace',
    threadId: tab.orchestratorThreadId,
    active,
    liveSessionKeys: [],
  });
  return createElement('output', {
    'data-testid': 'worker-pane',
    'data-tab-id': tab.id,
    'data-repo': tab.repo?.localPath ?? '',
    'data-sessions': tiles.tiledSessions.join(','),
  });
}

function Workspace({ initialRepo }: { initialRepo: string }) {
  const [preferredPath, setPreferredPath] = useState(initialRepo);
  const repo = { name: preferredPath.split('/').pop() ?? preferredPath, localPath: preferredPath };
  const props: WorkspaceTerminalProps = {
    stateScope: 'tile-root',
    defaultTab: 'llm-chat',
    preferredRepo: repo,
    selectedRepo: repo,
    onRepoScopeChange: (next) => { if (next) setPreferredPath(next); },
    sendTerminalCreate: () => undefined,
    sendTerminalAttach: () => undefined,
    sendTerminalInput: () => undefined,
    sendTerminalResize: () => undefined,
    sendTerminalVisibility: () => undefined,
    sendTerminalDetach: () => undefined,
    termWsConnected: false,
  };
  const controller = useWorkspaceTerminalController(props, null);
  useOutsideWorkerSplitMount({
    active: true,
    activeTabId: controller.effectiveActiveTabId,
    workspaceId: 'target-workspace',
    tabs: controller.tabs,
    selectTab: controller.handleSelectTab,
    spawnOrchestratorTab: controller.spawnOrchestratorTab,
  });
  return createElement('div', {
    'data-testid': 'workspace',
    'data-tab-ids': controller.tabs.map((tab) => tab.id).join(','),
    'data-active-tab-id': controller.effectiveActiveTabId,
    'data-preferred-repo': preferredPath,
  },
  createElement('button', { type: 'button', 'data-select-parent': true, onClick: () => controller.handleSelectTab(THREAD_ID) }, 'Select parent'),
  ...controller.tabs.filter((tab) => tab.kind === 'orchestrator').map((tab) => (
    createElement(WorkerPane, { key: tab.id, tab, active: tab.id === controller.effectiveActiveTabId })
  )));
}

describe('workspace Project target and worker placement', () => {
  let host: HTMLDivElement;
  let root: Root;
  let saved: PersistedTabState;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetOutsideWorkerSplitsForTest();
    localStorage.clear();
    saved = {
      version: 1,
      activeTabId: ACTIVE_THREAD_ID,
      tabs: [
        { id: THREAD_ID, label: 'Parent chat', kind: 'orchestrator', cliAgent: 'shell', repoName: 'original', repoPath: OLD_REPO, orchestratorThreadId: THREAD_ID },
        { id: ACTIVE_THREAD_ID, label: 'Other chat', kind: 'orchestrator', cliAgent: 'shell', repoName: 'original', repoPath: OLD_REPO, orchestratorThreadId: ACTIVE_THREAD_ID },
      ],
      savedAt: new Date(0).toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/panel/terminal-state')) {
        if (init?.method === 'POST') {
          saved = JSON.parse(String(init.body)) as PersistedTabState;
          return new Response('{}', { status: 200 });
        }
        return new Response(JSON.stringify(saved), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    resetOutsideWorkerSplitsForTest();
    vi.unstubAllGlobals();
  });

  it('binds the owning tab, claims its worker, and restores the same repo and pane', async () => {
    await act(async () => root.render(createElement(Workspace, { initialRepo: OLD_REPO })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(host.querySelector(`[data-tab-id="${THREAD_ID}"]`)?.getAttribute('data-repo')).toBe(OLD_REPO);
    expect(host.querySelector('[data-testid="workspace"]')?.getAttribute('data-active-tab-id')).toBe(ACTIVE_THREAD_ID);

    await act(async () => window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
      detail: { tabId: THREAD_ID, repoPath: NEW_REPO, repoName: 'selected' },
    })));
    expect(host.querySelector(`[data-tab-id="${THREAD_ID}"]`)?.getAttribute('data-repo')).toBe(NEW_REPO);
    expect(host.querySelector(`[data-tab-id="${ACTIVE_THREAD_ID}"]`)?.getAttribute('data-repo')).toBe(OLD_REPO);
    expect(host.querySelector('[data-testid="workspace"]')?.getAttribute('data-active-tab-id')).toBe(ACTIVE_THREAD_ID);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-select-parent]')?.click());
    expect(host.querySelector('[data-testid="workspace"]')?.getAttribute('data-preferred-repo')).toBe(NEW_REPO);

    await act(async () => queueOutsideWorkerSplit({
      sessionKey: WORKER_KEY,
      runtime: 'codex',
      repoPath: NEW_REPO,
      launchContext: { source: 'agent', presentation: 'split', repoContext: 'registered', caller: 'orchestrator', parentThreadId: THREAD_ID, checkoutMode: 'shared' },
    }));
    expect(host.querySelector('[data-testid="workspace"]')?.getAttribute('data-tab-ids')).toBe(`${THREAD_ID},${ACTIVE_THREAD_ID}`);
    expect(host.querySelector(`[data-tab-id="${THREAD_ID}"]`)?.getAttribute('data-sessions')).toBe(WORKER_KEY);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
    expect(saved.tabs.find((tab) => tab.id === THREAD_ID)?.repoPath).toBe(NEW_REPO);
    expect(saved.tabs.find((tab) => tab.id === THREAD_ID)?.repoName).toBe('selected');

    await act(async () => root.unmount());
    resetOutsideWorkerSplitsForTest();
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace, { initialRepo: NEW_REPO })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(host.querySelector('[data-testid="workspace"]')?.getAttribute('data-tab-ids')).toBe(`${THREAD_ID},${ACTIVE_THREAD_ID}`);
    expect(host.querySelector(`[data-tab-id="${THREAD_ID}"]`)?.getAttribute('data-repo')).toBe(NEW_REPO);
    expect(host.querySelector(`[data-tab-id="${THREAD_ID}"]`)?.getAttribute('data-sessions')).toBe(WORKER_KEY);
  });
});
