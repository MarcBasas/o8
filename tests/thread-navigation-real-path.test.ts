// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, expect, it, vi } from 'vitest';
import { O8ThreadsPane } from '@/components/desktop/o8-panel/O8ThreadsPane';
import { useThreadWorkspaceNavigation } from '@/components/desktop/o8-panel/useThreadNavigation';
import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import type { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const state = vi.hoisted(() => ({ projectId: '', repoPath: '' }));
vi.mock('@/components/desktop/orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] } }) }));
vi.mock('@/components/desktop/repo-registry/useProjects', () => ({ useProjects: () => ({
  activeProject: { id: state.projectId, name: 'Project', repoPaths: [state.repoPath] },
  ledger: { projects: [{ id: state.projectId, name: 'Project', repoPaths: [state.repoPath] }] }, loading: false,
}) }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-thread-navigation-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const route = await import('@/app/api/tasks/route');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { createProject } = await import('@/lib/projects/store');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

it('MCP product navigation mounts the persisted task without synthetic input or dispatch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const project = createProject({ name: 'Navigation fixture' });
  state.projectId = project.id; state.repoPath = join(dataDir, 'repo');
  const lane = createLane({ repoPath: state.repoPath, projectId: project.id, branch: 'test/navigation', runtime: 'codex', baseCommit: 'a'.repeat(40) });
  closeDb();
  const readTasks = async () => {
    const response = await route.GET(new NextRequest('http://localhost/api/tasks?includeDone=true', {
      headers: { Authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(response.status).toBe(200);
    return (await response.json()).tasks;
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/tasks?')) return new Response(JSON.stringify({ tasks: await readTasks() }));
    return new Response(JSON.stringify({ repos: [], logs: [], files: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [workspace, setWorkspace] = useState('other');
    useThreadWorkspaceNavigation({
      resolve: (target) => target.workspaceId === 'workspace' && target.repoPath === state.repoPath ? {
        projectId: project.id, activate: () => setWorkspace('workspace'), isActive: () => workspace === 'workspace',
      } : null,
      readTasks,
    });
    return createElement(O8ThreadsPane, { active: workspace === 'workspace', repoPath: state.repoPath,
      repos: [{ id: 'repo', localPath: state.repoPath, name: 'Repo' } as RepoRegistryEntry] });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const client = { evalJs: async (code: string) => ({ result: await new Function(`return ${code}`)() }) } as O8WebviewClient;
    const handlers = createO8WebviewToolHandlers(() => client);
    let result!: ReturnType<typeof handlers.o8_view_open_thread>;
    await act(async () => {
      result = handlers.o8_view_open_thread({ workspaceId: 'workspace', repoPath: state.repoPath, taskId: lane.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const receipt = await result;
    expect(receipt.isError).toBe(false);
    expect(JSON.parse((receipt.content[0] as { text: string }).text)).toMatchObject({ ok: true, status: 'mounted', taskId: lane.id, repoPath: state.repoPath });
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
    expect(getLane(lane.id)?.status).toBe(lane.status);
    expect((fetchMock.mock.calls as unknown[][]).every((call) => !call[1] || !(call[1] as RequestInit).method || (call[1] as RequestInit).method === 'GET')).toBe(true);
    const refused = await handlers.o8_view_open_thread({ workspaceId: 'workspace', repoPath: state.repoPath, taskId: 'missing' });
    expect(refused.isError).toBe(true);
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
