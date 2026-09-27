// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';

vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, clerkEnabled: false }) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ surface: 'opaque', workspaceGlass: false }) }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
afterEach(() => vi.unstubAllGlobals());

it('connects compact navigation, recent chats, sidebar preview and real usage responses', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = {
    onHome: vi.fn(), onCreateTerminal: vi.fn(), onSearch: vi.fn(), onOpenProjects: vi.fn(),
    onOpenHistoryChat: vi.fn(), onPinSidebar: vi.fn(), onHoverReveal: vi.fn(), onHoverLeave: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/v2/chat-history/list')) return Response.json({ conversations: [
      { tabId: 'recent', title: 'Continue work', preview: 'A real conversation', modifiedAt: '2026-09-27T12:00:00Z' },
      { tabId: 'archived', title: 'Archived chat', archivedAt: '2026-09-27T11:00:00Z', modifiedAt: '2026-09-27T11:00:00Z' },
    ] });
    if (String(input) === '/api/runtime/capacity') return Response.json({
      schema: 'o8/runtime-capacity-control/v1', capacities: [{ runtime: 'codex', status: 'available', confidence: 'exact', buckets: [{ id: 'weekly', label: 'Weekly', usedRatio: 0.4 }] }],
    });
    throw new Error(`Unexpected request ${String(input)}`);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => {
    const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(found).not.toBeNull();
    return found!;
  };
  const handoffs = vi.fn();
  window.addEventListener('o8:open-handoffs', handoffs);
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, repos: [], previewOpen: false })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(host.querySelector('[aria-label="Chat: Archived chat"]')).toBeNull();
    for (const [label, callback] of [['Home', callbacks.onHome], ['Terminal', callbacks.onCreateTerminal], ['Search', callbacks.onSearch], ['Projects', callbacks.onOpenProjects], ['More chats', callbacks.onPinSidebar]] as const) {
      await act(async () => button(label).click());
      expect(callback).toHaveBeenCalledOnce();
      expect(button(label).style.minWidth).toBe('44px');
      expect(button(label).style.minHeight).toBe('44px');
    }
    await act(async () => button('Handoffs').click());
    expect(handoffs).toHaveBeenCalledOnce();
    await act(async () => button('Chat: Continue work').focus());
    expect(document.getElementById('o8-rail-chat-tooltip')?.textContent).toContain('A real conversation');
    await act(async () => button('Chat: Continue work').click());
    expect(callbacks.onOpenHistoryChat).toHaveBeenCalledWith('recent', 'Continue work', null);
    await act(async () => button('Preview full sidebar').focus());
    expect(callbacks.onHoverReveal).toHaveBeenCalledOnce();
    await act(async () => button('Preview full sidebar').click());
    expect(callbacks.onPinSidebar).toHaveBeenCalledTimes(2);
    await act(async () => button('Runtime usage').focus());
    expect(document.getElementById('o8-rail-usage-tooltip')?.textContent).toContain('40% used');
    for (const scroller of host.querySelectorAll<HTMLElement>('[style*="overflow-y: auto"]')) expect(scroller.style.scrollbarWidth).toBe('none');
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, repos: [], previewOpen: true })));
    expect(document.getElementById('o8-rail-usage-tooltip')).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-mcp-scope="compact-navigation-rail"]')?.style.opacity).toBe('0');
  } finally {
    window.removeEventListener('o8:open-handoffs', handoffs);
    await act(async () => root.unmount());
    host.remove();
  }
});
