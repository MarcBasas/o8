import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { IntentContractError, MAX_INTENT_BYTES, validateAodlIntent } from '@/lib/orchestrator/aodl-validation';
import { persistIntentContract, readIntentContract } from '@/lib/orchestrator/intent-contract-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, max-age=0' };

function denied(request: NextRequest) {
  const auth = requirePanelAuth(request);
  if (auth) return auth;
  if (resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ ok: false, error: 'operator_required' }, { status: 403, headers });
  }
  return null;
}

function failure(error: unknown) {
  return NextResponse.json({
    ok: false, error: error instanceof IntentContractError ? error.code : 'intent_storage_unavailable',
  }, { status: error instanceof IntentContractError ? error.status : 503, headers });
}

async function boundedBody(request: NextRequest): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new IntentContractError('invalid_intent_size', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INTENT_BYTES) {
        await reader.cancel();
        throw new IntentContractError('invalid_intent_size', 413);
      }
      chunks.push(value);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new IntentContractError('invalid_intent_json', 400); }
  } finally {
    reader.releaseLock();
  }
}

/** Stores a raw authored AODL document. It never creates or dispatches a mission. */
export async function POST(request: NextRequest) {
  const refusal = denied(request);
  if (refusal) return refusal;
  try {
    const intent = await validateAodlIntent(await boundedBody(request));
    const changed = denied(request);
    if (changed) return changed;
    const record = await persistIntentContract(intent);
    return NextResponse.json({ ok: true, record }, { status: 200, headers });
  } catch (error) { return failure(error); }
}

export async function GET(request: NextRequest) {
  const refusal = denied(request);
  if (refusal) return refusal;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  const rawRevision = request.nextUrl.searchParams.get('revision') ?? '';
  if (!/^(0|[1-9][0-9]*)$/.test(rawRevision)) {
    return failure(new IntentContractError('invalid_intent_identity', 400));
  }
  try {
    const record = await readIntentContract(id, Number(rawRevision));
    const changed = denied(request);
    if (changed) return changed;
    return NextResponse.json(record ? { ok: true, record } : { ok: false, error: 'intent_not_found' }, {
      status: record ? 200 : 404, headers,
    });
  } catch (error) { return failure(error); }
}
