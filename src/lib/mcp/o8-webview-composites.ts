import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

type TextContent = { type: 'text'; text: string };
type McpToolResult = {
  content: TextContent[];
  isError?: boolean;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

type CompositeStep =
  | 'navigate_dashboard'
  | 'select_repo'
  | 'reveal_session_menu'
  | 'open_new_tab_menu'
  | 'pick_orchestrator'
  | 'wait_for_composer'
  | 'locate_menu_trigger'
  | 'wait_for_popover'
  | 'pick_menu_option'
  | 'verify_popover_closed'
  | 'read_surface_state';

interface CompositeError {
  ok: false;
  step: CompositeStep;
  error: string;
  state?: unknown;
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return !!value
    && typeof value === 'object'
    && Array.isArray((value as { content?: unknown }).content);
}

function toolError(step: CompositeStep, error: unknown, state?: unknown): McpToolResult {
  const payload: CompositeError = {
    ok: false,
    step,
    error: error instanceof Error ? error.message : String(error),
    ...(state === undefined ? {} : { state }),
  };
  return jsonResult(payload, true);
}

function optionalString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function buildJsonEval(body: string): string {
  return `(() => {
  try {
${body}
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
})()`;
}

async function evalJson(client: O8WebviewClient, code: string): Promise<Record<string, unknown>> {
  const raw = await client.evalJs(code);
  try {
    const parsed = JSON.parse(raw.result);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { ok: false, error: 'eval returned non-object JSON' };
  } catch {
    return { ok: false, error: `eval returned unparseable JSON: ${raw.result.slice(0, 200)}` };
  }
}

function isOk(value: Record<string, unknown>): boolean {
  return value.ok === true;
}

async function waitForState(
  client: O8WebviewClient,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    latest = await evalJson(client, SURFACE_STATE_SCRIPT);
    if (isOk(latest) && predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

async function runActionThenVerify(
  client: O8WebviewClient,
  step: CompositeStep,
  action: () => Promise<unknown>,
  verify: (state: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | McpToolResult> {
  try {
    await action();
  } catch (error) {
    const state = await waitForState(client, verify, 1_500);
    if (verify(state)) {
      return { ok: true, warning: error instanceof Error ? error.message : String(error), state };
    }
    return toolError(step, error, state);
  }

  const state = await waitForState(client, verify, 5_000);
  if (!verify(state)) {
    return toolError(step, 'verification did not pass before timeout', state);
  }
  return state;
}

function visibleDomHelpers(): string {
  return `
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => norm(value).toLowerCase();
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.getAttribute('placeholder') || '');
    const clickElement = (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus({ preventScroll: true }); } catch (_) {}
      const rect = el.getBoundingClientRect();
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, mouse);
      const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new PointerCtor('pointerdown', Object.assign({ buttons: 1 }, pointer)));
      el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, mouse)));
      el.dispatchEvent(new PointerCtor('pointerup', Object.assign({ buttons: 0 }, pointer)));
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, mouse)));
      el.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0, detail: 1 }, mouse)));
    };
  `;
}

function buildSurfaceStateScript({ focusComposer }: { focusComposer: boolean }): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const route = window.location.pathname + window.location.search + window.location.hash;
    const composerCandidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(isVisible);
    const composer = composerCandidates.find((el) => el.getAttribute('data-o8-active-composer') === 'true') || composerCandidates.find((el) => {
      const label = lower(labelFor(el));
      return label.includes('message') || label.includes('ask') || label.includes('queue') || label.includes('reply') || label.includes('orchestrator');
    }) || composerCandidates[0] || null;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible)
      .map((el) => labelFor(el) || norm((el.innerText || el.textContent || '').slice(0, 80)))
      .filter(Boolean);
    // Active workspace identity is render-derived by WorkspaceTerminalRoot and
    // read straight from its data attributes — never guessed from labels or
    // buttons. Identity comes only from a pane explicitly marked active that is
    // actually visible (no display:none / visibility:hidden ancestor): a single
    // unmarked root is NOT active, and an ambiguous/duplicate case yields null.
    const isActiveRootVisible = (el) => {
      let node = el;
      while (node && node instanceof HTMLElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      return true;
    };
    const activeRoots = Array.from(document.querySelectorAll('[data-o8-workspace-root]'))
      .filter((el) => el.getAttribute('data-o8-workspace-active') === 'true' && isActiveRootVisible(el));
    const activeRoot = activeRoots.length === 1 ? activeRoots[0] : null;
    const rootAttr = (name) => (activeRoot ? (activeRoot.getAttribute(name) || null) : null);
    const rawKind = rootAttr('data-o8-active-tab-kind');
    const activeTabKind = rawKind === 'terminal'
      ? 'terminal'
      : rawKind === 'chat' || rawKind === 'llm-chat'
        ? 'chat'
        : rawKind === 'orchestrator'
          ? 'orchestrator'
          : null;
    const activeTabId = rootAttr('data-o8-active-tab-id');
    const activeWorkspaceId = rootAttr('data-o8-workspace-id');
    const activeWorkspaceRepo = rootAttr('data-o8-active-repo');
    if (${focusComposer ? 'true' : 'false'} && composer && !composer.hasAttribute('disabled')) {
      try { composer.focus({ preventScroll: true }); } catch (_) {}
    }
    return JSON.stringify({
      ok: true,
      route,
      activeWorkspaceId,
      activeWorkspaceRepo,
      activeTabKind,
      activeTabId,
      openDialogs: dialogs,
      composerFocused: !!composer && document.activeElement === composer,
      composerFocusable: !!composer && !composer.hasAttribute('disabled'),
    });
  `);
}

export const SURFACE_STATE_SCRIPT = buildSurfaceStateScript({ focusComposer: false });
// Fixed current-shell controls only. The compact rail reveals the sidebar;
// the sidebar New session disclosure owns the inline Orchestrator option.
// Add pane creates a split chat and is deliberately not a spawn fallback.
function sessionEntryScript(expected: Record<string, unknown>, stage: 'inspect' | 'rail' | 'menu' | 'menu-status' | 'option' | 'observe' | 'focus'): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const expected = ${JSON.stringify(expected)};
    const visibleTree = (el) => {
      if (!isVisible(el) || !el.isConnected) return false;
      for (let node = el; node instanceof HTMLElement; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    };
    const roots = Array.from(document.querySelectorAll('[data-o8-workspace-root][data-o8-workspace-active="true"]')).filter(visibleTree);
    const root = roots.length === 1 ? roots[0] : null;
    if (!root || root.getAttribute('data-o8-workspace-id') !== expected.activeWorkspaceId
      || root.getAttribute('data-o8-active-repo') !== expected.activeWorkspaceRepo) {
      return JSON.stringify({ ok: false, error: 'active workspace/project changed or ambiguous' });
    }
    if (Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(visibleTree)) {
      return JSON.stringify({ ok: false, error: 'close the active dialog before creating a session' });
    }
    const stage = ${JSON.stringify(stage)};
    if (stage === 'observe' || stage === 'focus') {
      const tabId = root.getAttribute('data-o8-active-tab-id');
      const composers = Array.from(root.querySelectorAll('[data-o8-active-composer="true"]')).filter(visibleTree);
      const composer = composers.length === 1 ? composers[0] : null;
      if (!tabId || tabId === expected.activeTabId || (stage === 'focus' && tabId !== expected.observedTabId) || root.getAttribute('data-o8-active-tab-kind') !== 'orchestrator'
        || !composer || composer.disabled || composer.readOnly) {
        return JSON.stringify({ ok: false, error: 'distinct orchestrator tab and enabled active composer not observed' });
      }
      if (stage === 'focus') composer.focus({ preventScroll: true });
      return JSON.stringify({ ok: stage === 'observe' || document.activeElement === composer, tabId, state: {
        activeWorkspaceId: expected.activeWorkspaceId, activeWorkspaceRepo: expected.activeWorkspaceRepo,
        activeTabId: tabId, activeTabKind: 'orchestrator', composerFocused: document.activeElement === composer,
      } });
    }
    if (root.getAttribute('data-o8-active-tab-id') !== expected.activeTabId) {
      return JSON.stringify({ ok: false, error: 'active tab changed before spawn' });
    }
    const buttons = Array.from(document.querySelectorAll('button')).filter(visibleTree);
    const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const triggers = buttons.filter((el) => lower(labelFor(el)) === 'new session' && el.getAttribute('aria-haspopup') === 'menu');
    const rails = buttons.filter((el) => lower(labelFor(el)) === 'new session' && !el.hasAttribute('aria-haspopup'));
    if (triggers.length > 1 || (!triggers.length && rails.length > 1)) {
      return JSON.stringify({ ok: false, error: 'New session target is ambiguous' });
    }
    const trigger = triggers.length === 1 ? triggers[0] : null;
    if (stage === 'inspect') return JSON.stringify({ ok: true, menuReady: !!trigger && enabled(trigger), railReady: rails.length === 1 && enabled(rails[0]) });
    const target = stage === 'rail' ? (rails.length === 1 && !trigger ? rails[0] : null) : trigger;
    if (!target || !enabled(target)) return JSON.stringify({ ok: false, error: 'enabled New session target not found' });
    if (stage === 'option' || stage === 'menu-status') {
      if (trigger.getAttribute('aria-expanded') !== 'true') return JSON.stringify({ ok: false, error: 'New session menu is not expanded' });
      // MiniSessionMenu is the disclosure's immediate sibling. Restrict the
      // search to that owner, never a similarly named option elsewhere.
      const menu = trigger.nextElementSibling;
      const options = menu ? Array.from(menu.querySelectorAll('button')).filter(visibleTree).filter((el) =>
        lower(labelFor(el)) === 'orchestrator' || Array.from(el.querySelectorAll('span')).some((span) => lower(span.textContent) === 'orchestrator')) : [];
      if (options.length !== 1 || !enabled(options[0])) return JSON.stringify({ ok: false, error: 'enabled Orchestrator option missing or ambiguous' });
      if (stage === 'option') clickElement(options[0]);
    } else if (stage === 'rail' || trigger.getAttribute('aria-expanded') !== 'true') {
      clickElement(target);
    }
    return JSON.stringify({ ok: true });
  `);
}

export function buildPickMenuTriggerScript(menuLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(menuLabel.toLowerCase())};
    const isMenuTrigger = (el) => {
      if (el.getAttribute('aria-pressed') !== null) return false;
      if (el.getAttribute('role') === 'tab') return false;
      if (el.getAttribute('aria-haspopup')) return true;
      const expanded = el.getAttribute('aria-expanded');
      return expanded === 'true' || expanded === 'false';
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], a[href]'))
      .filter(isVisible)
      .filter(isMenuTrigger);
    const trigger = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!trigger) return JSON.stringify({ ok: false, error: 'menu trigger not found', menuLabel: ${JSON.stringify(menuLabel)} });
    clickElement(trigger);
    return JSON.stringify({ ok: true, trigger: labelFor(trigger) });
  `);
}

export function buildPickMenuOptionScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]')).filter(isVisible);
    const option = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!option) return JSON.stringify({ ok: false, error: 'menu option not found', optionLabel: ${JSON.stringify(optionLabel)} });
    clickElement(option);
    return JSON.stringify({ ok: true, option: labelFor(option) });
  `);
}

function buildMenuOptionVisibleScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-composer-overlay]')).filter(isVisible);
    const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]'))
      .filter(isVisible)
      .find((el) => lower(labelFor(el)) === needle || lower(labelFor(el)).includes(needle));
    return JSON.stringify({ ok: true, popoverVisible: candidates.length > 0 || !!option, optionVisible: !!option });
  `);
}

function buildMenuOptionClosedScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]'))
      .filter(isVisible)
      .find((el) => lower(labelFor(el)) === needle || lower(labelFor(el)).includes(needle));
    const popovers = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-composer-overlay]')).filter(isVisible);
    return JSON.stringify({ ok: true, closed: !option && popovers.length === 0, optionVisible: !!option, popoverCount: popovers.length });
  `);
}

function buildSelectRepoScript(repo: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(repo.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter(isVisible);
    const exact = candidates.filter((el) => lower(labelFor(el)) === needle);
    const matches = exact.length ? exact : candidates.filter((el) => lower(labelFor(el)).includes(needle));
    if (matches.length !== 1 || matches[0].disabled) return JSON.stringify({ ok: false, error: 'enabled repo target missing or ambiguous', repo: ${JSON.stringify(repo)} });
    const target = matches[0];
    clickElement(target);
    return JSON.stringify({ ok: true, repo: labelFor(target) });
  `);
}

async function ensureDashboard(client: O8WebviewClient): Promise<Record<string, unknown> | McpToolResult> {
  return runActionThenVerify(
    client,
    'navigate_dashboard',
    () => client.navigate('/dashboard'),
    (state) => typeof state.route === 'string' && state.route.startsWith('/dashboard'),
  );
}

async function clickAndRequireOk(client: O8WebviewClient, step: CompositeStep, code: string): Promise<Record<string, unknown> | McpToolResult> {
  try {
    const result = await evalJson(client, code);
    if (!isOk(result)) {
      return toolError(step, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
    return result;
  } catch (error) {
    const state = await evalJson(client, SURFACE_STATE_SCRIPT).catch(() => undefined);
    return toolError(step, error, state);
  }
}

async function evalActionThenVerify(
  client: O8WebviewClient,
  step: CompositeStep,
  actionCode: string,
  verifyCode: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | McpToolResult> {
  let warning: string | null = null;
  try {
    const result = await evalJson(client, actionCode);
    if (!isOk(result)) {
      return toolError(step, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const verified = await waitForEval(client, verifyCode, predicate, timeoutMs);
  if (!predicate(verified)) {
    return toolError(step, warning ?? 'verification did not pass before timeout', verified);
  }
  return warning ? { ...verified, warning } : verified;
}

async function evalActionThenWaitFor(
  client: O8WebviewClient,
  actionStep: CompositeStep,
  waitStep: CompositeStep,
  actionCode: string,
  verifyCode: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | McpToolResult> {
  let warning: string | null = null;
  try {
    const result = await evalJson(client, actionCode);
    if (!isOk(result)) {
      return toolError(actionStep, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const verified = await waitForEval(client, verifyCode, predicate, timeoutMs);
  if (!predicate(verified)) {
    return toolError(waitStep, warning ?? 'verification did not pass before timeout', verified);
  }
  return warning ? { ...verified, warning } : verified;
}

async function waitForEval(
  client: O8WebviewClient,
  code: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    latest = await evalJson(client, code);
    if (isOk(latest) && predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

export const O8_WEBVIEW_COMPOSITE_TOOLS: McpTool[] = [
  {
    name: 'o8_view_new_orchestrator_session',
    description: 'USE THIS WHEN you need a fresh o8 orchestrator tab ready for input. Reveals the sidebar when needed, opens its New session menu, picks Orchestrator, verifies a distinct tab in the active project, and focuses its composer. Returns structured state instead of relying on screenshots. After an uncertain result, observe state before any further action; do not replay the spawn.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional repo/workspace label to select before opening the orchestrator tab. Omit or pass an empty string to use the current workspace.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'o8_view_pick_menu_option',
    description: 'USE THIS WHEN you need to choose an item from an o8 popover or menu by labels. Finds the trigger by aria-label/title/visible text, clicks the option by text, and verifies the popover closed.',
    inputSchema: {
      type: 'object',
      properties: {
        menuLabel: { type: 'string', description: 'Visible text, title, or aria-label of the menu trigger.' },
        optionLabel: { type: 'string', description: 'Visible text of the menu option to choose.' },
      },
      required: ['menuLabel', 'optionLabel'],
      additionalProperties: false,
    },
  },
  {
    name: 'o8_view_surface_state',
    description: 'USE THIS WHEN you need a structured read-only snapshot of the active o8 surface: route, active workspace, active tab kind, open dialogs, and composer focus state. Uses one eval batch and no screenshots.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

export function createO8WebviewCompositeHandlers(getClient: () => O8WebviewClient): Record<string, ToolHandler> {
  return {
    o8_view_new_orchestrator_session: async (args) => {
      try {
        const client = getClient();
        const repo = optionalString(args, 'repo');

        const dashboard = await ensureDashboard(client);
        if (isMcpToolResult(dashboard)) return dashboard;

        if (repo) {
          const selected = await clickAndRequireOk(client, 'select_repo', buildSelectRepoScript(repo));
          if (isMcpToolResult(selected)) return selected;
        }

        const expected = await evalJson(client, SURFACE_STATE_SCRIPT);
        if (!isOk(expected) || typeof expected.activeWorkspaceId !== 'string'
          || typeof expected.activeWorkspaceRepo !== 'string' || typeof expected.activeTabId !== 'string') {
          return toolError('read_surface_state', 'one active project and tab are required', expected);
        }
        const entry = await evalJson(client, sessionEntryScript(expected, 'inspect'));
        if (!isOk(entry)) return toolError('open_new_tab_menu', entry.error, entry);
        if (entry.menuReady !== true) {
          if (entry.railReady !== true) return toolError('reveal_session_menu', 'enabled New session control not found', entry);
          const revealed = await evalActionThenWaitFor(
            client, 'reveal_session_menu', 'reveal_session_menu',
            sessionEntryScript(expected, 'rail'), sessionEntryScript(expected, 'inspect'),
            (value) => value.ok === true && value.menuReady === true, 5_000,
          );
          if (isMcpToolResult(revealed)) return revealed;
        }
        // Each mutation is attempted once. A lost response is reconciled only by
        // observation; it never selects a second spawn control or repeats a click.
        const opened = await evalActionThenWaitFor(
          client, 'open_new_tab_menu', 'wait_for_popover',
          sessionEntryScript(expected, 'menu'), sessionEntryScript(expected, 'menu-status'),
          (value) => value.ok === true, 5_000,
        );
        if (isMcpToolResult(opened)) return opened;
        const option = await evalActionThenVerify(
          client, 'pick_orchestrator', sessionEntryScript(expected, 'option'),
          sessionEntryScript(expected, 'observe'), (value) => value.ok === true, 7_500,
        );
        if (isMcpToolResult(option)) return option;
        const focused = await clickAndRequireOk(client, 'wait_for_composer', sessionEntryScript({ ...expected, observedTabId: option.tabId }, 'focus'));
        return isMcpToolResult(focused) ? focused : jsonResult(focused);
      } catch (error) {
        return toolError('read_surface_state', error, { mutationOutcome: 'unknown', automaticReplay: false });
      }
    },

    o8_view_pick_menu_option: async (args) => {
      let menuLabel: string;
      let optionLabel: string;
      try {
        menuLabel = requiredString(args, 'menuLabel');
        optionLabel = requiredString(args, 'optionLabel');
      } catch (error) {
        return toolError('locate_menu_trigger', error);
      }

      const client = getClient();
      const trigger = await evalActionThenWaitFor(
        client,
        'locate_menu_trigger',
        'wait_for_popover',
        buildPickMenuTriggerScript(menuLabel),
        buildMenuOptionVisibleScript(optionLabel),
        (value) => value.optionVisible === true,
        5_000,
      );
      if (isMcpToolResult(trigger)) return trigger;

      const option = await evalActionThenVerify(
        client,
        'pick_menu_option',
        buildPickMenuOptionScript(optionLabel),
        buildMenuOptionClosedScript(optionLabel),
        (value) => value.closed === true,
        2_000,
      );
      if (isMcpToolResult(option)) return option;
      return jsonResult({ ok: true, menuLabel, optionLabel, state: option });
    },

    o8_view_surface_state: async () => {
      const client = getClient();
      try {
        const state = await evalJson(client, SURFACE_STATE_SCRIPT);
        if (!isOk(state)) return toolError('read_surface_state', typeof state.error === 'string' ? state.error : 'state eval failed', state);
        const publicState = { ...state };
        delete publicState.ok;
        delete publicState.composerFocusable;
        return jsonResult(publicState);
      } catch (error) {
        return toolError('read_surface_state', error);
      }
    },
  };
}
