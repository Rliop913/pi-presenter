import type { DispatchEvent } from './dispatch.js';
import type { State, Role, Unit } from './schema.js';
import { atomicWrite, type Store } from './storage.js';

export const MONITOR_HEARTBEAT_MS = 3000;
export const MONITOR_STALE_MS = 12000;
export type ProgressStatus = 'start' | 'running' | 'error' | 'complete' | 'cancelled';
export interface CurrentCall {
  role: Role; unit?: Unit; callIndex: number; callBudget: number; attempt: number;
  provider: string; model: string; effort: string; task: string;
  startedAt: number; elapsedMs: number; timeoutMs: number; remainingMs: number;
}
export interface ProgressSnapshot {
  version: 1; status: ProgressStatus; pid: number; startedAt: string; updatedAt: string;
  heartbeatAt?: string; state: State; phase: string; modelCalls: number;
  current?: CurrentCall; lastFailure?: string; monitorError?: string;
}
export interface ProgressUI {
  setStatus?(key: string, text: string | undefined): void;
  setWidget?(key: string, lines: string[] | undefined): void;
}
interface MonitorOptions {
  checkpoint: () => { state: State; trace: readonly unknown[]; error?: string };
  signal?: AbortSignal;
  display?: (snapshot: ProgressSnapshot) => void;
  /** One write in flight, at most one latest pending snapshot; failures are isolated. */
  write?: (snapshot: ProgressSnapshot) => Promise<void>;
}
const bounded = (value: unknown, limit = 1000) => String(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** A saved running status is NOT proof of a live process. Missing/stale heartbeat means stopped/unknown. */
export function progressLiveness(snapshot: ProgressSnapshot, now = Date.now(), pidAlive = true): ProgressStatus | 'stopped' {
  if (snapshot.status !== 'running' && snapshot.status !== 'start') return snapshot.status;
  const beat = Date.parse(snapshot.heartbeatAt ?? '');
  return !pidAlive || !Number.isFinite(beat) || now - beat > MONITOR_STALE_MS || beat > now + MONITOR_STALE_MS
    ? 'stopped' : snapshot.status;
}
export function progressLines(snapshot: ProgressSnapshot): string[] {
  const status = progressLiveness(snapshot);
  const lines = [`Presenter ${status} | state=${snapshot.state} | phase=${snapshot.phase} | calls=${snapshot.modelCalls}`];
  const call = snapshot.current;
  if (call && (status === 'running' || status === 'start')) {
    lines.push(`role=${call.role}${call.unit ? ` | unit=${call.unit}` : ''} | call=${call.callIndex}/${call.callBudget} | attempt=${call.attempt}`);
    lines.push(`${call.provider}/${call.model} | effort=${call.effort} | elapsed=${seconds(call.elapsedMs)} | timeout=${seconds(call.timeoutMs)} | remaining limit=${seconds(call.remainingMs)}`);
  }
  if (snapshot.lastFailure) lines.push(`Last failure: ${snapshot.lastFailure}`);
  if (snapshot.monitorError) lines.push(`Monitor unavailable: ${snapshot.monitorError}`);
  return lines;
}
export function progressDisplay(ui: ProgressUI, key: string): (snapshot: ProgressSnapshot) => void {
  return snapshot => {
    const lines = progressLines(snapshot);
    try { ui.setStatus?.(key, lines.slice(0, 2).join(' | ')); } catch { /* UI cannot affect work */ }
    try { ui.setWidget?.(key, lines); } catch { /* UI cannot affect work */ }
  };
}
export function storeProgressWriter(store: Store): (snapshot: ProgressSnapshot) => Promise<void> {
  return async snapshot => atomicWrite(await store.file('live-test/progress.json'), JSON.stringify(snapshot, null, 2));
}

/** Observes the real checkpoint and live dispatch events only. Never replays a trace or changes gates. */
export class ProgressMonitor {
  private value: ProgressSnapshot;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: ProgressSnapshot;
  private writing?: Promise<void>;
  private closed = false;
  private started = false;
  private pipelinePhase = false;
  private abort = () => { void this.finish('cancelled', this.options.signal?.reason ?? 'Cancelled'); };
  constructor(private readonly options: MonitorOptions) {
    const now = new Date().toISOString();
    this.value = { version: 1, status: 'start', pid: process.pid, startedAt: now, updatedAt: now,
      state: 'UNINITIALIZED', phase: 'startup', modelCalls: 0 };
  }
  get snapshot(): ProgressSnapshot { return structuredClone(this.value); }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.publish();
    this.timer = setInterval(() => this.publish(), MONITOR_HEARTBEAT_MS);
    this.timer.unref();
    this.options.signal?.addEventListener('abort', this.abort, { once: true });
    if (this.options.signal?.aborted) this.abort();
  }
  phase(phase: string): void {
    if (this.closed) return;
    this.value.phase = bounded(phase, 120);
    this.pipelinePhase = phase === 'pipeline';
    this.value.status = 'running';
    this.publish();
  }
  dispatch = (event: DispatchEvent): void => {
    if (this.closed) return;
    switch (event.kind) {
      case 'start':
        this.value.status = 'running';
        this.value.current = { role: event.role, unit: event.unit, callIndex: event.callIndex, callBudget: event.callBudget,
          attempt: event.attempt ?? 1, provider: bounded(event.provider, 120), model: bounded(event.model, 120),
          effort: bounded(event.effort, 40), task: bounded(event.task, 240), startedAt: Date.now(),
          elapsedMs: 0, timeoutMs: event.timeoutMs, remainingMs: event.timeoutMs };
        break;
      case 'progress':
        // Never resurrect a finished call or accept a late heartbeat from a previous attempt.
        if (!this.value.current || this.value.current.callIndex !== event.callIndex || this.value.current.attempt !== event.attempt) return;
        Object.assign(this.value.current, { elapsedMs: event.elapsedMs, remainingMs: event.remainingMs });
        break;
      case 'success':
      case 'error':
        if (this.value.current?.callIndex !== event.callIndex) return;
        if (event.kind === 'error') this.value.lastFailure = bounded(event.error);
        delete this.value.current;
        break;
      default: { const exhaustive: never = event; return exhaustive; }
    }
    this.publish();
  };
  /** Drain all observational writes before the owner releases its operation lock. Idempotent cleanup. */
  async finish(status: 'error' | 'complete' | 'cancelled', error?: unknown): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      this.options.signal?.removeEventListener('abort', this.abort);
      this.value.status = status;
      this.value.phase = status;
      delete this.value.current;
      delete this.value.heartbeatAt;
    }
    if (error !== undefined) this.value.lastFailure = bounded(error);
    this.publish();
    // A pending snapshot may be coalesced while an earlier write is awaiting I/O.
    while (this.writing) await this.writing;
  }
  private publish(): void {
    try {
      const checkpoint = this.options.checkpoint();
      this.value.state = checkpoint.state;
      if (!this.closed && this.pipelinePhase) this.value.phase = checkpoint.state.toLowerCase();
      this.value.modelCalls = checkpoint.trace.length;
      if (checkpoint.error) this.value.lastFailure = bounded(checkpoint.error);
    } catch (error) { this.value.monitorError = bounded(error, 240); }
    const now = Date.now();
    this.value.updatedAt = new Date(now).toISOString();
    if (!this.closed) this.value.heartbeatAt = this.value.updatedAt;
    if (this.value.current) {
      this.value.current.elapsedMs = Math.max(0, now - this.value.current.startedAt);
      this.value.current.remainingMs = Math.max(0, this.value.current.timeoutMs - this.value.current.elapsedMs);
    }
    const snapshot = this.snapshot;
    try { this.options.display?.(snapshot); } catch { /* monitoring is never an execution gate */ }
    if (!this.options.write) return;
    this.pending = this.snapshot;
    this.pump();
  }
  private pump(): void {
    const write = this.options.write;
    if (!write) return;
    if (!this.writing && this.pending) {
      // Begin in a microtask so writing is set even when the writer throws synchronously.
      this.writing = Promise.resolve().then(async () => {
        while (this.pending) {
          const next = this.pending; this.pending = undefined;
          try { await write(next); }
          catch (error) {
            this.value.monitorError = bounded(error, 240);
            try { this.options.display?.(this.snapshot); } catch { /* non-fatal */ }
          }
        }
      }).finally(() => { this.writing = undefined; this.pump(); });
    }
  }
}
