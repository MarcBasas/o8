'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { planConnectionRequest } from '@/lib/chatgpt-plan/client';
import type { PlanStatus } from '@/lib/chatgpt-plan/types';
import type { LLMMessage, ModelOption } from '@/components/desktop/llm-chat/shared';
import { streamAssistantResponse } from '@/components/desktop/llm-chat/streaming';

interface ChatView {
  generation: number;
  status: PlanStatus | null;
  modelId: string;
  input: string;
  messages: LLMMessage[];
  stream: string;
  busy: boolean;
  notice: string | null;
}
function emptyView(generation: number): ChatView {
  return { generation, status: null, modelId: '', input: '', messages: [], stream: '', busy: false, notice: null };
}
const controlStyle = { border: '1px solid var(--t-panel-border)', borderRadius: 8, color: 'var(--t-text)', background: 'var(--t-bg-card)', paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, font: 'inherit' };
const noop = () => {};

/** Explicit text-only plan requests; no repository, tools, fallback, or extra turns. */
export function ChatGPTPlanChat({ tabId }: { tabId: string }) {
  const auth = useO8Auth();
  const owner = auth.isLoaded && auth.signedIn ? auth.user?.id ?? null : null;
  const identity = useRef({ owner, generation: 0 });
  if (identity.current.owner !== owner) identity.current = { owner, generation: identity.current.generation + 1 };
  const epoch = identity.current.generation;
  const [storedView, setView] = useState<ChatView>(() => emptyView(epoch));
  const view = storedView.generation === epoch ? storedView : emptyView(epoch);
  const request = useRef<{ generation: number; controller: AbortController } | null>(null);
  const connection = useRef<{ generation: number; key: string } | null>(null);
  const current = useCallback((generation: number) => identity.current.owner !== null && identity.current.generation === generation, []);
  const write = useCallback((generation: number, change: (value: ChatView) => ChatView) => {
    if (!current(generation)) return;
    setView((previous) => current(generation) ? change(previous.generation === generation ? previous : emptyView(generation)) : previous);
  }, [current]);
  const load = useCallback(async (generation: number) => {
    if (!current(generation)) return null;
    const status = await planConnectionRequest() as unknown as PlanStatus;
    if (!current(generation)) return null;
    const key = JSON.stringify([status.activeId, status.selection?.accountId, status.selection?.generation, status.selection?.desktopEpoch]);
    if (connection.current?.generation === generation && connection.current.key !== key) {
      request.current?.controller.abort(); request.current = null;
      const next = ++identity.current.generation;
      connection.current = { generation: next, key };
      write(next, () => ({ ...emptyView(next), status, modelId: status.models[0]?.id ?? '', notice: 'The ChatGPT connection changed. This conversation was cleared. Review the connection before sending again.' }));
      return null;
    }
    connection.current = { generation, key };
    write(generation, (previous) => ({ ...previous, status, modelId: status.models.some((model) => model.id === previous.modelId) ? previous.modelId : status.models[0]?.id ?? '', notice: status.modelLoadError ?? null }));
    return status;
  }, [current, write]);

  useEffect(() => {
    const generation = identity.current.generation;
    setView(emptyView(generation));
    const refresh = (next: number) => void load(next).catch((error: unknown) => write(next, (previous) => ({ ...previous, notice: error instanceof Error ? error.message : 'ChatGPT could not be reached.' })));
    if (owner) refresh(generation);
    const changed = () => {
      request.current?.controller.abort(); request.current = null;
      const next = ++identity.current.generation;
      setView(emptyView(next));
      if (identity.current.owner) refresh(next);
    };
    window.addEventListener('o8:chatgpt-plan-changed', changed);
    return () => {
      window.removeEventListener('o8:chatgpt-plan-changed', changed);
      request.current?.controller.abort(); request.current = null;
      identity.current.generation += 1;
    };
  }, [owner, load, write]);

  const send = async (generation: number) => {
    if (!current(generation) || request.current || view.busy || !view.input.trim() || !view.modelId || !view.status?.planEnabled) return;
    const controller = new AbortController();
    const attempt = { generation, controller }; request.current = attempt;
    const input = view.input.trim();
    write(generation, (previous) => ({ ...previous, busy: true, notice: null, stream: '', input: '' }));
    try {
      // Recheck disconnection/selection before a billed request, never route elsewhere.
      const status = await load(generation);
      if (!current(generation) || controller.signal.aborted) return;
      const selected = status?.models.find((model) => model.id === view.modelId);
      if (!status?.planEnabled || !status.selection || status.activeId !== view.status.activeId || !selected) throw new Error('The ChatGPT connection changed. Review the connection and send again.');
      const model: ModelOption = { id: `chatgpt:${selected.id}`, label: selected.label, provider: 'chatgpt', backend: 'api', color: 'var(--t-text)', description: 'ChatGPT plan' };
      const userMessage: LLMMessage = { id: crypto.randomUUID(), role: 'user', content: input, timestamp: Date.now() };
      write(generation, (previous) => ({ ...previous, messages: [...previous.messages, userMessage] }));
      const result = await streamAssistantResponse({ controller, model, messageForModel: input, messages: view.messages, tabId, planSelection: status.selection, planTextOnly: true, approvedToolsSet: new Set(), disableTools: true, preferredRepo: null, linkedIssue: null, showTypingIndicator: false, onPendingApproval: noop, onThinking: noop, onToolCalls: noop, onTypingIndicatorChange: noop, onStreamContent: (stream) => { if (!controller.signal.aborted) write(generation, (previous) => ({ ...previous, stream })); } });
      if (controller.signal.aborted || !current(generation)) return;
      write(generation, (previous) => ({ ...previous, messages: [...previous.messages, result.assistantMessage], stream: '' }));
    } catch (error) {
      write(generation, (previous) => ({ ...previous, notice: controller.signal.aborted ? 'Request stopped.' : error instanceof Error ? error.message : 'The ChatGPT request failed.' }));
    } finally {
      if (request.current === attempt) request.current = null;
      write(generation, (previous) => ({ ...previous, busy: false }));
    }
  };

  return <section aria-label="ChatGPT plan chat" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, paddingTop: 20, paddingBottom: 16, paddingLeft: 20, paddingRight: 20, gap: 12, color: 'var(--t-text)', fontSize: 13 }}>
    <div><strong>ChatGPT plan chat</strong><p style={{ marginTop: 6, marginBottom: 0, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>Uses your ChatGPT limits. Text only. This conversation clears when the pane closes or the connected account changes.</p></div>
    {!owner ? <button type="button" style={controlStyle} onClick={auth.signIn}>Sign in to o8</button> : !view.status?.planEnabled ? <p role="status">Connect ChatGPT in Settings → Models &amp; providers.</p> : null}
    {view.status?.planEnabled ? <label>Model <select aria-label="ChatGPT plan model" style={controlStyle} disabled={view.busy} value={view.modelId} onChange={(event) => write(epoch, (previous) => ({ ...previous, modelId: event.target.value }))}>{view.status.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label> : null}
    <div role="log" aria-label="ChatGPT conversation" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {view.messages.map((message) => <div key={message.id} style={{ marginBottom: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}><strong>{message.role === 'user' ? 'You' : 'ChatGPT'}</strong><div>{message.content}</div></div>)}
      {view.stream ? <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}><strong>ChatGPT{view.busy ? '' : ' · partial response'}</strong><div>{view.stream}</div></div> : null}
    </div>
    {view.notice ? <p role="status" style={{ marginTop: 0, marginBottom: 0, color: 'var(--t-text-secondary)' }}>{view.notice}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void send(epoch); }} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
      <textarea aria-label="Message ChatGPT" rows={3} placeholder="Ask ChatGPT…" disabled={!view.status?.planEnabled || view.busy} value={view.input} onChange={(event) => write(epoch, (previous) => ({ ...previous, input: event.target.value }))} style={{ ...controlStyle, flex: 1, minWidth: 0, resize: 'vertical' }} />
      {view.busy ? <button type="button" style={controlStyle} onClick={() => { if (current(epoch) && request.current?.generation === epoch) request.current.controller.abort(); }}>Stop</button> : <button type="submit" disabled={!view.status?.planEnabled || !view.input.trim()} style={controlStyle}>Send</button>}
    </form>
  </section>;
}
