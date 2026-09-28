import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const pending = vi.hoisted(() => ({ gate: null as Promise<void> | null, launches: 0 }));
vi.mock('@/lib/lane/commands', () => ({
  dispatch: vi.fn(async () => {
    pending.launches += 1;
    if (pending.gate) await pending.gate;
    return { ok: true, laneId: 'lane-manual-claim-test', note: 'opened' };
  }),
}));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [], runtimes: [] })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-manual-claim-race-'));
const token = 'manual-claim-operator-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), token);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { closeDb, getSqlite } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const lanesRoute = await import('@/app/api/lanes/route');
const stateRoute = await import('@/app/api/orchestrator/state/route');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function request(pathname: string, body: unknown) {
  return new NextRequest(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seed(packetId: string, manualLaunchClaim: { token: string; ownerPid: number; startedAt: string } | null = null) {
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: `claim-${packetId}`, repoPath: dataDir,
    packets: [{
      id: packetId, referenceLabel: packetId, title: packetId, summary: 'fixture',
      workspaceTargetPath: dataDir, branchTarget: 'main', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
      releaseState: 'pending', status: 'queued', blockedReason: null, lane: null, review: null,
      manualLaunchClaim,
    }],
  });
}

describe('manual packet launch claim', () => {
  it('refuses a held packet opened through its own worker credential', async () => {
    const packetId = 'worker-held';
    seed(packetId);
    const mission = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({ ...mission, packets: [{
      ...mission.packets[0], queueState: 'held', holdIntent: 'operator',
    }] });
    const launchesBefore = pending.launches;
    const response = await lanesRoute.POST(new NextRequest('http://localhost/api/lanes', {
      method: 'POST',
      headers: { host: 'localhost', authorization: `Bearer ${mintPacketWorkerToken(packetId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'open_lane', packetId, repoPath: dataDir, branch: 'main', runtime: 'codex', actor: 'user' }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'packet_held' });
    expect(pending.launches).toBe(launchesBefore);
  });

  it('refuses a manual launch while the scheduler owns a storage reservation', async () => {
    const packetId = 'scheduler-reserved';
    seed(packetId);
    const now = Date.now();
    getSqlite().prepare(`
      INSERT INTO storage_admission_reservations (
        reservation_id, volume_id, target_path, exact_bytes, owner_id,
        owner_generation, generation, state, lease_expires_at,
        pre_measurement_json, last_mutation_id, last_reason, created_at, updated_at
      ) VALUES (?, 'fixture-volume', ?, 1, ?, 1, 1, 'reserved', ?, '{}', ?, 'admitted', ?, ?)
    `).run(`reservation:${packetId}`, dataDir, packetId, now + 60_000, `reserve:${packetId}`, now, now);
    const launchesBefore = pending.launches;
    const response = await lanesRoute.POST(request('/api/lanes', {
      verb: 'open_lane', packetId, repoPath: dataDir, branch: 'main', runtime: 'codex', actor: 'user',
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'already_launching' });
    expect(pending.launches).toBe(launchesBefore);
    expect(readOrchestratorControlPlaneState().packets[0]?.manualLaunchClaim).toBeNull();
  });

  it('strips a client-supplied claim when a whole-mission POST adds a packet', async () => {
    const packetId = 'client-supplied-claim';
    seed(packetId);
    const incoming = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({ ...incoming, packets: [] });
    const response = await stateRoute.POST(request('/api/orchestrator/state', {
      mission: {
        ...incoming,
        packets: [{ ...incoming.packets[0], manualLaunchClaim: {
          token: 'untrusted', ownerPid: 1, startedAt: new Date().toISOString(),
        } }],
      },
    }));
    expect(response.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]?.manualLaunchClaim).toBeNull();
  });

  it('keeps Hold refused while lane preparation awaits outside the control-plane lock', async () => {
    const packetId = 'manual-preparation';
    seed(packetId);
    const stale = readOrchestratorControlPlaneState();
    let release!: () => void;
    pending.gate = new Promise<void>((resolve) => { release = resolve; });
    const opening = lanesRoute.POST(request('/api/lanes', {
      verb: 'open_lane', packetId, repoPath: dataDir, branch: 'main', runtime: 'codex', actor: 'user',
    }));
    try {
      await vi.waitFor(() => expect(readOrchestratorControlPlaneState().packets[0]?.manualLaunchClaim?.token).toBeTruthy());
      const secondOpen = await lanesRoute.POST(request('/api/lanes', {
        verb: 'open_lane', packetId, repoPath: dataDir, branch: 'main', runtime: 'codex', actor: 'user',
      }));
      expect(secondOpen.status).toBe(409);
      expect(await secondOpen.json()).toMatchObject({ reason: 'already_launching' });
      expect((await stateRoute.POST(request('/api/orchestrator/state', { mission: stale }))).status).toBe(200);
      expect(readOrchestratorControlPlaneState().packets[0]?.manualLaunchClaim?.token).toBeTruthy();
      const hold = await stateRoute.PATCH(new NextRequest('http://localhost/api/orchestrator/state', {
        method: 'PATCH',
        headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ packetId, updates: { queueState: 'held', blockedReason: 'Held by operator' } }),
      }));
      expect(hold.status).toBe(409);
      expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
        queueState: 'queued', manualLaunchClaim: { ownerPid: process.pid },
      });
    } finally {
      release();
      pending.gate = null;
    }
    expect((await opening).status).toBe(200);
    expect(pending.launches).toBe(1);
    expect(readOrchestratorControlPlaneState().packets[0]?.manualLaunchClaim).toBeNull();
  });

  it('lets Hold recover a claim whose server process has exited', async () => {
    const packetId = 'dead-owner';
    seed(packetId, { token: 'dead-owner-claim', ownerPid: 2147483647, startedAt: new Date().toISOString() });
    const hold = await stateRoute.PATCH(new NextRequest('http://localhost/api/orchestrator/state', {
      method: 'PATCH',
      headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ packetId, updates: { queueState: 'held', blockedReason: 'Held by operator' } }),
    }));
    expect(hold.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      queueState: 'held', holdIntent: 'operator', manualLaunchClaim: null,
    });
  });
});
