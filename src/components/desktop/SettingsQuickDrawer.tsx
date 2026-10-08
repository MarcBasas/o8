'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  MessageSquare,
  Settings2,
} from './lucide-shims';
import { useTheme } from '@/lib/theme/context';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { OPEN_KEYBOARD_SHORTCUTS_EVENT, OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { ThemeContrastGlyph } from './settings-quick-drawer/theme-rows';
import { CapacityRows, capacitySummary } from './settings-quick-drawer/capacity-rows';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const POLL_MS = 30_000;
const DOCS_URL = 'https://o8.run';
// The canonical community invite — MUST match the README footer + o8.run
// (the drawer previously carried a different, stale invite).
const DISCORD_URL = 'https://o8.run/discord';
// Paint the floating surface directly. It can be a gradient in glass mode,
// which color-mix() cannot accept as a color argument.
const PANEL_BG = 'var(--t-popover-surface)';
const ROW_HOVER_BG = 'var(--t-panel-hover, rgba(15, 23, 42, 0.04))';
const SUBTLE_BG = 'var(--t-bg-card, rgba(15, 23, 42, 0.04))';
const BORDER = 'var(--t-panel-border, rgba(15, 23, 42, 0.1))';
const TEXT = 'var(--t-text, #0f172a)';
const MUTED = 'var(--t-text-muted, #64748b)';
const FAINT = 'color-mix(in srgb, var(--t-text-muted, #64748b) 62%, transparent)';

interface SettingsQuickDrawerProps {
  id?: string;
  open: boolean;
  anchorRect: DOMRect | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts?: () => void;
}

type UsageState =
  | { status: 'idle'; snapshot: null; error: null }
  | { status: 'loading'; snapshot: RuntimeCapacityControlSnapshot | null; error: null }
  | { status: 'ready'; snapshot: RuntimeCapacityControlSnapshot; error: null }
  | { status: 'error'; snapshot: RuntimeCapacityControlSnapshot | null; error: string };

function IconFrame({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        width: 17,
        height: 17,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: SUBTLE_BG,
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--t-panel-border, rgba(15,23,42,0.1)) 60%, transparent)',
        color: MUTED,
      }}
    >
      {children}
    </span>
  );
}

function RowButton({
  children,
  onClick,
  ariaExpanded,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaExpanded?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      disabled={disabled}
      aria-busy={disabled || undefined}
      style={{
        width: '100%',
        // border-box, or width:100% + the horizontal padding OVERFLOWS the
        // drawer body by 14px and every trailing value (⌘, / version /
        // chevrons) ends ~1px from the panel edge (operator live-hit
        // 2026-07-16: "numbers are too close to the edge").
        boxSizing: 'border-box',
        minHeight: 30,
        border: 0,
        borderRadius: 9,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 7,
        paddingRight: 7,
        background: 'transparent',
        color: 'inherit',
        cursor: disabled ? 'wait' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: FONT,
        fontSize: 11.5,
        textAlign: 'left',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = ROW_HOVER_BG;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

function separatorStyle(): CSSProperties {
  return {
    height: 1,
    width: '100%',
    background: BORDER,
  };
}

export function SettingsQuickDrawer({
  id,
  open,
  anchorRect,
  onClose,
  onOpenSettings,
  onOpenShortcuts,
}: SettingsQuickDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [usageState, setUsageState] = useState<UsageState>({ status: 'idle', snapshot: null, error: null });
  const { paletteId, workspaceGlass } = useTheme();
  const openSettingsTab = (tab: string) => {
    onClose();
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab } }));
  };
  // CLI usage telemetry is ungated (Q ruling 2026-07-31, supersedes the #1450
  // founders-mode visibility): it reads the operator's OWN local CLI files, so
  // neither an account nor an entitlement has any business gating it. The
  // /api/panel/cli-usage route stays operator-bearer gated as always.
  const [version, setVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'current' | 'available'>('idle');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => { /* not in Tauri */ });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus('checking');
    try {
      const { check } = await import('@/lib/app-update/check');
      const update = await check();
      if (update) {
        setUpdateStatus('available');
        // Surface the IN-APP update card (version + release note + install
        // button) instead of bouncing the operator to GitHub — the card is
        // the product surface for updates (operator report 2026-07-10).
        window.dispatchEvent(new CustomEvent('o8:update-found', {
          detail: {
            version: update.version,
            notes: update.body ?? undefined,
            date: update.date ?? undefined,
          },
        }));
        // The card mounts BEHIND this drawer's overlay — leaving the drawer
        // open made "Check for updates" feel like it did nothing (Q report
        // 2026-07-31). Found an update → get out of its way.
        window.setTimeout(onClose, 350);
      } else {
        setUpdateStatus('current');
        window.setTimeout(() => setUpdateStatus('idle'), 2600);
      }
    } catch {
      setUpdateStatus('idle');
    }
  }, [onClose]);

  const loadUsage = useCallback(async (preserveSnapshot = true, fresh = false) => {
    setUsageState((current) => ({
      status: 'loading',
      snapshot: preserveSnapshot ? current.snapshot : null,
      error: null,
    }));
    try {
      const res = await fetch(`/api/runtime/capacity${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data?.schema !== 'o8/runtime-capacity-control/v1') {
        throw new Error(data?.error || 'Capacity data unavailable');
      }
      setUsageState({ status: 'ready', snapshot: data as RuntimeCapacityControlSnapshot, error: null });
    } catch (err) {
      setUsageState((current) => ({
        status: 'error',
        snapshot: current.snapshot,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    if (!open || !usageOpen) return;
    void loadUsage();
    const timer = window.setInterval(() => {
      void loadUsage();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadUsage, open, usageOpen]);

  useEffect(() => {
    if (!open || !mounted) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? []);
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = focusable();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
    };
  }, [onClose, open, mounted]);

  const panelStyle = useMemo<CSSProperties>(() => {
    const viewportWidth = typeof window === 'undefined' ? 640 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 700 : window.innerHeight;
    const width = Math.max(246, Math.min(280, viewportWidth - 24));
    const leftFromAnchor = anchorRect?.left ?? 12;
    const left = Math.max(12, Math.min(leftFromAnchor, viewportWidth - width - 12));
    const bottomFromAnchor = anchorRect ? viewportHeight - anchorRect.top + 8 : 42;
    const bottom = Math.max(38, Math.min(bottomFromAnchor, Math.max(38, viewportHeight - 72)));
    return {
      position: 'fixed',
      left,
      bottom,
      width,
      maxWidth: 'calc(100vw - 24px)',
      maxHeight: 'min(340px, calc(100vh - 64px))',
      overflow: 'hidden',
      zIndex: 11000,
      borderRadius: 16,
      background: PANEL_BG,
      border: `1px solid ${BORDER}`,
      boxShadow: 'var(--t-panel-shadow, 0 24px 60px rgba(15, 23, 42, 0.1))',
      backdropFilter: 'blur(24px) saturate(150%)',
      WebkitBackdropFilter: 'blur(24px) saturate(150%)',
      color: TEXT,
      fontFamily: FONT,
    };
  }, [anchorRect]);

  const snapshot = usageState.snapshot;
  // No sign-in requirement here (Q ruling 2026-07-31): this is the operator's
  // OWN local CLI telemetry (~/.codex + Claude session files) — an account
  // adds nothing to reading your own disk.
  const usageSummary = snapshot
    ? capacitySummary(snapshot)
    : usageState.status === 'loading'
      ? 'Syncing'
      : 'Local runtimes';

  if (!mounted || !open) return null;

  return createPortal(
    <div
      data-settings-quick-drawer-root="true"
      style={{ position: 'fixed', inset: 0, zIndex: 10999, pointerEvents: 'auto' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div id={id} ref={panelRef} role="dialog" aria-modal="true" aria-label="Quick settings" style={panelStyle}>
        <div
          style={{
            maxHeight: 'inherit',
            overflowY: 'auto', scrollbarWidth: 'none',
            padding: 7,
            display: 'grid',
            gap: 4,
          }}
        >
          <RowButton onClick={() => openSettingsTab('account')}>
            <IconFrame><CircleUser size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Account</span>
            <ChevronRight size={12} color={MUTED} />
          </RowButton>

          <div style={separatorStyle()} />

          <RowButton onClick={onOpenSettings}>
            <IconFrame><Settings2 size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Settings</span>
            <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10, fontWeight: 300, letterSpacing: '0.5px' }}>⌘,</span>
          </RowButton>

          <RowButton onClick={() => openSettingsTab('appearance')}>
            <IconFrame><ThemeContrastGlyph /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Appearance</span>
            <span style={{ color: MUTED, fontSize: 10 }}>{workspaceGlass ? 'All Glass' : paletteId === 'light' ? 'Light Solid' : 'Dark Solid'}</span>
            <ChevronRight size={12} color={MUTED} />
          </RowButton>

          <div style={separatorStyle()} />

          <RowButton
            ariaExpanded={usageOpen}
            onClick={() => {
              setUsageOpen((value) => !value);
            }}
          >
            <IconFrame><Gauge size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Runtime capacity</span>
            <span
              style={{
                color: MUTED,
                fontFamily: MONO,
                fontSize: 9.5,
                whiteSpace: 'nowrap',
              }}
            >
              {usageSummary}
            </span>
            {usageOpen ? <ChevronDown size={12} color={MUTED} /> : <ChevronRight size={12} color={MUTED} />}
          </RowButton>

          {usageOpen ? (
            <CapacityRows
              snapshot={snapshot}
              loading={usageState.status === 'loading'}
              error={usageState.error}
              onRefresh={(fresh) => { void loadUsage(true, fresh); }}
            />
          ) : null}

          <div style={separatorStyle()} />

          <RowButton onClick={() => { void checkForUpdates(); }}>
            <IconFrame><Download size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Check for updates</span>
            <span
              style={{
                color: updateStatus === 'available' ? 'var(--t-brand-orange, #f97316)' : MUTED,
                fontFamily: MONO,
                fontSize: 9.5,
                fontWeight: 260,
                letterSpacing: '-0.2px',
                whiteSpace: 'nowrap',
              }}
            >
              {updateStatus === 'checking'
                ? 'Checking…'
                : updateStatus === 'available'
                  ? 'Update ready'
                  : updateStatus === 'current'
                    ? 'Up to date'
                    : version
                      ? `v${version}`
                      : ''}
            </span>
          </RowButton>

          <RowButton
            ariaExpanded={helpOpen}
            onClick={() => setHelpOpen((value) => !value)}
          >
            <IconFrame><BookOpen size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Get help</span>
            {helpOpen ? <ChevronDown size={12} color={MUTED} /> : <ChevronRight size={12} color={MUTED} />}
          </RowButton>

          {helpOpen ? (
            <div style={{ display: 'grid', gap: 2, paddingTop: 0, paddingRight: 4, paddingBottom: 3, paddingLeft: 28 }}>
              <RowButton onClick={() => {
                onClose();
                if (onOpenShortcuts) onOpenShortcuts();
                else window.dispatchEvent(new CustomEvent(OPEN_KEYBOARD_SHORTCUTS_EVENT));
              }}>
                <IconFrame><span aria-hidden="true" style={{ fontSize: 12 }}>?</span></IconFrame>
                <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Keyboard shortcuts</span>
                <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10 }}>⌘/</span>
              </RowButton>
              <RowButton onClick={() => openExternalUrl(DISCORD_URL)}>
                <IconFrame><MessageSquare size={13} /></IconFrame>
                <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Community Discord</span>
                <ExternalLink size={11} color={FAINT} />
              </RowButton>
              <RowButton onClick={() => openExternalUrl(DOCS_URL)}>
                <IconFrame><Globe size={13} /></IconFrame>
                <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Documentation</span>
                <ExternalLink size={11} color={FAINT} />
              </RowButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
