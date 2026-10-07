/**
 * Pi orchestrator backend (#3258): the bundled Pi SDK session as the
 * orchestrator, on the managed model route (paid plan token or the free
 * allowance; the worker never holds a credential).
 *
 * Pi gets the same built-in o8 servers as the Claude orchestrator (operator and
 * cortex, projected by the turn's tool profile) through three catalog tools, so
 * every o8 command is reachable without sending every schema on every call. Its
 * own file writes and commands in the repo keep per-call approval in the inbox.
 *
 * One resident Pi process per repo and thread. The session file lives under the
 * o8 data directory, so a new process after a restart or failure resumes the
 * same conversation.
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { createO8CommandTools, listO8Commands, o8CommandPrompt } from '@/lib/pi/orchestrator/o8-commands';
import { openO8Servers, type O8ServerSet } from '@/lib/pi/orchestrator/o8-servers';
import { O8_MANAGED_FLASH_LITE_MODEL } from '@/lib/pi/sdk/live-contract';
import type { createPiSdkSession, PiSdkSessionOptions } from '@/lib/pi/sdk/session';
import type { OrchestratorBackend, OrchestratorSessionInfo, OrchestratorTurnOptions } from './types';

/** Per-turn limits. A turn that dispatches and waits on a mission needs more than the prototype's defaults. */
export const PI_ORCHESTRATOR_LIMITS = { maxModelCalls: 40, maxToolCalls: 80, runTimeoutMs: 30 * 60_000 } as const;
/** An idle thread's Pi and cortex processes close after this; the next message resumes from the session file. */
export const PI_ORCHESTRATOR_IDLE_MS = 15 * 60_000;

type PiSession = Awaited<ReturnType<typeof createPiSdkSession>>;

interface ResidentPi {
  session: PiSession;
  servers: O8ServerSet;
  profile: ToolProfile;
  busy: boolean;
  emit?: (event: OrchestratorEvent) => void;
  idle?: ReturnType<typeof setTimeout>;
}

/** Trusted seams for tests. Production uses the managed transport, the inbox and /api/mcp. */
export interface PiOrchestratorDeps {
  transport?: PiSdkSessionOptions['transport'];
  approve?: PiSdkSessionOptions['approve'];
  openServers?: typeof openO8Servers;
  stateRoot?: () => string;
  idleMs?: number;
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text : '')).join('\n');
}

/**
 * Maps one Pi agent event to orchestrator stream events. Only text and tool
 * activity cross; message objects, which can carry provider diagnostics, never do.
 */
export function piEventToOrchestratorEvents(event: Record<string, unknown>): OrchestratorEvent[] {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
    if (typeof update?.delta !== 'string' || !update.delta) return [];
    if (update.type === 'text_delta') return [{ type: 'text', text: update.delta }];
    if (update.type === 'thinking_delta') return [{ type: 'thinking', text: update.delta }];
    return [];
  }
  if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
    return [{ type: 'tool_use', id: typeof event.toolCallId === 'string' ? event.toolCallId : null, name: event.toolName, input: event.args ?? {} }];
  }
  if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') {
    return [{
      type: 'tool_result',
      id: typeof event.toolCallId === 'string' ? event.toolCallId : null,
      name: event.toolName,
      output: textOf(event.result),
      isError: event.isError === true,
    }];
  }
  return [];
}

async function newestSessionFile(dir: string): Promise<string | undefined> {
  let newest: { path: string; mtime: number } | undefined;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(entry.parentPath, entry.name);
    const mtime = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest?.path;
}

export function createPiOrchestratorBackend(deps: PiOrchestratorDeps = {}): OrchestratorBackend & {
  closeAll(): Promise<void>;
} {
  const resident = new Map<string, ResidentPi>();
  const starting = new Map<string, Promise<ResidentPi>>();
  const ensured = new Set<string>();
  const stateRoot = deps.stateRoot ?? (() => join(getDataDir(), 'pi', 'orchestrator'));

  const nameFor = (repoPath: string, threadId?: string | null) => sessionNameForRepo('pi-orchestrator', repoPath, threadId);

  async function close(name: string) {
    const pi = resident.get(name);
    resident.delete(name);
    if (pi) {
      clearTimeout(pi.idle);
      await Promise.allSettled([pi.session.close(), pi.servers.close()]);
    }
  }

  async function start(name: string, repoPath: string, options: OrchestratorTurnOptions, profile: ToolProfile): Promise<ResidentPi> {
    const stateDir = join(stateRoot(), createHash('sha256').update(name).digest('hex').slice(0, 32));
    const signal = options.signal ?? new AbortController().signal;
    const servers = await (deps.openServers ?? openO8Servers)(repoPath, { profile, threadId: options.threadId });
    try {
      const commands = servers.servers.length ? await listO8Commands(servers.servers, signal) : [];
      const systemPrompt = [
        buildOrchestratorSystemPrompt(repoPath, { backend: 'pi', toolProfile: profile }),
        commands.length ? o8CommandPrompt(commands) : '',
      ].filter(Boolean).join('\n\n');
      const pi: ResidentPi = { servers, profile, busy: false } as ResidentPi;
      // Loaded on the first Pi turn, so ws-server startup never evaluates the Pi SDK.
      const { createPiSdkSession } = await import('@/lib/pi/sdk/session');
      pi.session = await createPiSdkSession({
        workspace: repoPath,
        stateDir,
        model: O8_MANAGED_FLASH_LITE_MODEL,
        sessionFile: await newestSessionFile(join(stateDir, 'sessions')),
        transport: deps.transport,
        approve: deps.approve,
        hostTools: commands.length ? createO8CommandTools(commands) : [],
        systemPrompt,
        onEvent: (event) => {
          for (const mapped of piEventToOrchestratorEvents(event)) pi.emit?.(mapped);
        },
        ...PI_ORCHESTRATOR_LIMITS,
      });
      return pi;
    } catch (error) {
      await servers.close();
      throw error;
    }
  }

  async function ensure(name: string, repoPath: string, options: OrchestratorTurnOptions): Promise<ResidentPi> {
    const profile = options.toolProfile ?? 'full';
    const existing = resident.get(name);
    // A different tool profile needs a different tool set; the session file keeps the conversation.
    if (existing && (existing.profile !== profile || !existing.session.running)) await close(name);
    else if (existing) return existing;
    let pending = starting.get(name);
    if (!pending) {
      pending = start(name, repoPath, options, profile).finally(() => starting.delete(name));
      starting.set(name, pending);
    }
    const pi = await pending;
    resident.set(name, pi);
    return pi;
  }

  async function sendTurn(repoPath: string, message: string, onEvent: (event: OrchestratorEvent) => void,
    options: OrchestratorTurnOptions = {}) {
    const name = nameFor(repoPath, options.threadId);
    ensured.add(name);
    let sessionId: string | null = null;
    const done = () => onEvent({ type: 'done', sessionId, cost: null });
    let pi: ResidentPi;
    try {
      pi = await ensure(name, repoPath, options);
    } catch (error) {
      if (!options.signal?.aborted) {
        onEvent({ type: 'error', error: `Pi could not start: ${error instanceof Error ? error.message : String(error)}` });
      }
      done();
      return;
    }
    sessionId = pi.session.sessionId;
    if (pi.busy) {
      onEvent({ type: 'error', error: 'Pi is still working on the previous message in this thread.' });
      done();
      return;
    }
    clearTimeout(pi.idle);
    pi.busy = true;
    pi.emit = onEvent;
    onEvent({ type: 'turn_receipt', leadModel: 'pi', effort: options.thinkingEffort ?? 'medium' });
    const stop = () => { void pi.session.abort(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      if (options.signal?.aborted) return;
      const result = await pi.session.prompt(message);
      if (result.errorMessage && !options.signal?.aborted) onEvent({ type: 'error', error: result.errorMessage });
    } catch (error) {
      // A failed prompt closes the Pi process; the next message starts a new one on the same session file.
      await close(name);
      if (!options.signal?.aborted) {
        onEvent({ type: 'error', error: `Pi stopped: ${error instanceof Error ? error.message : String(error)}` });
      }
    } finally {
      options.signal?.removeEventListener('abort', stop);
      pi.busy = false;
      pi.emit = undefined;
      if (resident.get(name) === pi) {
        pi.idle = setTimeout(() => { if (!pi.busy && resident.get(name) === pi) void close(name); },
          deps.idleMs ?? PI_ORCHESTRATOR_IDLE_MS);
        pi.idle.unref?.();
      }
      done();
    }
  }

  return {
    id: 'pi',
    label: 'Pi',
    peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
      const name = nameFor(repoPath, threadId);
      if (!ensured.has(name)) return null;
      return { sessionName: name, status: resident.get(name)?.busy ? 'busy' : 'ready' };
    },
    ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
      const name = nameFor(repoPath, threadId);
      ensured.add(name);
      return { sessionName: name, status: resident.get(name)?.busy ? 'busy' : 'ready' };
    },
    sendTurn,
    async closeAll() {
      await Promise.allSettled([...resident.keys()].map(close));
    },
  };
}

export const piBackend = createPiOrchestratorBackend();
