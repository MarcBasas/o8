'use client';

/**
 * PanelHeaderStrip — header strip for the right (O8 / Review) panel column.
 * Hosts the O8 tab bar plus the browser and right-panel-morph controls.
 * Part of epic #1089.
 */

import type { ReactNode } from 'react';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { O8HeaderTabs } from '../o8-panel/O8HeaderTabs';
import type { O8Tab } from '../o8-panel/types';
import { ApprovalInboxBadge } from '../title-bar/ApprovalInboxBadge';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';

interface PanelHeaderStripProps {
  o8PanelVisible?: boolean;
  workspacePanelVisible?: boolean;
  onToggleO8Panel?: () => void;
  o8ActiveTab?: O8Tab;
  onO8TabChange?: (tab: O8Tab) => void;
  splitEnabled?: boolean;
  onToggleSplit?: () => void;
  approvalCount?: number;
  onOpenInbox?: () => void;
  /** Portal target for the browser's page tabs + URL well (Cursor header
   *  borrow, Q 2026-07-12): the browser's whole top chrome renders HERE in
   *  the strip's flex center, walled off from the state drawer by a hairline
   *  divider. The standalone globe button is retired — the drawer's Browser
   *  entry (orange globe when active) is the surface's one handle. */
  browserTabsSlotRef?: (node: HTMLElement | null) => void;
  showBrowserTabs?: boolean;
  prTabsSlot?: ReactNode;
}

export function PanelHeaderStrip({
  o8PanelVisible = false,
  workspacePanelVisible = false,
  onToggleO8Panel,
  o8ActiveTab = 'workspace',
  onO8TabChange,
  splitEnabled = false,
  onToggleSplit,
  approvalCount = 0,
  onOpenInbox,
  browserTabsSlotRef,
  showBrowserTabs = false,
  prTabsSlot,
}: PanelHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      center={onO8TabChange ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
          {prTabsSlot}
          {showBrowserTabs && browserTabsSlotRef ? <div ref={browserTabsSlotRef} data-no-drag style={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexShrink: 1, overflow: 'hidden', ['WebkitAppRegion' as string]: 'no-drag' }} /> : null}
          <O8HeaderTabs activeTab={o8ActiveTab} onTabChange={onO8TabChange} opener onNewPage={() => { onO8TabChange('browser'); window.dispatchEvent(new CustomEvent('o8:browser-new-page')); }} />

        </div>
      ) : null}
      right={
        <>
          {onOpenInbox ? (
            <ApprovalInboxBadge count={approvalCount} onClick={onOpenInbox} />
          ) : null}
          {onToggleSplit ? <button type="button" onClick={onToggleSplit} aria-label={splitEnabled ? 'Close right panel split' : 'Split right panel'} aria-pressed={splitEnabled} title={splitEnabled ? 'Show one panel view' : 'Show two panel views'} data-no-drag style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: splitEnabled ? '1px solid var(--t-divider)' : '1px solid transparent', borderRadius: 7, background: splitEnabled ? 'var(--t-panel-hover)' : 'transparent', color: splitEnabled ? 'var(--t-text)' : 'var(--t-text-muted)', cursor: 'pointer', ['WebkitAppRegion' as string]: 'no-drag' }}>
            <span aria-hidden style={{ display: 'block', position: 'relative', width: 16, height: 16, flexShrink: 0, border: '1.8px solid currentColor', borderRadius: 4 }}><span style={{ position: 'absolute', top: '50%', left: 0, right: 0, borderTop: '1.8px solid currentColor' }} /></span>
          </button> : null}
          <RightPanelMorphButton
            workspacePanelVisible={workspacePanelVisible}
            o8PanelVisible={o8PanelVisible}
            onToggleO8Panel={onToggleO8Panel}
          />
        </>
      }
    />
  );
}
