'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { planConnectionRequest } from '@/lib/chatgpt-plan/client';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { PLAN_USAGE_URL, type PlanStatus } from '@/lib/chatgpt-plan/types';
import { SettingsGroup, SettingsRow } from './grouped';

const buttonStyle = { border: '1px solid var(--t-panel-border)', borderRadius: 8, background: 'var(--t-bg-card)', color: 'var(--t-text)', fontSize: 12, paddingTop: 7, paddingBottom: 7, paddingLeft: 10, paddingRight: 10, cursor: 'pointer' };

export function ChatGPTPlanConnection() {
  const auth = useO8Auth();
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async (epoch = generation.current) => {
    const data = await planConnectionRequest();
    if (epoch === generation.current) { setStatus(data as unknown as PlanStatus); if (typeof data.modelLoadError === 'string') setNotice(data.modelLoadError); }
  }, []);

  useEffect(() => {
    const epoch = ++generation.current;
    setStatus(null); setNotice(null); setBusy(null); busyRef.current = false;
    if (auth.signedIn) void load(epoch).catch((error: Error) => { if (epoch === generation.current) setNotice(error.message); });
    return () => { generation.current += 1; if (timeout.current) clearTimeout(timeout.current); };
  }, [auth.signedIn, auth.user?.id, load]);

  const update = useCallback(async (action: string, extra: Record<string, string> = {}) => {
    if (busyRef.current) return;
    busyRef.current = true; const epoch = generation.current;
    setBusy(action === 'start' ? 'Opening ChatGPT…' : 'Updating connection…'); setNotice(null);
    const current = () => epoch === generation.current;
    const post = (value: Record<string, unknown>) => planConnectionRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    try {
      const data = await post({ action, ...extra });
      if (!current()) return;
      if (action === 'start') {
        if (typeof data.authorizationUrl !== 'string' || typeof data.attemptId !== 'string') throw new Error('ChatGPT sign-in could not start.');
        const authorization = new URL(data.authorizationUrl);
        if (authorization.origin !== 'https://auth.openai.com' || authorization.pathname !== '/api/accounts/authorize') throw new Error('ChatGPT returned an unexpected sign-in destination.');
        openExternalUrl(data.authorizationUrl); setBusy('Waiting for ChatGPT sign-in…');
        const until = Date.now() + 5 * 60_000;
        const poll = async () => {
          if (!current()) return;
          try {
            const progress = await planConnectionRequest(`?attemptId=${encodeURIComponent(data.attemptId as string)}`);
            if (!current()) return;
            if (progress.state === 'ready') {
              await post({ action: 'finish', attemptId: data.attemptId });
              if (!current()) return;
              await load(epoch); window.dispatchEvent(new Event('o8:chatgpt-plan-changed'));
              setBusy(null); busyRef.current = false; return;
            }
            if (Date.now() >= until) throw new Error('ChatGPT sign-in expired. Try again.');
            timeout.current = setTimeout(() => void poll(), 1_500);
          } catch (error) { if (current()) { await load(epoch).catch(() => {}); setNotice(error instanceof Error ? error.message : 'Sign-in stopped.'); setBusy(null); busyRef.current = false; } }
        };
        timeout.current = setTimeout(() => void poll(), 1_000);
        return;
      }
      await load(epoch); window.dispatchEvent(new Event('o8:chatgpt-plan-changed'));
    } catch (error) { if (current()) setNotice(error instanceof Error ? error.message : 'The connection could not be updated.'); }
    if (current()) { setBusy(null); busyRef.current = false; }
  }, [load]);

  const disconnect = async () => {
    if (busyRef.current) return;
    busyRef.current = true; const epoch = generation.current;
    setBusy('Disconnecting…'); setNotice(null); setConfirmDisconnect(false);
    try {
      const data = await planConnectionRequest('', { method: 'DELETE' });
      if (epoch !== generation.current) return;
      await load(epoch); window.dispatchEvent(new Event('o8:chatgpt-plan-changed'));
      if (data.revocationConfirmed !== true) setNotice('Disconnected locally. Open ChatGPT settings to confirm removal there.');
    } catch (error) { if (epoch === generation.current) setNotice(error instanceof Error ? error.message : 'Disconnect failed.'); }
    if (epoch === generation.current) { setBusy(null); busyRef.current = false; }
  };

  return <div style={{ marginTop: 20, marginBottom: 20 }}>
    <SettingsGroup header="ChatGPT plan" footnote="Use your ChatGPT plan for o8 text requests without an API key or CLI. Plan limits still apply. This does not open your ChatGPT chats or memories, and o8 pricing is separate.">
      <SettingsRow label={status?.planEnabled ? 'Using ChatGPT plan' : 'Connect ChatGPT'} subtitle={busy ?? (status?.planEnabled ? 'Choose an available model in the chat composer.' : 'Connection failures stop this route.')} accessory={<>
        {!auth.signedIn ? <button type="button" style={buttonStyle} onClick={auth.signIn}>Sign in to o8</button> : <button type="button" disabled={Boolean(busy)} style={buttonStyle} onClick={() => { const accountId = status?.activeId ?? status?.accounts.at(-1)?.id; void update('start', accountId ? { accountId } : {}); }}>Continue with ChatGPT</button>}
      </>} />
      {status?.accounts.length ? <SettingsRow label="ChatGPT account" accessory={<><select aria-label="Active ChatGPT account" disabled={Boolean(busy)} value={status.activeId ?? ''} onChange={(event) => void update(status.accounts.find((account) => account.id === event.target.value)?.connected ? 'select' : 'start', { accountId: event.target.value })} style={buttonStyle}>
        <option value="" disabled>Select an account</option>{status.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.connected ? '' : ' · reconnect'}</option>)}
      </select><button type="button" disabled={Boolean(busy)} style={buttonStyle} onClick={() => void update('start')}>Add account</button></>} /> : null}
      {status?.connected ? <SettingsRow label="Plan access" accessory={<><button type="button" style={buttonStyle} onClick={() => openExternalUrl(PLAN_USAGE_URL)}>Manage usage</button><button type="button" disabled={Boolean(busy)} style={buttonStyle} onClick={() => setConfirmDisconnect(true)}>Disconnect</button></>} /> : null}
      {confirmDisconnect ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, color: 'var(--t-danger-text, #b91c1c)' }}>Stop this ChatGPT connection?<button type="button" style={{ ...buttonStyle, color: 'var(--t-danger-text, #b91c1c)' }} onClick={() => void disconnect()}>Disconnect</button><button type="button" style={buttonStyle} onClick={() => setConfirmDisconnect(false)}>Cancel</button></div> : null}
      {status?.planEnabled && !status.welcomed ? <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, fontSize: 12, color: 'var(--t-text)' }}>You’re using your ChatGPT plan. Requests count toward its applicable limits.<button type="button" disabled={Boolean(busy)} style={{ ...buttonStyle, marginLeft: 8 }} onClick={() => void update('welcome')}>Got it</button></div> : null}
    </SettingsGroup>
    {notice ? <p role="status" style={{ fontSize: 12, color: 'var(--t-text-secondary)', marginTop: 8, marginBottom: 0 }}>{notice}</p> : null}
  </div>;
}
