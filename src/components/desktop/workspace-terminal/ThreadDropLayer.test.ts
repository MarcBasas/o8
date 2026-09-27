// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSessionToLayout, collectSessionLeaves, createDefaultSessionTileLayout } from '@/lib/orchestrator/session-tiles';
import { projectResponsiveAutomaticSessionTiles } from '@/lib/orchestrator/session-tile-responsive';
import { THREAD_DRAG_END_EVENT, THREAD_DRAG_START_EVENT } from '@/lib/workspace-terminal/thread-drag';
import { ThreadDropLayer } from './ThreadDropLayer';

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe('ThreadDropLayer compact worker targets', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('drops onto the worker at its scrolled visible position, not its unscrolled tree position', async () => {
    const source = Array.from({ length: 10 }, (_, index) => `worker:${index + 1}`)
      .reduce((layout, key) => addSessionToLayout(layout, key), createDefaultSessionTileLayout());
    const worker = collectSessionLeaves(source.root).at(-1)!;
    const layout = projectResponsiveAutomaticSessionTiles(source, 'balanced');
    const onDrop = vi.fn();

    await act(async () => {
      root.render(createElement('div', null,
        createElement('div', { 'data-session-tile-surface': 'true' },
          createElement('div', { 'data-session-tile-leaf-id': worker.id })),
        createElement(ThreadDropLayer, { active: true, layout, onDrop, useRenderedLeafRects: true }),
      ));
    });

    const overlay = host.querySelector<HTMLElement>('[data-thread-drop-layer]')!;
    const pane = host.querySelector<HTMLElement>('[data-session-tile-leaf-id]')!;
    overlay.getBoundingClientRect = () => box(0, 0, 1000, 800);
    pane.getBoundingClientRect = () => box(700, 200, 280, 240);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(THREAD_DRAG_START_EVENT, {
        detail: {
          payload: { threadId: 'thread:one', title: 'One', mode: 'orchestrator' },
          clientX: 800,
          clientY: 220,
        },
      }));
      window.dispatchEvent(new CustomEvent(THREAD_DRAG_END_EVENT, {
        detail: { clientX: 800, clientY: 220 },
      }));
    });

    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'replace',
      leafId: worker.id,
      thread: expect.objectContaining({ threadId: 'thread:one' }),
    }));
  });
});
