'use client';

import { useEffect, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { ActionButton } from '../repo-focus/tabs/control-room/shared';
import { threadModelLabel, threadStatusLine } from './threads-model';
import { useOrchestratorData } from '../orchestrator-data-context';

interface Evidence {
  jobId: string;
  attempt: number;
  logs: { id: number; text: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  logsTruncated: boolean;
  filesTruncated: boolean;
}

export function ThreadDetail({ task, onBack, onActions }: {
  task: TaskPoolTask;
  onBack: () => void;
  onActions: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const context = useOrchestratorData();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSteer, setPendingSteer] = useState<{ id: string; message: string } | null>(null);
  const jobId = task.execution?.jobId;
  const attempt = task.execution?.attempt;
  const evidenceKey = `${task.id}:${jobId}:${attempt}`;
  const currentError = error?.key === evidenceKey ? error.message : null;
  const packet = context?.missionState?.packets.find((entry) => entry.id === task.packetId);
  const currentEvidence = evidence && evidence.jobId === jobId && evidence.attempt === attempt ? evidence : null;

  useEffect(() => {
    if (!jobId || attempt === undefined) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ jobId, attempt: String(attempt) });
    void ipcFetch(`/api/tasks/${encodeURIComponent(task.id)}/evidence?${params}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as Evidence & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'The current attempt is unavailable.');
        if (!controller.signal.aborted) { setEvidence(payload); setError(null); }
      })
      .catch((err) => { if (!controller.signal.aborted) setError({ key: evidenceKey, message: err instanceof Error ? err.message : 'Unable to read this attempt.' }); });
    return () => controller.abort();
  }, [task.id, jobId, attempt, evidenceKey]);

  const send = async () => {
    if (busy || !task.packetId || (!pendingSteer && !message.trim())) return;
    const request = pendingSteer ?? { id: crypto.randomUUID(), message: message.trim() };
    setPendingSteer(request);
    setBusy(true);
    setNotice('Sending to this thread…');
    try {
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean; error?: string; message?: string; outcomeUnknown?: boolean;
        result?: { note?: string; status?: string; inProgress?: boolean };
      }>('/api/orchestrator/steer-packet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: task.packetId, message: request.message, idempotencyKey: request.id }),
      }, { fetch: ipcFetch });
      if (!response.ok || payload?.ok !== true) {
        if (payload && !payload.outcomeUnknown) setPendingSteer(null);
        throw new Error(payload?.message || payload?.error || 'The thread could not accept this message.');
      }
      setPendingSteer(null);
      setMessage('');
      setNotice(payload.result?.note || 'Message accepted by this thread.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Delivery is unconfirmed. Retry to check the same message.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        <ActionButton label="Threads" onClick={onBack} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 300, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{task.title}</span>
        <button type="button" onClick={onActions} aria-label={`Actions for ${task.title}`} style={{ border: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontSize: 16 }}>…</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', padding: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 260, color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>{threadModelLabel(task)} · {task.execution || (task.workerRouting?.selectedRuntime ?? task.runtime) === 'cloud' ? 'Remote worker' : 'Local worker'}{task.branch ? ` · ${task.branch}` : ''}</div>
        <p style={{ fontSize: 13.5, fontWeight: 300, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{threadStatusLine(task)}</p>
        {task.summary && task.summary !== threadStatusLine(task) ? <details style={{ marginBottom: 16 }}>
          <summary style={{ fontSize: 12, color: 'var(--t-text-muted)', cursor: 'pointer' }}>Task brief</summary>
          <p style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{task.summary}</p>
        </details> : null}
        {packet?.taskContract ? (
          <section aria-label="Thread requirements" style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>Requirements</div>
            {packet.taskContract.requirements.map((requirement) => <p key={requirement.id} style={{ fontSize: 13, lineHeight: 1.5 }}>{requirement.expectedBehavior}</p>)}
          </section>
        ) : null}
        {jobId ? (
          <section aria-label="Thread output" style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>Attempt {attempt} · logs and files</div>
            {currentError ? <p role="alert">{currentError}</p> : !currentEvidence ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Reading this attempt…</p> : null}
            {currentEvidence ? <>
              {currentEvidence.files.map((file) => <div key={file.path} style={{ paddingTop: 8, fontSize: 12, overflowWrap: 'anywhere' }}>{file.path} <span style={{ color: 'var(--t-text-faint)' }}>+{file.additions} −{file.deletions}</span></div>)}
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--t-text-secondary)' }}>{currentEvidence.logs.map((log) => log.text).join('\n')}</pre>
              {!currentEvidence.logs.length && !currentEvidence.files.length ? <p style={{ fontSize: 12 }}>No output recorded for this attempt yet.</p> : null}
              {currentEvidence.logsTruncated || currentEvidence.filesTruncated ? <p style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>Showing the bounded output saved for this attempt.</p> : null}
            </> : null}
          </section>
        ) : null}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid var(--t-divider-subtle)' }}>
        <textarea aria-label="Steer this thread" placeholder="Steer this thread…" rows={2} value={message} disabled={busy || Boolean(pendingSteer) || !task.packetId || task.group === 'done'} onChange={(event) => setMessage(event.currentTarget.value)} style={{ width: '100%', boxSizing: 'border-box', resize: 'none', border: '1px solid var(--t-divider-subtle)', borderRadius: 10, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13, padding: 10 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span role="status" style={{ flex: 1, fontSize: 11, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>{notice || (task.group === 'done' ? 'This thread has finished.' : threadModelLabel(task))}</span>
          <ActionButton label={busy ? 'Sending…' : pendingSteer ? 'Check delivery' : 'Send'} primary disabled={busy || !task.packetId || task.group === 'done' || (!pendingSteer && !message.trim())} onClick={() => { void send(); }} />
        </div>
      </div>
    </div>
  );
}
