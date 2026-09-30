// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskActionMenu } from './TaskSection';
import type { TaskPoolTask } from './types';

const task = {
  id: 'packet-a', packetId: 'packet-a', title: 'Remote task', group: 'running', runtime: 'cloud',
  repoName: 'sample', execution: {
    kind: 'remote_worker', jobId: 'job-a', sessionKey: 'cloud:job-a', status: 'leased',
    attempt: 2, workerId: 'worker-b', leaseState: 'active', updatedAt: new Date().toISOString(),
    workspaceAccess: 'unavailable', previewAccess: 'unavailable',
  },
} as TaskPoolTask;

describe('Control Room remote evidence action', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
  });

  it('opens the selected packet attempt and renders its bounded receipts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      jobId: 'job-a',
      attempt: 2, status: 'leased', leaseState: 'active', logsTruncated: false, filesTruncated: false,
      logs: [{ id: 42, text: 'worker output', createdAt: new Date().toISOString() }],
      files: [{ path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(TaskActionMenu, {
      state: { task, x: 30, y: 30 }, busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask: vi.fn(),
    })));
    const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Remote logs & files');
    await act(async () => { open?.click(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/packet-a/evidence?jobId=job-a&attempt=2', { cache: 'no-store' });
    expect(container.textContent).toContain('worker output');
    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('Remote editor and preview are unavailable.');
  });

  it('uses the latest claim attempt after the task list refreshes', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(Response.json({
      jobId: 'job-a',
      attempt: url.includes('attempt=3') ? 3 : 2,
      status: 'leased', leaseState: 'active', logsTruncated: false, filesTruncated: false,
      logs: [{ id: 43, text: url.includes('attempt=3') ? 'new worker output' : 'old worker output', createdAt: new Date().toISOString() }],
      files: [],
    })));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const latestTask = { ...task, execution: { ...task.execution!, attempt: 3 } } as TaskPoolTask;
    const onRefreshTask = vi.fn(async () => {
      root?.render(createElement(TaskActionMenu, {
        state: { task: latestTask, x: 30, y: 30 }, busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask,
      }));
    });
    act(() => root?.render(createElement(TaskActionMenu, {
      state: { task, x: 30, y: 30 }, busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask,
    })));
    await act(async () => { [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Remote logs & files')?.click(); });
    await act(async () => { [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Refresh')?.click(); });
    expect(onRefreshTask).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/packet-a/evidence?jobId=job-a&attempt=3', { cache: 'no-store' });
    expect(container.textContent).toContain('new worker output');
  });
});
