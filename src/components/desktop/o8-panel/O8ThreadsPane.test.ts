// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { O8ThreadsPane } from './O8ThreadsPane';
import { O8HeaderTabs } from './O8HeaderTabs';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';

const context = vi.hoisted(() => ({
  activeProjectId: 'project', agents: [], missionState: { packets: [] }, onSelectSession: vi.fn(),
}));
const projectState = vi.hoisted(() => ({
  activeProject: { id: 'project', name: 'Project', repoPaths: ['/repo'] },
  ledger: { projects: [{ id: 'project', name: 'Project', repoPaths: ['/repo'] }, { id: 'focused-project', name: 'Focused project', repoPaths: ['/other'] }] },
  loading: false,
}));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => context }));
vi.mock('../repo-registry/useProjects', () => ({ useProjects: () => projectState }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>) }));

const repo = { id: 'repo', name: 'Repo', localPath: '/repo', defaultBranch: 'main', remoteUrl: null } as RepoRegistryEntry;
const task = (id: string, group: TaskPoolTask['group'] = 'running', repoPath = '/repo') => ({
  id, packetId: `packet-${id}`, title: id, summary: 'Recorded summary', group, status: group === 'done' ? 'completed' : group,
  runtime: 'cloud', repoPath, project: { id: 'project' }, lastEventLabel: 'remote_job_completed',
  workerRouting: { selectedRuntime: 'cloud', selectedModel: 'gpt-6.1-sol', selectedEffort: 'medium' },
  lane: { sessionKey: `session-${id}` },
} as TaskPoolTask);
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('contextual thread panel navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    context.onSelectSession.mockClear();
    fetchMock = vi.fn(async () => json({ tasks: [task('Live'), task('Finished', 'done'), { ...task('Other', 'running', '/other'), project: { id: 'focused-project' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const show = async (repoPath = '/repo', active = true) => {
    await act(async () => { root.render(createElement(O8ThreadsPane, { active, repoPath, repos: [repo, { ...repo, localPath: '/other' }] })); });
  };
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!;

  it('opens Threads through the panel header, without changing the workspace', async () => {
    const onTabChange = vi.fn();
    await act(async () => root.render(createElement(O8HeaderTabs, { activeTab: 'workspace', onTabChange })));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Panel view: Workspace"]')!.click());
    const entry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes('Threads') && node.getAttribute('role') === 'menuitem');
    expect(entry).toBeDefined();
    act(() => entry!.click());
    expect(onTabChange).toHaveBeenCalledWith('threads');
    expect(context.onSelectSession).not.toHaveBeenCalled();
  });

  it('groups scoped tasks, collapses resolved, and reads detail without replacing a session', async () => {
    await show();
    expect(container.textContent).toContain('gpt-6.1-sol · medium');
    expect(container.textContent).not.toContain('remote_job_completed');
    expect(container.querySelector('[aria-label="View thread Other"]')).toBeNull();
    expect(container.querySelector('[aria-label="View thread Finished"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Live"]')!.click());
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
    expect(container.textContent).toContain('Remote worker');
    expect(context.onSelectSession).not.toHaveBeenCalled();
    act(() => button('Threads').click());
    expect(container.querySelector('[aria-label="View thread Live"]')).not.toBeNull();
  });

  it('discards a delayed old-scope response and does not fetch an inactive panel', async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    await show();
    await show('/other');
    await act(async () => { resolveOld(json({ tasks: [task('Old scope')] })); });
    expect(container.textContent).not.toContain('Old scope');
    expect(container.querySelector('[aria-label="View thread Other"]')).not.toBeNull();
    const count = fetchMock.mock.calls.length;
    await show('/other', false);
    expect(fetchMock.mock.calls.length).toBe(count);
  });

  it('follows the focused workspace project without changing the globally selected project', async () => {
    await show('/other');
    expect(container.textContent).toContain('Focused project');
    expect(container.querySelector('[aria-label="View thread Other"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="View thread Live"]')).toBeNull();
    expect(projectState.activeProject.id).toBe('project');
  });

  it('loads registered membership for a focused repository outside the global project', async () => {
    fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos'
      ? json({ repos: [{ ...repo, id: 'other-repo', localPath: '/other' }] })
      : json({ tasks: [{ ...task('Other', 'running', '/other'), project: { id: 'focused-project' } }] }));
    await act(async () => root.render(createElement(O8ThreadsPane, { active: true, repoPath: '/other', repos: [repo] })));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Create thread"]')!.disabled).toBe(false);
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/panel/repos')).toBe(true);
    expect(projectState.activeProject.id).toBe('project');
  });

  it('asks for inline confirmation before removing a thread', async () => {
    fetchMock.mockResolvedValueOnce(json({ tasks: [task('Waiting', 'blocked')] }));
    await show();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Waiting"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Actions for Waiting"]')!.click());
    expect(container.querySelectorAll('[aria-label="Steer this thread"]')).toHaveLength(1);
    act(() => button('Un-queue / remove').click());
    expect(container.querySelectorAll('[aria-label="Steer this thread"]')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/remove'))).toHaveLength(0);
    expect(container.textContent).toContain('Un-queue “Waiting”?');
    act(() => button('Cancel').click());
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/remove'))).toHaveLength(0);
  });

  it('shows only evidence from the current execution attempt', async () => {
    const running = { ...task('Remote'), execution: { jobId: 'job', attempt: 2 } };
    fetchMock.mockResolvedValueOnce(json({ tasks: [running] })).mockResolvedValueOnce(json({ jobId: 'job', attempt: 1, logs: [{ id: 1, text: 'Previous attempt output' }], files: [] }));
    await show();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View thread Remote"]')!.click());
    expect(container.textContent).toContain('Attempt 2');
    expect(container.textContent).not.toContain('Previous attempt output');
    expect(fetchMock.mock.calls.some((call) => call[0].includes('jobId=job&attempt=2'))).toBe(true);
  });

  it('waits for the persisted steer outcome and reuses one message id while pending', async () => {
    await show();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Live"]')!.click());
    const field = container.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Check the result');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    fetchMock.mockResolvedValueOnce(json({ ok: true, inProgress: true }, 202)).mockResolvedValueOnce(json({ ok: true, result: { note: 'Queued for this worker' } }));
    await act(async () => { button('Send').click(); await new Promise((resolve) => setTimeout(resolve, 850)); });
    const requests = fetchMock.mock.calls.filter((call) => call[0] === '/api/orchestrator/steer-packet');
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0][1].body)).toMatchObject({ packetId: 'packet-Live', message: 'Check the result' });
    expect(requests[0][1].body).toBe(requests[1][1].body);
    expect(container.textContent).toContain('Queued for this worker');
    expect(context.onSelectSession).not.toHaveBeenCalled();
  });
});
