/** @vitest-environment jsdom */
import { createElement, useState, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { MAX_AGENT_IMAGE_BASE64 } from '@/lib/composer/image-attachment';
import { ComposerArea } from './ComposerArea';
import { useThoughtsComposerAttachments } from './useThoughtsComposerAttachments';

vi.mock('../InputButtons', async () => {
  const { AttachFilesButton } = await import('../AttachFilesButton');
  return { InputButtons: (props: { onUploadDiskFiles?: (files: FileList | File[]) => void }) => createElement(AttachFilesButton, props), RepoTargetChip: () => null };
});
vi.mock('./SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('./ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('../../composer-center-registry', () => ({ registerComposerCenter: () => () => undefined }));

// Generated synthetic signature bytes stay in this test process; no file reads.
const image = btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0));
let root: Root;
let host: HTMLDivElement;
let active = true;
let disabled = false;
let context = 'first-chat';
let failed = false;
let deferred = false;
let readers: FixtureReader[];
const sent = vi.fn();
class FixtureReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL(file: File) {
    this.result = `data:${file.type};base64,${image}`;
    readers.push(this);
    if (!deferred) queueMicrotask(() => failed ? this.onerror?.() : this.onload?.());
  }
}
function Harness() {
  const attachments = useThoughtsComposerAttachments();
  const [input, setInput] = useState('unsent');
  return createElement(ComposerArea, {
    activeComposer: active, input, onInputChange: setInput,
    isOrchestratorMode: !disabled, displayWaiting: false, chatMessages: [], activeTargetLabel: 'Chat',
    targetAgentExists: false, thoughtsBodyBackground: 'var(--t-workspace)', enhancing: false,
    preEnhanceInput: null, onEnhance: () => undefined, onUndoEnhance: () => undefined,
    onSubmit: sent, onSlashCommand: () => undefined, modelLabel: 'Model', effort: 'medium',
    onEffortChange: () => undefined, adaptiveEnabled: false, displayMessagesCount: 0,
    hasAssistantActivity: false, sessionRulesThreadId: context,
    attachedImages: attachments.attachedImages, onUploadDiskFiles: attachments.processFiles,
  });
}
let client: O8WebviewClient;
const handlers = createO8WebviewToolHandlers(() => client);
async function call(name: string, args: Record<string, unknown> = {}) {
  let result: Awaited<ReturnType<typeof handlers[string]>>;
  await act(async () => { result = await handlers[name](args); });
  const content = result!.content[0];
  if (content.type !== 'text') throw new Error('Expected text receipt');
  return JSON.parse(content.text) as Record<string, unknown>;
}
async function attach(extra: Record<string, unknown> = {}) {
  const inspection = await call('o8_view_inspect_composer');
  return call('o8_view_attach_image', {
    composer_id: inspection.composer_id, request_id: crypto.randomUUID(), filename: 'fixture.png',
    media_type: 'image/png', data_base64: image, ...extra,
  });
}
async function frames() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); }
function render() { act(() => root.render(createElement(Harness))); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  active = true; disabled = false; context = 'first-chat'; failed = false; deferred = false; readers = [];
  sent.mockClear(); localStorage.clear();
  vi.stubGlobal('FileReader', FixtureReader);
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  vi.stubEnv('O8_TAURI_MCP_SOCKET', '/fixture/never-connected.sock');
  client = new O8WebviewClient();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40, top: 0, left: 0, bottom: 40, right: 100, x: 0, y: 0, toJSON: () => ({}) });
  // Simulate only the established native execute_js boundary. The registered
  // tool, typed client scripts, ComposerArea and normal reader/attachment flow run.
  vi.spyOn(client, 'evalJs').mockImplementation(async code => ({ result: new Function('window', `return ${code}`)(window) as string }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

describe('registered image tool -> normal installed composer handler', () => {
  it('acknowledges committed attachment state, correlates status, never sends or replays', async () => {
    deferred = true;
    const pending = await attach();
    expect(pending.status).toBe('pending');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    const before = readers.length;
    await act(async () => readers[0].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('completed');
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('fixture.png');
    expect((await attach({ request_id: pending.request_id })).code).toBe('duplicate_request');
    expect(readers).toHaveLength(before); expect(sent).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')?.value).toBe('unsent');
  });
  it('does not acknowledge a simultaneous manual upload with identical bytes as the agent request', async () => {
    deferred = true;
    const pending = await attach();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([atob(image)], 'fixture.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => readers[1].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('pending');
    await act(async () => readers[0].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).status).toBe('completed');
  });
  it('refuses invalid arguments before reading or uploading', async () => {
    for (const extra of [
      { data_base64: 'not-base64' }, { data_base64: 'AAAA' }, { data_base64: 'A'.repeat(MAX_AGENT_IMAGE_BASE64 + 4) }, { data_base64: 'A'.repeat(MAX_AGENT_IMAGE_BASE64) },
      { composer_id: 'bad' }, { request_id: 'bad' }, { data_base64: 1 }, { filename: 'a'.repeat(121) + '.png' },
      { media_type: 'application/pdf' }, { filename: '../image.png' }, { filename: 'image\0.png' },
      { filename: 'image.jpg' }, { path: '/some/file.png' }, { script: 'arbitrary' },
    ]) expect((await attach(extra)).status).toBe('error');
    expect(readers).toHaveLength(0);
  });
  it('refuses inactive, disabled, hidden, missing and stale composers', async () => {
    const original = await call('o8_view_inspect_composer');
    context = 'different-chat'; render();
    expect((await attach({ composer_id: original.composer_id })).code).toBe('stale_composer');
    active = false; render(); expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    active = true; disabled = true; render(); expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    disabled = false; render(); host.querySelector('textarea')!.style.display = 'none';
    expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    act(() => root.render(null)); expect((await call('o8_view_inspect_composer')).code).toBe('no_active_composer');
    expect(readers).toHaveLength(0);
  });
  it('refuses a changed target during reading and prevents a late attachment', async () => {
    deferred = true;
    const pending = await attach(); context = 'changed-while-reading'; render();
    await act(async () => readers[0].onload?.()); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('target_changed');
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('drops a read result when its target changes before the attachment frame', async () => {
    deferred = true;
    const pending = await attach();
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queued.push(callback); return queued.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    await act(async () => readers[0].onload?.());
    expect(host.querySelectorAll('img')).toHaveLength(0);
    context = 'changed-before-frame'; render();
    await act(async () => { for (const callback of queued) callback(0); });
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('target_changed');
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('preserves the manual file-input path and enforces image capacity', async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([atob(image)], 'manual.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await frames();
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('manual.png');
    for (let count = 0; count < 3; count++) { expect((await attach()).status).toBe('pending'); await frames(); }
    expect((await attach()).code).toBe('image_capacity');
    expect(host.querySelectorAll('img')).toHaveLength(4); expect(sent).not.toHaveBeenCalled();
  });
  it('expires a pending upload and blocks late reader completion', async () => {
    deferred = true;
    const pending = await attach();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_001);
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('upload_expired');
    await act(async () => readers[0].onload?.()); await frames();
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
  it('reports upload read failure and missing receipts honestly', async () => {
    failed = true; const pending = await attach(); await frames();
    expect((await call('o8_view_image_attachment_status', { request_id: pending.request_id })).code).toBe('upload_failed');
    expect((await call('o8_view_image_attachment_status', { request_id: 'missing-request' })).code).toBe('unknown_request');
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
});
