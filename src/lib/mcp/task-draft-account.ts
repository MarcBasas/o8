import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginPrincipal } from '@/lib/auth/plugin-token';
import { getDataDir } from '@/lib/data-dir-migration';
import { readCachedEntitlement, verifyLicense } from '@/lib/entitlement/license';
import { readActiveIdentity, readSignInEpoch } from '@/lib/github-broker/managed';
import { TaskDraftError } from './task-draft-contract';

export interface TaskDraftAccount { accountId: string; epoch: string }
type AccountAdmission = Pick<PluginPrincipal, 'accountId' | 'expiresAt'>;

function sameIdentity(principal: AccountAdmission, expected?: TaskDraftAccount): TaskDraftAccount {
  const epoch = readSignInEpoch();
  const accountId = principal.accountId;
  // Any persisted sign-out marker holds drafts, including old/unreadable markers.
  if (!accountId || !epoch || readActiveIdentity() !== accountId
    || existsSync(join(getDataDir(), 'auth-signed-out-at')) || principal.expiresAt <= Date.now()
    || (expected && (expected.accountId !== accountId || expected.epoch !== epoch))) {
    throw new TaskDraftError('account_changed_or_unavailable', 403);
  }
  return { accountId, epoch };
}

/** No offline grace or decoded client identity can admit a task draft. */
export async function requireTaskDraftAccount(principal: AccountAdmission, expected?: TaskDraftAccount): Promise<TaskDraftAccount> {
  const captured = sameIdentity(principal, expected);
  const token = readCachedEntitlement()?.licenseKey;
  if (!token) throw new TaskDraftError('account_changed_or_unavailable', 403);
  const verified = await verifyLicense(token, { offlineGrace: false });
  sameIdentity(principal, captured);
  if (!verified.valid || verified.subject !== captured.accountId
    || readCachedEntitlement()?.licenseKey !== token) {
    throw new TaskDraftError('account_changed_or_unavailable', 403);
  }
  return captured;
}
