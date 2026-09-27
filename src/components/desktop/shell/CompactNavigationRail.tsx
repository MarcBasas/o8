'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { SmoothCorners } from '@lisse/react';
import { AutoFlash, ControlSlider, Delivery, HomeSimple, InputSearch } from 'iconoir-react';
import { ArrowRight, CircleUser, Gauge, MessageSquare, MoreHorizontal, Play, Terminal } from '@/components/desktop/lucide-shims';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { useTheme } from '@/lib/theme/context';
import { historyIsVisibleForRepos, historyRepoContext } from '@/components/desktop/repo-focus/tabs/chats/helpers';
import { toRepoFocusRepo } from '@/components/desktop/repo-focus/types';
import type { ChatHistoryItem } from '@/components/desktop/repo-focus/tabs/chats/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import { WORKSPACE_RAIL_CORNER_RADIUS, WORKSPACE_RAIL_CORNER_SMOOTHING } from '@/components/desktop/branch-rail-geometry';

function chatInitials(title: string): string {
  return title.trim().split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '·';
}

function runtimeName(runtime: string): string {
  if (runtime === 'codex') return 'Codex';
  if (runtime === 'claude-code') return 'Claude';
  return runtime;
}

const railButton: CSSProperties = {
  position: 'relative',
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--t-text)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans-system)',
};

type RailNavAction = 'handoffs' | 'automations' | 'customize' | 'projects';

export function CompactNavigationRail({
  onHoverReveal,
  onHoverLeave,
  onPinSidebar,
  onHome,
  onCreateTerminal,
  onSearch,
  onOpenProjects,
  onOpenHistoryChat,
  repos,
  activeSessionKey,
  previewOpen,
}: {
  onHoverReveal: () => void;
  onHoverLeave: () => void;
  onPinSidebar: () => void;
  onHome: () => void;
  onCreateTerminal: () => void;
  onSearch: () => void;
  onOpenProjects?: () => void;
  onOpenHistoryChat: (tabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
  repos: RepoRegistryEntry[];
  activeSessionKey?: string | null;
  previewOpen: boolean;
}) {
  const auth = useO8Auth();
  const { surface, workspaceGlass } = useTheme();
  const isGlass = surface === 'glass' || workspaceGlass;
  const focusRepos = useMemo(() => repos.map(toRepoFocusRepo), [repos]);
  const [chats, setChats] = useState<ChatHistoryItem[]>([]);
  const [hoveredChatId, setHoveredChatId] = useState<string | null>(null);
  const [hoveredChatPosition, setHoveredChatPosition] = useState({ top: 0, left: 0 });
  const [usageOpen, setUsageOpen] = useState(false);
  const [usagePosition, setUsagePosition] = useState({ left: 0, bottom: 0 });
  const [usageSnapshot, setUsageSnapshot] = useState<RuntimeCapacityControlSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const usageCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredChat = chats.find((chat) => chat.tabId === hoveredChatId);
  const knownUsageRatios = usageSnapshot?.capacities.flatMap((capacity) =>
    capacity.status === 'available'
      ? capacity.buckets.flatMap((bucket) => typeof bucket.usedRatio === 'number' ? [bucket.usedRatio] : [])
      : [],
  ) ?? [];
  const highestKnownUsage = knownUsageRatios.length > 0 ? Math.max(...knownUsageRatios) : null;
  const usageMeterColor = highestKnownUsage !== null && highestKnownUsage >= 0.8
    ? 'var(--t-brand-orange)'
    : 'var(--t-accent)';
  const cancelUsageClose = useCallback(() => {
    if (usageCloseTimerRef.current) clearTimeout(usageCloseTimerRef.current);
    usageCloseTimerRef.current = null;
  }, []);
  const scheduleUsageClose = useCallback(() => {
    cancelUsageClose();
    usageCloseTimerRef.current = setTimeout(() => setUsageOpen(false), 160);
  }, [cancelUsageClose]);
  useEffect(() => () => cancelUsageClose(), [cancelUsageClose]);
  useEffect(() => {
    if (previewOpen) setUsageOpen(false);
  }, [previewOpen]);
  useEffect(() => {
    if (!usageOpen) return;
    const controller = new AbortController();
    const loadUsage = async () => {
      setUsageLoading(true);
      try {
        const response = await fetch('/api/runtime/capacity', { cache: 'no-store', signal: controller.signal });
        const payload = await response.json() as RuntimeCapacityControlSnapshot & { error?: string };
        if (!response.ok || payload.schema !== 'o8/runtime-capacity-control/v1') {
          throw new Error(payload.error || 'Runtime usage unavailable');
        }
        if (controller.signal.aborted) return;
        setUsageSnapshot(payload);
        setUsageError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setUsageError(error instanceof Error ? error.message : 'Runtime usage unavailable');
      } finally {
        if (!controller.signal.aborted) setUsageLoading(false);
      }
    };
    void loadUsage();
    const refresh = window.setInterval(() => { void loadUsage(); }, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [usageOpen]);
  const showUsage = (button: HTMLButtonElement) => {
    cancelUsageClose();
    const rect = button.getBoundingClientRect();
    setUsagePosition({
      left: Math.max(12, Math.min(rect.right + 16, window.innerWidth - 300)),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    });
    setUsageOpen(true);
  };
  const loadChats = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch('/api/v2/chat-history/list?include=orchestrator&archived=include', { cache: 'no-store', signal });
      if (!response.ok) return;
      const payload = await response.json() as { conversations?: ChatHistoryItem[] };
      if (signal.aborted) return;
      setChats((payload.conversations ?? [])
        .filter((chat) => !chat.archivedAt && historyIsVisibleForRepos(chat, focusRepos))
        .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
        .slice(0, 8));
    } catch {
      // The real AgentPanel owns the full history and can still load it on hover.
    }
  }, [focusRepos]);
  useEffect(() => {
    const controller = new AbortController();
    const initialLoad = window.setTimeout(() => { void loadChats(controller.signal); }, 0);
    const refresh = () => { void loadChats(controller.signal); };
    window.addEventListener('o8:chat-history-updated', refresh);
    return () => {
      window.clearTimeout(initialLoad);
      controller.abort();
      window.removeEventListener('o8:chat-history-updated', refresh);
    };
  }, [loadChats]);
  const openNav = (action: RailNavAction) => {
    if (action === 'projects') {
      onOpenProjects?.();
      return;
    }
    window.dispatchEvent(new CustomEvent(`o8:open-${action}`));
  };
  const navItems = [
    { id: 'handoffs', label: 'Handoffs', icon: <MessageSquare size={18} strokeWidth={1.8} /> },
    { id: 'automations', label: 'Automations', icon: <AutoFlash width={19} height={19} strokeWidth={1.8} /> },
    { id: 'customize', label: 'Customize', icon: <ControlSlider width={19} height={19} strokeWidth={1.8} /> },
    { id: 'projects', label: 'Projects', icon: <Delivery width={19} height={19} strokeWidth={1.8} /> },
  ] as const;

  return (
    <div
      data-mcp-scope="compact-navigation-rail"
      data-chrome-surface={isGlass ? 'true' : undefined}
      aria-label="Compact navigation with recent chats"
      onMouseLeave={() => { setHoveredChatId(null); onHoverLeave(); }}
      style={{
        position: 'fixed',
        top: 44,
        bottom: 44,
        left: 8,
        width: 56,
        zIndex: 190,
        // The preview's large bottom-left curve otherwise reveals a sliver
        // of this narrower rail underneath, even when their boxes align.
        opacity: previewOpen ? 0 : 1,
        transition: 'opacity 90ms ease',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 8,
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 16,
        background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
        backdropFilter: isGlass ? 'blur(24px) saturate(150%)' : undefined,
        WebkitBackdropFilter: isGlass ? 'blur(24px) saturate(150%)' : undefined,
        boxShadow: isGlass ? '0 12px 32px rgba(8, 12, 18, 0.14)' : '0 18px 44px rgba(8, 12, 18, 0.3)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <button type="button" aria-label="Home" title="Home · start a new chat" onClick={onHome} style={railButton}><HomeSimple width={20} height={20} strokeWidth={1.8} /></button>
      <button type="button" aria-label="New session" title="New session" onClick={onPinSidebar} style={railButton}><Play size={19} strokeWidth={1.8} /></button>
      <button type="button" aria-label="Terminal" title="Terminal" onClick={onCreateTerminal} style={railButton}><Terminal size={19} strokeWidth={1.8} /></button>
      <button type="button" aria-label="Search" title="Search" onClick={onSearch} style={railButton}><InputSearch width={20} height={20} strokeWidth={1.8} /></button>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0, flexShrink: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {navItems.map((item) => (
          <button key={item.id} type="button" aria-label={item.label} title={item.label} onClick={() => openNav(item.id)} style={{ ...railButton, flexShrink: 0 }}>{item.icon}</button>
        ))}
      </div>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div style={{ minHeight: 40, flex: '1 1 80px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {chats.map((chat) => (
          <button
            key={chat.tabId}
            type="button"
            aria-label={`Chat: ${chat.title}`}
            aria-describedby={hoveredChatId === chat.tabId && !previewOpen ? 'o8-rail-chat-tooltip' : undefined}
            onMouseEnter={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setHoveredChatPosition({ top: rect.top, left: rect.right + 16 }); setHoveredChatId(chat.tabId); }}
            onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setHoveredChatPosition({ top: rect.top, left: rect.right + 16 }); setHoveredChatId(chat.tabId); }}
            onMouseLeave={() => setHoveredChatId(null)}
            onClick={() => onOpenHistoryChat(chat.tabId, chat.title, historyRepoContext(chat))}
            style={{ ...railButton, flexShrink: 0, background: activeSessionKey?.includes(chat.tabId) ? 'var(--t-hover)' : 'color-mix(in srgb, var(--t-text-faint) 12%, transparent)' }}
          >
            <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px' }}>{chatInitials(chat.title)}</span>
            {chat.pinned || activeSessionKey?.includes(chat.tabId) ? <span aria-hidden="true" style={{ position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: '50%', background: activeSessionKey?.includes(chat.tabId) ? 'var(--t-accent)' : 'var(--t-brand-orange)' }} /> : null}
          </button>
        ))}
        <button type="button" aria-label="More chats" title="More chats · click to open full list" onClick={onPinSidebar} style={{ ...railButton, flexShrink: 0 }}><MoreHorizontal size={19} strokeWidth={1.8} /></button>
        <button type="button" aria-label="Preview full sidebar" title="Preview sidebar · click to keep open" onMouseEnter={onHoverReveal} onFocus={onHoverReveal} onClick={onPinSidebar} style={{ ...railButton, flexShrink: 0 }}><ArrowRight size={19} strokeWidth={1.8} /></button>
      </div>
      {hoveredChat && !previewOpen && typeof document !== 'undefined' ? createPortal(
        <div id="o8-rail-chat-tooltip" role="tooltip" style={{
          position: 'fixed',
          top: `min(${hoveredChatPosition.top}px, calc(100vh - 120px))`,
          left: hoveredChatPosition.left,
          width: 252,
          border: `1px solid ${isGlass ? 'var(--t-border)' : 'var(--t-divider-subtle)'}`,
          borderRadius: WORKSPACE_RAIL_CORNER_RADIUS,
          boxShadow: '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)',
          color: 'var(--t-text)',
          fontFamily: 'var(--font-sans-system)',
          pointerEvents: 'none',
          zIndex: 210,
          ...(isGlass ? {
            ['--t-text' as string]: '#e8ecf2',
            ['--t-text-secondary' as string]: '#bcc5d0',
            ['--t-text-muted' as string]: '#8b95a3',
            ['--t-text-faint' as string]: '#5f6b7a',
          } : {}),
        } as CSSProperties}>
          <SmoothCorners
            corners={{ radius: WORKSPACE_RAIL_CORNER_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
            autoEffects={false}
            style={{
              overflow: 'hidden',
              background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
              backdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
              WebkitBackdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
            } as CSSProperties}
          >
            <div style={{ paddingTop: 13, paddingRight: 14, paddingBottom: 13, paddingLeft: 14 }}>
              <div style={{ fontSize: 13.5, fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hoveredChat.title}</div>
              <div style={{ marginTop: 7, color: 'var(--t-text-muted)', fontSize: 10, fontWeight: 300 }}>{hoveredChat.repoName || 'Conversation'}</div>
              <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--t-divider-subtle)', color: isGlass ? 'var(--t-text-secondary)' : 'var(--t-text-faint)', fontSize: 10, fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hoveredChat.preview || 'Open this chat to continue'}</div>
            </div>
          </SmoothCorners>
        </div>,
        document.body,
      ) : null}
      <div style={{ width: 27, height: 1, marginTop: 5, marginBottom: 5, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <button
        type="button"
        aria-label="Runtime usage"
        aria-describedby={usageOpen && !previewOpen ? 'o8-rail-usage-tooltip' : undefined}
        title="Runtime usage"
        onMouseEnter={(event) => showUsage(event.currentTarget)}
        onMouseLeave={scheduleUsageClose}
        onFocus={(event) => showUsage(event.currentTarget)}
        onBlur={scheduleUsageClose}
        onKeyDown={(event) => { if (event.key === 'Escape') setUsageOpen(false); }}
        style={{ ...railButton, flexShrink: 0, color: highestKnownUsage !== null && highestKnownUsage >= 0.8 ? 'var(--t-brand-orange)' : 'var(--t-text-muted)' }}
      >
        <Gauge size={18} strokeWidth={1.7} />
        <span aria-hidden="true" style={{ position: 'absolute', bottom: 4, left: 14, width: 12, height: 2, borderRadius: 2, background: 'var(--t-divider-subtle)', overflow: 'hidden' }}>
          {highestKnownUsage !== null ? <span style={{ display: 'block', width: `${Math.max(0, Math.min(1, highestKnownUsage)) * 100}%`, height: '100%', background: usageMeterColor }} /> : null}
        </span>
      </button>
      {usageOpen && !previewOpen && typeof document !== 'undefined' ? createPortal(
        <div
          id="o8-rail-usage-tooltip"
          role="tooltip"
          data-mcp-scope="rail-usage-preview"
          onMouseEnter={cancelUsageClose}
          onMouseLeave={scheduleUsageClose}
          style={{
            position: 'fixed',
            left: usagePosition.left,
            bottom: usagePosition.bottom,
            width: 284,
            maxHeight: 'min(360px, calc(100vh - 24px))',
            border: `1px solid ${isGlass ? 'var(--t-border)' : 'var(--t-divider-subtle)'}`,
            borderRadius: WORKSPACE_RAIL_CORNER_RADIUS,
            boxShadow: '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)',
            color: 'var(--t-text)',
            fontFamily: 'var(--font-sans-system)',
            zIndex: 210,
            ...(isGlass ? {
              ['--t-text' as string]: '#e8ecf2',
              ['--t-text-secondary' as string]: '#bcc5d0',
              ['--t-text-muted' as string]: '#8b95a3',
            } : {}),
          } as CSSProperties}
        >
          <SmoothCorners
            corners={{ radius: WORKSPACE_RAIL_CORNER_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
            autoEffects={false}
            style={{
              maxHeight: 'min(360px, calc(100vh - 24px))',
              overflowY: 'auto', scrollbarWidth: 'none',
              background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
              backdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
              WebkitBackdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
            } as CSSProperties}
          >
            <div style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 400 }}>Runtime usage</span>
                <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{usageLoading ? 'Updating…' : usageSnapshot ? 'Local CLI data' : 'Loading…'}</span>
              </div>
              {usageSnapshot?.capacities.map((capacity, index) => (
                <div key={`${capacity.runtime}:${capacity.identityId ?? index}`} style={{ display: 'grid', gap: 7, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
                    <span>{runtimeName(capacity.runtime)}</span>
                    <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>
                      {capacity.status === 'stale' ? 'Stale' : capacity.status === 'available' ? capacity.confidence === 'exact' ? 'Exact' : 'Estimated' : 'Unavailable'}
                    </span>
                  </div>
                  {capacity.buckets.length > 0 ? capacity.buckets.map((bucket) => (
                    <div key={bucket.id} style={{ display: 'grid', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--t-text-secondary)', fontSize: 10.5 }}>
                        <span>{bucket.label}</span>
                        <span>{typeof bucket.usedRatio === 'number'
                          ? `${Math.round(bucket.usedRatio * 100)}% used`
                          : typeof bucket.remaining === 'number'
                            ? `${bucket.remaining} remaining`
                            : typeof bucket.used === 'number' && bucket.unit
                              ? `${bucket.used} ${bucket.unit} used`
                              : 'No quota total'}</span>
                      </div>
                      {typeof bucket.usedRatio === 'number' ? (
                        <div aria-hidden="true" style={{ height: 2, borderRadius: 2, background: 'var(--t-divider-subtle)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.max(0, Math.min(1, bucket.usedRatio)) * 100}%`, background: bucket.usedRatio >= 0.8 ? 'var(--t-brand-orange)' : 'var(--t-accent)' }} />
                        </div>
                      ) : null}
                    </div>
                  )) : <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>{capacity.reason?.replaceAll('_', ' ') ?? 'No observation'}</span>}
                </div>
              ))}
              {usageSnapshot?.capacities.length === 0 ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>No runtime capacity reported</span> : null}
              {!usageSnapshot && usageLoading ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>Reading connected runtimes…</span> : null}
              {usageError ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>{usageError}</span> : null}
            </div>
          </SmoothCorners>
        </div>,
        document.body,
      ) : null}
      <button
        type="button"
        aria-label={auth.signedIn ? 'Manage o8 account' : 'Sign in to o8'}
        title={auth.signedIn ? 'Manage o8 account' : auth.clerkEnabled ? 'Sign in to o8' : 'Sign in unavailable in this build'}
        onClick={() => { if (auth.signedIn) auth.openManageAccount(); else if (auth.clerkEnabled) auth.signIn(); }}
        style={{ ...railButton, flexShrink: 0, color: auth.signedIn ? 'var(--t-text)' : 'var(--t-text-muted)' }}
      >{auth.signedIn && auth.user?.avatarUrl ? <Image src={auth.user.avatarUrl} alt="" width={27} height={27} unoptimized style={{ width: 27, height: 27, borderRadius: '50%', objectFit: 'cover' }} /> : <CircleUser size={22} strokeWidth={1.7} />}</button>
    </div>
  );
}
