/** Immutable authored-intent records; no current-pointer or dispatch mutation. */
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  IntentContractError, intentInputHash, isIntentIdentity, readAuthoredDocument,
  type ValidatedIntent,
} from '@/lib/orchestrator/aodl-validation';

export interface IntentContractRecord extends ValidatedIntent {
  schema: 'o8/intent-contract/v1';
  createdAt: string;
}

function recordPath(id: string, revision: number): string {
  if (!isIntentIdentity(id, revision)) throw new IntentContractError('invalid_intent_identity', 400);
  const key = createHash('sha256').update(id, 'utf8').digest('hex');
  return join(getDataDir(), 'intent-contracts', key, `${revision}.json`);
}

function checkRecord(value: unknown, id: string, revision: number): IntentContractRecord {
  if (!value || typeof value !== 'object') throw new IntentContractError('invalid_intent_record', 500);
  const record = value as IntentContractRecord;
  if (record.schema !== 'o8/intent-contract/v1' || !record.ref
    || record.ref.id !== id || record.ref.revision !== revision
    || typeof record.document !== 'string'
    || record.ref.inputSha256 !== intentInputHash(record.document)
    || !/^aodl-canon-1:[a-f0-9]{64}$/.test(record.ref.semanticFingerprint)
    || !/^[a-f0-9]{16}$/.test(record.ref.validatorRevision)
    || !/^[a-f0-9]{64}$/.test(record.ref.sourceHash)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new IntentContractError('invalid_intent_record', 500);
  }
  const doc = readAuthoredDocument(record.document);
  const provenance = doc.provenance as Record<string, unknown> | undefined;
  if (doc.graphId !== id || doc.revision !== revision || provenance?.sourceHash !== record.ref.sourceHash) {
    throw new IntentContractError('invalid_intent_record', 500);
  }
  return record;
}

export async function readIntentContract(id: string, revision: number): Promise<IntentContractRecord | null> {
  const path = recordPath(id, revision);
  try {
    return checkRecord(JSON.parse(await readFile(path, 'utf8')), id, revision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IntentContractError('invalid_intent_record', 500);
  }
}

export async function persistIntentContract(intent: ValidatedIntent): Promise<IntentContractRecord> {
  const record: IntentContractRecord = {
    schema: 'o8/intent-contract/v1', ...intent, createdAt: new Date().toISOString(),
  };
  checkRecord(record, intent.ref.id, intent.ref.revision);
  const path = recordPath(intent.ref.id, intent.ref.revision);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.pending-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic create-only publication. A partial write never occupies the revision.
    try {
      await link(temporary, path);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readIntentContract(intent.ref.id, intent.ref.revision);
      if (previous?.ref.inputSha256 === intent.ref.inputSha256
        && previous.ref.semanticFingerprint === intent.ref.semanticFingerprint
        && previous.ref.validatorRevision === intent.ref.validatorRevision) return previous;
      throw new IntentContractError('intent_revision_conflict', 409);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
