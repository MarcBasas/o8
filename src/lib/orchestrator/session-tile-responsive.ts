import { collectSessionLeaves, type SessionTileLayout, type SessionTileNode } from './session-tiles';

export type SessionTileViewportBand = 'wide' | 'balanced' | 'stacked';

export function sessionTileViewportBand(width: number): SessionTileViewportBand {
  if (width < 850) return 'stacked';
  if (width < 1350) return 'balanced';
  return 'wide';
}

function stackWorkers(workers: SessionTileNode[]): SessionTileNode {
  if (workers.length === 1) return workers[0]!;
  const leftCount = Math.floor(workers.length / 2);
  return {
    type: 'split',
    id: `responsive-${workers[0]!.id}-${workers[workers.length - 1]!.id}`,
    direction: 'horizontal',
    ratio: leftCount / workers.length,
    children: [stackWorkers(workers.slice(0, leftCount)), stackWorkers(workers.slice(leftCount))],
  };
}

function twoColumnWorkers(workers: SessionTileNode[]): SessionTileNode {
  const rows: SessionTileNode[] = [];
  for (let index = 0; index < workers.length; index += 2) {
    const first = workers[index]!;
    const second = workers[index + 1];
    rows.push(second ? {
      type: 'split',
      id: `responsive-row-${first.id}-${second.id}`,
      direction: 'vertical',
      ratio: 0.5,
      children: [first, second],
    } : first);
  }
  return stackWorkers(rows);
}

/** Rows are allowed to scroll independently of the full-height chat pane. */
export function compactWorkerScrollRows(layout: SessionTileLayout, band: SessionTileViewportBand): number {
  const root = layout.root;
  if (band === 'wide' || root.type !== 'split' || !root.autoGrid || root.manualOverride
    || root.direction !== 'vertical' || root.children[0].type !== 'leaf'
    || root.children[0].kind !== 'chat') return 0;
  const count = collectSessionLeaves(root).length;
  if (count <= 4) return 0;
  return band === 'stacked' ? count : Math.ceil(count / 2);
}

/** Presentation-only compact layout. The persisted tree and worker leaf IDs
 * stay unchanged, so widening the window restores the exact prior geometry. */
export function projectResponsiveAutomaticSessionTiles(
  layout: SessionTileLayout,
  band: SessionTileViewportBand,
): SessionTileLayout {
  const root = layout.root;
  if (band === 'wide' || root.type !== 'split' || !root.autoGrid || root.manualOverride
    || root.direction !== 'vertical' || root.children[0].type !== 'leaf'
    || root.children[0].kind !== 'chat') return layout;
  const workers = collectSessionLeaves(root);
  if (workers.length < 4) return layout;
  if (band === 'balanced') return {
    ...layout,
    root: {
      ...root,
      ratio: 0.32,
      children: workers.length > 4
        ? [root.children[0], twoColumnWorkers(workers)]
        : root.children,
    },
  };
  return {
    ...layout,
    root: {
      ...root,
      ratio: 0.42,
      children: [root.children[0], stackWorkers(workers)],
    },
  };
}
