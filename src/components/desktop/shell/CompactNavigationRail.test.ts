// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';

vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, clerkEnabled: false }) }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
afterEach(() => vi.unstubAllGlobals());

it('keeps navigation usable with the chat list open or closed and reads fresh usage', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = {
    onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onSearch: vi.fn(),
    onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onToggleSidebar: vi.fn(),
    onOpenPRs: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
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
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, sidebarVisible: true, activeDestination: 'projects', glassSurface: false })));
    expect(fetch).not.toHaveBeenCalled();
    expect(button('Projects').getAttribute('aria-current')).toBe('page');
    expect(button('Hide chats').getAttribute('aria-expanded')).toBe('true');
    expect(button('Hide chats').getAttribute('aria-controls')).toBe('o8-chat-list');
    for (const [label, callback] of [['Home', callbacks.onHome], ['New session', callbacks.onNewSession], ['Terminal', callbacks.onCreateTerminal], ['Search', callbacks.onSearch], ['Projects', callbacks.onOpenProjects], ['PRs', callbacks.onOpenPRs], ['Settings', callbacks.onOpenSettings], ['Hide chats', callbacks.onToggleSidebar]] as const) {
      await act(async () => button(label).click());
      expect(callback).toHaveBeenCalledOnce();
      expect(button(label).style.minWidth).toBe('44px');
      expect(button(label).style.minHeight).toBe('44px');
    }
    expect(button('Projects').nextElementSibling).toBe(button('PRs'));
    await act(async () => button('Handoffs').click());
    expect(handoffs).toHaveBeenCalledOnce();
    await act(async () => button('Runtime usage').focus());
    expect(document.getElementById('o8-rail-usage-tooltip')?.textContent).toContain('40% used');
    for (const scroller of host.querySelectorAll<HTMLElement>('[style*="overflow-y: auto"]')) expect(scroller.style.scrollbarWidth).toBe('none');
    await act(async () => button('Runtime usage').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.getElementById('o8-rail-usage-tooltip')).toBeNull();
    const rail = host.querySelector('[aria-label="Workspace navigation"]');
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, sidebarVisible: false, activeDestination: 'agents', glassSurface: true })));
    expect(host.querySelector('[aria-label="Workspace navigation"]')).toBe(rail);
    expect(button('Show chats').getAttribute('aria-expanded')).toBe('false');
    await act(async () => button('Show chats').click());
    expect(callbacks.onToggleSidebar).toHaveBeenCalledTimes(2);
    expect(button('Home').getAttribute('aria-current')).toBe('page');
    expect((rail as HTMLElement).style.background).toBe('transparent');
    expect((rail as HTMLElement).style.boxShadow).toBe('none');
    expect(fetch).toHaveBeenCalledWith('/api/runtime/capacity', expect.objectContaining({ cache: 'no-store' }));
  } finally {
    window.removeEventListener('o8:open-handoffs', handoffs);
    await act(async () => root.unmount());
    host.remove();
  }
});
