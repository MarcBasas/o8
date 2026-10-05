import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { readWorkspacePreservation, verifyPreservedArtifactsAtPath } from './preservation-store';
import { getWorkspaceRetirementPreservationId } from './workspace-materialization-retirement';
import { admitStandaloneRetirement, verifyStandaloneRetirement } from './standalone-retirement-authority';

export type ManagedRetirementReason = 'terminal' | 'creation-rollback' | 'empty-orphan';

export async function admitRetirementAuthority(input: {
  repositoryPath: string;
  worktreeId: string;
  directoryPath: string;
  identity: WorktreeMaterializationIdentity;
  reason: ManagedRetirementReason;
}): Promise<Record<string, unknown>> {
  if (input.reason === 'empty-orphan') return { retirementReason: input.reason };
  if (input.reason === 'creation-rollback') {
    const metadata = (await readWorktreeMetaSnapshot(input.repositoryPath))[input.worktreeId];
    if (!metadata || metadata.claudeManaged
      || (metadata.status !== 'creating' && metadata.status !== 'setup') || !metadata.creationOwner
      || metadata.materializationIdentity?.device !== input.identity.device
      || metadata.materializationIdentity.inode !== input.identity.inode) {
      throw new Error('Creation rollback has no matching durable creation authority.');
    }
    const authority = { retirementReason: input.reason, creationOwner: metadata.creationOwner,
      repositoryPath: canonicalRepoRoot(input.repositoryPath), worktreeId: input.worktreeId,
      sourceDevice: input.identity.device, sourceInode: input.identity.inode };
    await verifyCreationAuthority(authority);
    return authority;
  }
  const preservationId = getWorkspaceRetirementPreservationId(input.directoryPath);
  if (!preservationId) return admitStandaloneRetirement(input);
  const { payload } = await readWorkspacePreservation(preservationId);
  if (canonicalRepoRoot(payload.repositoryPath) !== canonicalRepoRoot(input.repositoryPath)
    || payload.worktreeId !== input.worktreeId || payload.identity.device !== input.identity.device
    || payload.identity.inode !== input.identity.inode) {
    throw new Error('Terminal preservation belongs to another exact workspace owner.');
  }
  return { retirementReason: 'terminal', preservationId };
}

async function verifyCreationAuthority(authority: Record<string, unknown>): Promise<void> {
  const owner = authority.creationOwner as { pid?: unknown; identity?: unknown } | undefined;
  if (!owner || typeof owner.pid !== 'number' || !isMetadataLockProcessIdentity(owner.identity)) {
    throw new Error('Creation retirement lost its durable process owner.');
  }
  if (typeof authority.repositoryPath !== 'string' || typeof authority.worktreeId !== 'string') {
    throw new Error('Creation retirement has no durable manager identity.');
  }
  const metadata = (await readWorktreeMetaSnapshot(authority.repositoryPath))[authority.worktreeId];
  const identity = metadata?.materializationIdentity;
  if (!metadata || metadata.claudeManaged || (metadata.status !== 'creating' && metadata.status !== 'setup')
    || metadata.creationOwner?.pid !== owner.pid || !metadata.creationOwner
    || !sameMetadataLockProcessIdentity(metadata.creationOwner.identity, owner.identity)
    || !identity || identity.device !== authority.sourceDevice || identity.inode !== authority.sourceInode) {
    throw new Error('Creation retirement manager authority changed after admission.');
  }
  const observed = await probeMetadataLockProcessIdentity(owner.pid);
  if (observed.state === 'unknown'
    || (observed.state === 'live' && sameMetadataLockProcessIdentity(observed.identity, owner.identity)
      && owner.pid !== process.pid)) {
    throw new Error('Creation retirement still has a live or unknown creator.');
  }
}

export async function verifyRetirementAuthority(input: {
  authority: Record<string, unknown> | null;
  sourcePath: string;
  candidatePath: string;
  identity: WorktreeMaterializationIdentity;
  verifyContents: boolean;
}): Promise<void> {
  const reason = input.authority?.retirementReason;
  if (reason === 'standalone-clean') return verifyStandaloneRetirement({ ...input, authority: input.authority! });
  if (reason === 'creation-rollback') return verifyCreationAuthority(input.authority!);
  if (reason === 'empty-orphan') return;
  const preservationId = input.authority?.preservationId;
  if (reason !== 'terminal' || typeof preservationId !== 'string'
    || getWorkspaceRetirementPreservationId(input.sourcePath) !== preservationId) {
    throw new Error('Exact retirement lacks its durable preservation or creation reason.');
  }
  const { receipt } = await readWorkspacePreservation(preservationId);
  if (receipt.sourceDevice !== input.identity.device || receipt.sourceInode !== input.identity.inode) {
    throw new Error('Exact retirement preservation materialization changed.');
  }
  if (input.verifyContents) {
    await verifyPreservedArtifactsAtPath(preservationId, input.candidatePath, {
      ...input.identity, canonicalPath: input.candidatePath,
    });
  }
}
