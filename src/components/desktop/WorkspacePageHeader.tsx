'use client';

import type { ReactNode } from 'react';
import { RamsButton } from './settings/shared';

export const WORKSPACE_PAGE_TOP_PADDING = 72;
export const WORKSPACE_PAGE_MAX_WIDTH = 1040;

/** Shared heading and exit position for the workspace's full-page views. */
export function WorkspacePageHeader({ title, subtitle, onClose, children }: {
  title: string;
  subtitle: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 16,
      marginBottom: 32,
    }}>
      <div style={{ minWidth: 0, flex: '1 1 320px' }}>
        <h1 style={{
          marginTop: 0,
          marginRight: 0,
          marginBottom: 10,
          marginLeft: 0,
          color: 'var(--t-text)',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: '-0.045em',
          lineHeight: 1.08,
        }}>
          {title}
        </h1>
        <p style={{
          maxWidth: 640,
          marginTop: 0,
          marginRight: 0,
          marginBottom: 0,
          marginLeft: 0,
          color: 'var(--t-text-faint)',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 13.5,
          fontWeight: 300,
          letterSpacing: '-0.005em',
          lineHeight: 1.55,
        }}>
          {subtitle}
        </p>
      </div>
      {(children || onClose) ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
          {children}
          {onClose ? <RamsButton variant="ghost" onClick={onClose}>Back to workspace</RamsButton> : null}
        </div>
      ) : null}
    </header>
  );
}
