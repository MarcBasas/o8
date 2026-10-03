/** Read-only, opt-in boundary to AODL's canonical Python implementation. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const MAX_INTENT_BYTES = 128 * 1024;
const MAX_REPLY_BYTES = 128 * 1024;
const VALIDATOR_TIMEOUT_MS = 3_000;
const HASH = /^[a-f0-9]{64}$/;
const GRAPH_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export class IntentContractError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export interface IntentContractRef {
  id: string;
  revision: number;
  sourceHash: string;
  semanticFingerprint: string;
  validatorRevision: string;
  inputSha256: string;
}

export interface ValidatedIntent {
  ref: IntentContractRef;
  document: string;
}

export function intentInputHash(document: string): string {
  return createHash('sha256').update(document, 'utf8').digest('hex');
}

export function isIntentIdentity(id: unknown, revision: unknown): boolean {
  return typeof id === 'string' && GRAPH_ID.test(id)
    && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
}

export function readAuthoredDocument(document: string): Record<string, unknown> {
  if (!document || Buffer.byteLength(document, 'utf8') > MAX_INTENT_BYTES) {
    throw new IntentContractError('invalid_intent_size', 400);
  }
  let value: unknown;
  try { value = JSON.parse(document); } catch { throw new IntentContractError('invalid_intent_json', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntentContractError('invalid_intent_document', 400);
  }
  const doc = value as Record<string, unknown>;
  if (!isIntentIdentity(doc.graphId, doc.revision)) {
    throw new IntentContractError('invalid_intent_identity', 400);
  }
  // This is an authored-document boundary, not a competing HOTL validator.
  if (['plan', 'eventLog', 'observedGraph'].some((key) => key in doc)) {
    throw new IntentContractError('runtime_projection_not_authored_intent', 400);
  }
  return doc;
}

function runValidator(command: string, cwd: string, document: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-m', 'aodl_contract.cli', '--fingerprint', '--json', '-'], {
      cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const fail = (code: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new IntentContractError(code, 503));
    };
    const timer = setTimeout(() => fail('aodl_validator_timeout'), VALIDATOR_TIMEOUT_MS);
    child.on('error', () => fail('aodl_validator_unavailable'));
    child.stdin.on('error', () => fail('aodl_validator_unavailable'));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES) return fail('aodl_reply_too_large');
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES) fail('aodl_reply_too_large');
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.end(document, 'utf8');
  });
}

export async function validateAodlIntent(document: string): Promise<ValidatedIntent> {
  const doc = readAuthoredDocument(document);
  // Configuration is host-owned. Neither command nor cwd comes from a request.
  const command = process.env.O8_AODL_PYTHON;
  const cwd = process.env.O8_AODL_SOURCE_DIR;
  const revision = process.env.O8_AODL_VALIDATOR_REVISION;
  if (!command || !cwd || !isAbsolute(command) || !isAbsolute(cwd)
    || !revision || !/^[a-f0-9]{16}$/.test(revision)) {
    throw new IntentContractError('aodl_not_configured', 503);
  }
  const reply = await runValidator(command, cwd, document);
  let parsed: unknown;
  try { parsed = JSON.parse(reply.output); } catch { throw new IntentContractError('invalid_aodl_reply', 503); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IntentContractError('invalid_aodl_reply', 503);
  }
  const result = parsed as Record<string, unknown>;
  const inputSha256 = intentInputHash(document);
  if (result.schema !== 'aodl.validation.v1' || result.wireSpec !== 'hotl-0.2'
    || result.validatorRevision !== revision || result.inputSha256 !== inputSha256) {
    throw new IntentContractError('aodl_identity_mismatch', 503);
  }
  if (reply.code === 1 || reply.code === 2) throw new IntentContractError('aodl_rejected', 400);
  if (reply.code !== 0 || result.ok !== true || result.error !== null
    || !Array.isArray(result.issues) || result.issues.length !== 0
    || result.canonicalVersion !== 'aodl-canon-1'
    || typeof result.semanticFingerprint !== 'string'
    || !/^aodl-canon-1:[a-f0-9]{64}$/.test(result.semanticFingerprint)) {
    throw new IntentContractError('invalid_aodl_reply', 503);
  }
  const provenance = doc.provenance as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance.sourceHash !== 'string' || !HASH.test(provenance.sourceHash)) {
    throw new IntentContractError('invalid_intent_provenance', 400);
  }
  return {
    document,
    ref: {
      id: doc.graphId as string, revision: doc.revision as number,
      sourceHash: provenance.sourceHash, semanticFingerprint: result.semanticFingerprint,
      validatorRevision: revision, inputSha256,
    },
  };
}
