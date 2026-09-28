import type { OrchestratorPacket } from './types';

export function normalizeManualLaunchClaim(value: unknown): OrchestratorPacket['manualLaunchClaim'] {
  if (!value || typeof value !== 'object') return null;
  const claim = value as Record<string, unknown>;
  return typeof claim.token === 'string' && claim.token.trim()
    && Number.isSafeInteger(claim.ownerPid) && Number(claim.ownerPid) > 0
    && typeof claim.startedAt === 'string' && claim.startedAt.trim()
    ? { token: claim.token, ownerPid: Number(claim.ownerPid), startedAt: claim.startedAt }
    : null;
}

/** A dead server process cannot still be preparing its manual lane. */
export function manualLaunchClaimIsLive(claim: OrchestratorPacket['manualLaunchClaim']): boolean {
  if (!claim) return false;
  if (typeof process === 'undefined' || typeof process.kill !== 'function') return true;
  try {
    process.kill(claim.ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function manualLaunchClaimAppeared(
  current: OrchestratorPacket | undefined,
  before: OrchestratorPacket | undefined,
): boolean {
  return Boolean(current?.manualLaunchClaim && current.manualLaunchClaim.token !== before?.manualLaunchClaim?.token);
}
