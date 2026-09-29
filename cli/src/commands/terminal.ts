/** Read existing dashboard terminals through the server-owned terminal host. */
import WebSocket from 'ws';
import { CliError, EXIT, resolveWsBase } from '../api.js';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

interface TerminalSession { id: string; cols?: number; rows?: number }

function operatorConfig(): ResolvedConfig {
  const cfg = resolveConfig();
  if (cfg.source.token === 'worker' || cfg.source.token === 'spectator' || !cfg.token) {
    throw new CliError(
      'operator_required',
      'Terminal observation requires the local operator credential.',
      EXIT.UNAUTHORIZED,
    );
  }
  return cfg;
}

function terminalUrl(cfg: ResolvedConfig, path: string): URL {
  const url = new URL(path, resolveWsBase(cfg));
  url.protocol = 'http:';
  return url;
}

async function terminalGet<T>(cfg: ResolvedConfig, url: URL): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new CliError('connection_refused', 'The o8 terminal host is unavailable.', EXIT.CONNECTION_REFUSED);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError('unauthorized', 'Terminal host rejected the operator credential.', EXIT.UNAUTHORIZED);
  }
  if (response.status === 404) {
    throw new CliError('terminal_not_found', 'That live terminal session was not found.', EXIT.NOT_FOUND);
  }
  if (!response.ok) {
    throw new CliError('terminal_unavailable', `Terminal host returned ${response.status}.`, EXIT.CONFLICT);
  }
  return response.json() as Promise<T>;
}

async function listSessions(cfg: ResolvedConfig): Promise<TerminalSession[]> {
  const result = await terminalGet<{ sessions?: unknown }>(cfg, terminalUrl(cfg, '/terminal-sessions'));
  if (!Array.isArray(result.sessions)) {
    throw new CliError('invalid_response', 'Terminal host returned an invalid inventory.', EXIT.CONFLICT);
  }
  return result.sessions.filter((id): id is string => typeof id === 'string').map((id) => ({ id }));
}

async function requireLiveSession(cfg: ResolvedConfig, id: string): Promise<void> {
  if (!(await listSessions(cfg)).some((session) => session.id === id)) {
    throw new CliError('terminal_not_found', `Terminal ${id} is not live.`, EXIT.NOT_FOUND);
  }
}

function observe(cfg: ResolvedConfig, id: string, mode: OutputMode): Promise<number> {
  const url = new URL('/ws', resolveWsBase(cfg));
  url.searchParams.set('token', cfg.token!);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const decoder = new TextDecoder();
    let attached = false;
    let settled = false;
    const connectTimer = setTimeout(() => fail(new CliError(
      'server_timeout', 'Timed out attaching to the terminal.', EXIT.SERVER_TIMEOUT,
    )), 8_000);
    const cleanup = () => {
      clearTimeout(connectTimer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      socket.close();
    };
    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(EXIT.OK);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: id, readOnly: true,
    })));
    socket.on('message', (raw) => {
      let frame: { channel?: string; event?: string; data?: { sessionName?: string; data?: string; error?: string } };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.channel !== 'terminal' || frame.data?.sessionName !== id) return;
      if (frame.event === 'error') {
        fail(new CliError('terminal_not_found', frame.data.error ?? 'Terminal unavailable.', EXIT.NOT_FOUND));
        return;
      }
      if (frame.event === 'attached') {
        attached = true;
        clearTimeout(connectTimer);
        if (!mode.human) process.stdout.write(`${JSON.stringify({ schema: 'o8/cli/terminal.observe/v1', event: 'attached', id })}\n`);
        return;
      }
      if (frame.event === 'exited' && attached) {
        if (!mode.human) process.stdout.write(`${JSON.stringify({
          schema: 'o8/cli/terminal.observe/v1', event: 'exited', id,
        })}\n`);
        settled = true;
        cleanup();
        resolve(EXIT.OK);
        return;
      }
      if (frame.event === 'data' && attached && typeof frame.data.data === 'string') {
        const output = decoder.decode(Buffer.from(frame.data.data, 'base64'), { stream: true });
        if (!output) return;
        process.stdout.write(mode.human ? output : `${JSON.stringify({
          schema: 'o8/cli/terminal.observe/v1', event: 'data', id, text: output,
        })}\n`);
      }
    });
    socket.on('error', () => fail(new CliError(
      'connection_refused', 'Could not connect to the o8 terminal host.', EXIT.CONNECTION_REFUSED,
    )));
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CliError('terminal_disconnected', 'Terminal observation disconnected.', EXIT.CONNECTION_REFUSED));
    });
  });
}

export async function runTerminal(mode: OutputMode, sub: string | undefined, rest: string[]): Promise<number> {
  if (!['list', 'show', 'observe'].includes(sub ?? '')) {
    throw new CliError('invalid_args', 'Use `o8 terminal list|show <id>|observe <id>`.', EXIT.INVALID_ARGS);
  }
  const cfg = operatorConfig();
  if (sub === 'list') {
    if (rest.length > 0) throw new CliError('invalid_args', 'terminal list takes no arguments.', EXIT.INVALID_ARGS);
    const sessions = await listSessions(cfg);
    if (mode.human) process.stdout.write(sessions.map((session) => session.id).join('\n') + (sessions.length ? '\n' : ''));
    else printJson({ schema: 'o8/cli/terminal.list/v1', sessions });
    return EXIT.OK;
  }
  const id = rest[0]?.trim();
  if (!id) throw new CliError('invalid_args', `terminal ${sub} requires an exact session ID.`, EXIT.INVALID_ARGS);
  if (sub === 'observe') {
    if (rest.length !== 1) throw new CliError('invalid_args', 'terminal observe takes one session ID.', EXIT.INVALID_ARGS);
    await requireLiveSession(cfg, id);
    return observe(cfg, id, mode);
  }
  let lines = 200;
  if (rest.length > 1) {
    if (rest.length !== 3 || rest[1] !== '--lines' || !/^\d+$/.test(rest[2] ?? '')) {
      throw new CliError('invalid_args', 'Use `terminal show <id> [--lines 1..1000]`.', EXIT.INVALID_ARGS);
    }
    lines = Number(rest[2]);
  }
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) {
    throw new CliError('invalid_args', '--lines must be between 1 and 1000.', EXIT.INVALID_ARGS);
  }
  await requireLiveSession(cfg, id);
  const url = terminalUrl(cfg, '/terminal-snapshot');
  url.searchParams.set('sessionName', id);
  url.searchParams.set('lines', String(lines));
  const snapshot = await terminalGet<{ session: TerminalSession; text: string }>(cfg, url);
  if (mode.human) process.stdout.write(snapshot.text);
  else printJson({ schema: 'o8/cli/terminal.show/v1', ...snapshot });
  return EXIT.OK;
}
