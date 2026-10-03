import { MAX_COMPOSER_IMAGES, type FileUploadHandler } from '@/lib/hooks/use-file-drop';
import { MAX_AGENT_IMAGE_BYTES, imageCorrelation, imageRequestId, validateImageAttachment, type ImageAttachmentReceipt, type ImageAttachmentRequest } from './image-attachment';

interface Image { name: string; mimeType: string; dataUri: string; uploadRequestId?: string }
export interface ImageComposerSnapshot { element: HTMLElement | null; images: readonly Image[]; upload?: FileUploadHandler }
interface Target { id: string; current: () => ImageComposerSnapshot; live: boolean }
interface ReceiptRecord { receipt: ImageAttachmentReceipt; expires: number; target?: Target; dataUri?: string }
const targets = new Set<Target>();
const receipts = new Map<string, ReceiptRecord>();
const READ_DEADLINE_MS = 20_000;

function available(target: Target): boolean {
  const { element, upload } = target.current();
  const input = element?.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer="true"]');
  if (!target.live || !element?.isConnected || !input || input.disabled || !upload || document.visibilityState === 'hidden') return false;
  const rect = input.getBoundingClientRect();
  const style = window.getComputedStyle(input);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}
function active(): Target | undefined {
  const matches = [...targets].filter(available);
  return matches.length === 1 ? matches[0] : undefined;
}
function finish(record: ReceiptRecord, code?: string) {
  record.receipt = { ...record.receipt, status: code ? 'error' : 'completed', ...(code ? { code } : {}) };
  delete record.dataUri;
  delete record.target;
}
export function observeImageAttachments() {
  for (const record of receipts.values()) {
    if (record.receipt.status !== 'pending') continue;
    if (!record.target || !available(record.target) || active() !== record.target) { finish(record, 'target_changed'); continue; }
    if (Date.now() >= record.expires) { finish(record, 'upload_expired'); continue; }
    const matched = record.target.current().images.some(image => image.uploadRequestId === record.receipt.request_id && image.name === record.receipt.filename && image.dataUri === record.dataUri);
    if (matched) finish(record);
  }
}
function error(code: string, request?: Partial<ImageAttachmentRequest>) {
  return { status: 'error' as const, code, ...(request ? { request_id: request.request_id, composer_id: request.composer_id } : {}) };
}
export const composerImageBridge = {
  inspect() {
    const target = active();
    if (!target) return error('no_active_composer');
    return { status: 'ready', composer_id: target.id, image_count: target.current().images.length, max_images: MAX_COMPOSER_IMAGES, max_bytes: MAX_AGENT_IMAGE_BYTES };
  },
  status(requestId: unknown) {
    try { imageRequestId(requestId); } catch { return error('invalid_identity'); }
    observeImageAttachments();
    return receipts.get(requestId as string)?.receipt ?? { status: 'error', code: 'unknown_request', request_id: requestId };
  },
  attach(input: unknown) {
    let request: ImageAttachmentRequest;
    try { request = validateImageAttachment(input); }
    catch (failure) { return error((failure as { code?: string }).code ?? 'invalid_data', imageCorrelation(input)); }
    observeImageAttachments();
    if (receipts.has(request.request_id)) return error('duplicate_request', request);
    const target = active();
    if (!target) return error('no_active_composer', request);
    if (target.id !== request.composer_id) return error('stale_composer', request);
    if (target.current().images.length >= MAX_COMPOSER_IMAGES) return error('image_capacity', request);
    if ([...receipts.values()].some(record => record.target === target && record.receipt.status === 'pending')) return error('upload_pending', request);
    // Bound receipt storage. Eviction never retries a mutation; absent status is
    // explicitly unknown. Pending records are retained until their deadline.
    for (const [id, record] of receipts) {
      if (Date.now() > record.expires + 600_000 && ![...targets].some(target => target.id === record.receipt.composer_id)) receipts.delete(id);
    }
    if (receipts.size >= 64) return error('receipt_capacity', request);
    const dataUri = `data:${request.media_type};base64,${request.data_base64}`;
    const binary = atob(request.data_base64);
    const file = new File([Uint8Array.from(binary, character => character.charCodeAt(0))], request.filename, { type: request.media_type });
    const record: ReceiptRecord = {
      receipt: { request_id: request.request_id, composer_id: target.id, filename: request.filename, byte_length: file.size, status: 'pending' },
      target, dataUri, expires: Date.now() + READ_DEADLINE_MS,
    };
    receipts.set(request.request_id, record);
    const isCurrent = () => record.receipt.status === 'pending' && Date.now() < record.expires && available(target) && active() === target;
    try {
      Promise.resolve(target.current().upload!([file], { isCurrent, requestId: request.request_id })).then(results => {
        if (record.receipt.status !== 'pending') return;
        if (results?.some(result => result.status !== 'read')) finish(record, Date.now() >= record.expires ? 'upload_expired' : isCurrent() ? 'upload_failed' : 'target_changed');
        // Read completion is not attachment completion. React's committed image
        // state acknowledges it through observeImageAttachments.
      }, () => { if (record.receipt.status === 'pending') finish(record, 'upload_failed'); });
    } catch { finish(record, 'upload_failed'); }
    return record.receipt;
  },
};

declare global { interface Window { __o8ComposerImages__?: typeof composerImageBridge } }
export function registerImageComposer(current: () => ImageComposerSnapshot): () => void {
  const target: Target = { id: crypto.randomUUID(), current, live: true };
  targets.add(target);
  window.__o8ComposerImages__ = composerImageBridge;
  return () => {
    target.live = false;
    targets.delete(target);
    observeImageAttachments();
    // Keep read-only receipt reconciliation available after target disposal.
  };
}
