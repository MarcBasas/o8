// jsdom is a transitive test dependency without bundled declarations.
// @ts-expect-error test-only module has no bundled types
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from './o8-webview-tools';
import type { O8WebviewClient } from './o8-webview-client';

// The transport evaluates the production fixed scripts against the current
// shell's DOM: rail disclosure, inline sidebar menu and render-derived tab IDs.
// Only geometry and the tab controller's spawn commit are fixture boundaries.
let dom: JSDOM;
let clicks: string[];
let spawned: number;
let root: HTMLElement;
let refuseSpawn: boolean;
let dropAt: string | null;
let changeProject: boolean;
let duplicateOptions: boolean;
let delayedMenu: boolean;
let disabledComposer: boolean;
let dropObservations: boolean;
let changeTabBeforeFocus: boolean;
function button(label: string, menu = false): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = label;
  if (menu) el.setAttribute('aria-haspopup', 'menu');
  return el;
}
function sidebar() {
  const group = document.createElement('div');
  const trigger = button('New session', true);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.onclick = () => {
    clicks.push('menu');
    trigger.setAttribute('aria-expanded', 'true');
    const menu = document.createElement('div');
    const option = button('');
    option.innerHTML = '<span><span>Orchestrator</span><span>Fleet by default</span></span>';
    option.onclick = () => {
      clicks.push('spawn');
      menu.remove();
      trigger.setAttribute('aria-expanded', 'false');
      if (refuseSpawn) return;
      spawned += 1;
      root.setAttribute('data-o8-active-tab-id', 'fresh-tab');
      root.setAttribute('data-o8-active-tab-kind', 'orchestrator');
      if (changeProject) root.setAttribute('data-o8-active-repo', '/repos/other');
      const composer = document.createElement('textarea');
      composer.setAttribute('data-o8-active-composer', 'true');
      composer.disabled = disabledComposer;
      root.append(composer);
    };
    menu.append(option, button('Terminal Plain shell'));
    if (duplicateOptions) menu.append(option.cloneNode(true));
    if (delayedMenu) setTimeout(() => group.append(menu), 20);
    else group.append(menu);
  };
  group.append(trigger);
  document.body.append(group);
}
function client() {
  return {
    navigate: async () => ({ ok: true }),
    evalJs: async (code: string) => {
      if (dropObservations && clicks.at(-1) === 'spawn') throw new Error('observation transport unavailable');
      if (changeTabBeforeFocus && code.includes('const stage = "focus"')) root.setAttribute('data-o8-active-tab-id', 'another-tab');
      const count = clicks.length;
      const result = dom.window.eval(code) as string;
      if (clicks.length > count && clicks.at(-1) === dropAt) throw new Error('transport disconnected after dispatch');
      return { result };
    },
  } as unknown as O8WebviewClient;
}
async function run() {
  const promise = createO8WebviewToolHandlers(client).o8_view_new_orchestrator_session({});
  await vi.runAllTimersAsync();
  const content = (await promise).content[0];
  if (content.type !== 'text') throw new Error('expected a structured text receipt');
  return JSON.parse(content.text);
}
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('', { url: 'http://localhost/dashboard', runScripts: 'outside-only' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  clicks = []; spawned = 0; refuseSpawn = false; dropAt = null; changeProject = false; duplicateOptions = false; delayedMenu = false; disabledComposer = false; dropObservations = false; changeTabBeforeFocus = false;
  window.history.replaceState(null, '', '/dashboard');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 } as DOMRect);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  root = document.createElement('div');
  root.setAttribute('data-o8-workspace-root', '1');
  root.setAttribute('data-o8-workspace-active', 'true');
  root.setAttribute('data-o8-workspace-id', 'workspace');
  root.setAttribute('data-o8-active-repo', '/repos/fixture');
  root.setAttribute('data-o8-active-tab-id', 'used-tab');
  root.setAttribute('data-o8-active-tab-kind', 'orchestrator');
  root.innerHTML = '<article id="used-chat">prior chat</article><div id="terminal">prior terminal</div>';
  document.body.append(root);
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); vi.useRealTimers(); });

describe('registered new orchestrator composite in the current shell', () => {
  it('discloses the compact rail then opens the sidebar menu exactly once', async () => {
    const rail = button('New session');
    rail.setAttribute('aria-label', 'New session');
    rail.onclick = () => { clicks.push('rail'); rail.remove(); sidebar(); };
    document.body.append(rail, button('Add pane (workspace)', true));
    const result = await run();
    expect(result).toMatchObject({ ok: true, tabId: 'fresh-tab', state: { activeWorkspaceRepo: '/repos/fixture', composerFocused: true } });
    expect(clicks).toEqual(['rail', 'menu', 'spawn']);
    expect(spawned).toBe(1);
    expect(document.querySelector('#used-chat')?.textContent).toBe('prior chat');
    expect(document.querySelector('#terminal')).not.toBeNull();
  });
  it('uses the already visible sidebar without clicking a second rail', async () => {
    sidebar(); document.body.append(button('New session'));
    expect(await run()).toMatchObject({ ok: true, tabId: 'fresh-tab' });
    expect(clicks).toEqual(['menu', 'spawn']);
  });
  it('refuses duplicate sidebar triggers before mutation', async () => {
    sidebar(); sidebar();
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual([]);
  });
  it('refuses a missing target without using Add pane or legacy spawn fallback', async () => {
    document.body.append(button('Add pane (workspace)', true), button('New tab', true));
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual([]);
  });
  it('does not replay or fall back after a partially dispatched rail disclosure', async () => {
    const rail = button('New session');
    rail.onclick = () => clicks.push('rail');
    document.body.append(rail, button('New tab', true));
    dropAt = 'rail';
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual(['rail']);
  });
  it('does not claim an old composer is a new tab or replay an uncertain spawn', async () => {
    const old = document.createElement('textarea'); old.setAttribute('data-o8-active-composer', 'true'); root.append(old);
    sidebar(); refuseSpawn = true; dropAt = 'spawn';
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual(['menu', 'spawn']);
    expect(document.activeElement).not.toBe(old);
  });
  it('reconciles one committed spawn after its transport acknowledgement is lost', async () => {
    sidebar(); dropAt = 'spawn';
    expect(await run()).toMatchObject({ ok: true, tabId: 'fresh-tab' });
    expect(spawned).toBe(1);
    expect(clicks).toEqual(['menu', 'spawn']);
  });
  it('waits for the menu render and reconciles a lost disclosure acknowledgement', async () => {
    sidebar(); delayedMenu = true; dropAt = 'menu';
    expect(await run()).toMatchObject({ ok: true, tabId: 'fresh-tab' });
    expect(clicks).toEqual(['menu', 'spawn']);
  });
  it('refuses ambiguous options within the owning inline menu', async () => {
    sidebar(); duplicateOptions = true;
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual(['menu']);
  });
  it('refuses a disabled rail without mutation', async () => {
    const rail = button('New session'); rail.disabled = true; document.body.append(rail);
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual([]);
  });
  it('never focuses or claims completion for a disabled new composer', async () => {
    sidebar(); disabledComposer = true;
    expect(await run()).toMatchObject({ ok: false });
    expect(spawned).toBe(1);
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
  });
  it('refuses ambiguous active workspaces before disclosure', async () => {
    document.body.append(root.cloneNode(true)); sidebar();
    expect(await run()).toMatchObject({ ok: false });
    expect(clicks).toEqual([]);
  });
  it('returns unknown without replay when post-spawn observation disconnects', async () => {
    sidebar(); dropObservations = true;
    expect(await run()).toMatchObject({ ok: false, state: { mutationOutcome: 'unknown', automaticReplay: false } });
    expect(clicks).toEqual(['menu', 'spawn']);
    expect(spawned).toBe(1);
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
  });
  it('refuses a different tab between observed completion and focus', async () => {
    sidebar(); changeTabBeforeFocus = true;
    expect(await run()).toMatchObject({ ok: false });
    expect(spawned).toBe(1);
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
  });
  it('refuses a changed project and never focuses its composer', async () => {
    sidebar(); changeProject = true;
    expect(await run()).toMatchObject({ ok: false });
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
    expect(spawned).toBe(1);
  });
});
