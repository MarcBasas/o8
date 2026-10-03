// jsdom is a transitive test dependency without bundled declarations.
// @ts-expect-error test-only module has no bundled types
import { JSDOM } from 'jsdom';
import { act, createElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceTerminalController } from '@/components/desktop/workspace-terminal/useWorkspaceTerminalController';
import type { TerminalTabHandle, WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';
import type { PersistedTabState } from '@/lib/terminal/tab-state';
import { createO8WebviewToolHandlers } from './o8-webview-tools';
import type { O8WebviewClient } from './o8-webview-client';

// Real restore -> controller -> imperative handle, the same openOrchestratorTab
// path the sidebar callback uses. Only HTTP storage/liveness and geometry are
// fixtures. No spawn/reuse helper, controller or imperative handle is mocked.
vi.mock('@/lib/operator/use-experimental-chat', () => ({ useExperimentalChatFlag: () => false }));
vi.mock('@/lib/operator/use-experimental-canvas', () => ({ useExperimentalCanvasFlag: () => false }));

const repo = { name: 'fixture', localPath: '/repos/fixture' };
let dom: JSDOM;
let reactRoot: Root;
let host: HTMLDivElement;
let handle: RefObject<TerminalTabHandle | null>;
let saved: PersistedTabState;
const onMenu = vi.fn();
const onSpawn = vi.fn(() => handle.current?.openOrchestratorTab(repo));
let clientCalls: number;
let scope = 0;

function Workspace() {
  const props: WorkspaceTerminalProps = {
    stateScope: `freshness-fixture-${scope}`,
    preferredRepo: repo,
    selectedRepo: repo,
    splitCreated: true,
    defaultTab: 'llm-chat',
    autoCreateDefaultTab: false,
    termWsConnected: false,
    sendTerminalCreate: vi.fn(), sendTerminalAttach: vi.fn(), sendTerminalDetach: vi.fn(),
    sendTerminalInput: vi.fn(), sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(),
  };
  const controller = useWorkspaceTerminalController(props, handle);
  return createElement('section', {
    'data-o8-workspace-root': '1',
    'data-o8-workspace-active': 'true',
    'data-o8-workspace-id': 'workspace',
    'data-o8-active-repo': repo.localPath,
    'data-o8-active-tab-id': controller.effectiveActiveTabId,
    'data-o8-active-tab-kind': 'orchestrator',
    'data-tabs': JSON.stringify(controller.tabs),
  },
  createElement('div', null,
    createElement('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'true', onClick: onMenu }, 'New session'),
    createElement('div', null,
      createElement('button', { 'data-spawn': true, onClick: onSpawn },
        createElement('span', null, createElement('span', null, 'Orchestrator'), createElement('span', null, 'Fleet by default'))))),
  ...controller.tabs.map((tab) => createElement('article', { key: tab.id, 'data-tab-id': tab.id }, tab.label)),
  createElement('textarea', { 'data-o8-active-composer': 'true' }));
}
function tabs() {
  return JSON.parse(host.firstElementChild?.getAttribute('data-tabs') ?? '[]') as Array<{ id: string; orchestratorThreadId?: string }>;
}
function client() {
  clientCalls += 1;
  return {
    navigate: async () => ({ ok: true }),
    evalJs: async (code: string) => {
      let result = '';
      await act(async () => { result = dom.window.eval(code) as string; });
      return { result };
    },
  } as unknown as O8WebviewClient;
}
async function run(args: Record<string, unknown> = {}) {
  const promise = createO8WebviewToolHandlers(client).o8_view_new_orchestrator_session(args);
  const content = (await promise).content[0];
  if (content.type !== 'text') throw new Error('expected structured text receipt');
  return JSON.parse(content.text);
}
async function mount(activeTabId: string, withBlank = true) {
  scope += 1;
  saved = {
    version: 1, activeTabId, savedAt: new Date(0).toISOString(),
    tabs: [
      { id: 'used-tab', label: 'Prior conversation', kind: 'orchestrator', cliAgent: 'shell', repoName: repo.name, repoPath: repo.localPath, orchestratorThreadId: 'thoughts-used' },
      ...(withBlank ? [{ id: 'blank-tab', label: 'Orchestrator', kind: 'orchestrator' as const, cliAgent: 'shell', repoName: repo.name, repoPath: repo.localPath, freshSpawn: true }] : []),
      { id: 'terminal-tab', label: 'Prior terminal', kind: 'terminal', cliAgent: 'shell', repoName: repo.name, repoPath: repo.localPath },
    ],
  };
  await act(async () => reactRoot.render(createElement(Workspace)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(tabs().map((tab) => tab.id)).toEqual(saved.tabs.map((tab) => tab.id));
  expect(host.firstElementChild?.getAttribute('data-o8-active-tab-id')).toBe(activeTabId);
}
beforeEach(() => {
  dom = new JSDOM('', { url: 'http://localhost/dashboard', runScripts: 'outside-only' });
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'CustomEvent', 'localStorage'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/panel/terminal-state')) {
      if (init?.method === 'POST') saved = JSON.parse(String(init.body)) as PersistedTabState;
      return new Response(JSON.stringify(saved), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 } as DOMRect);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div'); document.body.append(host);
  reactRoot = createRoot(host);
  handle = { current: null };
  onMenu.mockClear(); onSpawn.mockClear(); clientCalls = 0;
});
afterEach(async () => {
  await act(async () => reactRoot.unmount());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close();
});

describe('registered fresh-session refusal through the real tab controller', () => {
  for (const activeTabId of ['used-tab', 'blank-tab']) {
    it(`refuses before mutation with ${activeTabId} active and a reusable pristine tab`, async () => {
      await mount(activeTabId);
      const before = tabs();
      expect(await run()).toMatchObject({ ok: false, code: 'fresh_session_unavailable', actionDispatched: false });
      expect(clientCalls).toBe(0);
      expect(onMenu).not.toHaveBeenCalled(); expect(onSpawn).not.toHaveBeenCalled();
      expect(tabs()).toEqual(before);
      expect(host.firstElementChild?.getAttribute('data-o8-active-tab-id')).toBe(activeTabId);
      expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
      // The unchanged ordinary callback really reuses this pristine tab. The
      // tool's refusal must not alter UI reuse merely to claim fresh creation.
      await act(async () => host.querySelector<HTMLButtonElement>('[data-spawn]')?.click());
      expect(host.firstElementChild?.getAttribute('data-o8-active-tab-id')).toBe('blank-tab');
      expect(tabs()).toEqual(before);
      expect(tabs().find((tab) => tab.id === 'used-tab')?.orchestratorThreadId).toBe('thoughts-used');
      expect(host.querySelector('[data-tab-id="terminal-tab"]')).not.toBeNull();
      expect(onSpawn).toHaveBeenCalledTimes(1);
    });
  }
  it('does not assume creation is guaranteed just because no blank is currently rendered', async () => {
    await mount('used-tab', false);
    const before = tabs();
    expect(await run({ repo: 'fixture' })).toMatchObject({ ok: false, code: 'fresh_session_unavailable', actionDispatched: false });
    expect(clientCalls).toBe(0); expect(onSpawn).not.toHaveBeenCalled(); expect(onMenu).not.toHaveBeenCalled();
    expect(tabs()).toEqual(before);
  });
  it('cannot replay a spawn on repeated refusal or request a disconnected client', async () => {
    const getClient = vi.fn(() => { throw new Error('transport unavailable'); });
    const handler = createO8WebviewToolHandlers(getClient).o8_view_new_orchestrator_session;
    for (let count = 0; count < 2; count += 1) {
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}')).toMatchObject({ code: 'fresh_session_unavailable', actionDispatched: false });
    }
    expect(getClient).not.toHaveBeenCalled();
  });
});
