// OFFLINE monitoring tests. No real models, network, renderers or live workspace are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { promises as fs } from 'node:fs';
import { Dispatcher, DISPATCH_HEARTBEAT_MS, type DispatchEvent } from '../src/dispatch.js';
import { ProgressMonitor, progressDisplay, progressLines, progressLiveness, MONITOR_STALE_MS, storeProgressWriter, type ProgressSnapshot } from '../src/progress.js';
import { directorSchema } from '../src/schema.js';
import { fixture, compactAgents } from './fixtures.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const start: Extract<DispatchEvent, { kind: 'start' }> = { kind: 'start', role: 'director', unit: 'planner',
  callIndex: 1, callBudget: 180, attempt: 1, provider: 'offline', model: 'mock', effort: 'medium', task: 'Mock task', hasImages: false, timeoutMs: 10000 };
const beat: Extract<DispatchEvent, { kind: 'progress' }> = { kind: 'progress', role: 'director', unit: 'planner',
  callIndex: 1, callBudget: 180, attempt: 1, elapsedMs: 3000, timeoutMs: 10000, remainingMs: 7000 };
const success: DispatchEvent = { kind: 'success', role: 'director', callIndex: 1, callBudget: 180, durationMs: 3000 };

test('in-flight heartbeat reports the actual legacy call; cancellation removes timers/listeners', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.hang = true;
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
  const controller = new AbortController(); const events: DispatchEvent[] = []; const begun = deferred();
  const work = new Dispatcher(f.store, controller.signal, event => { events.push(event); if (event.kind === 'start') begun.resolve(); })
    .call('director', 'Refine', directorSchema, {});
  const rejected = assert.rejects(work, /Cancelled/);
  await begun.promise;
  t.mock.timers.tick(DISPATCH_HEARTBEAT_MS);
  const event = events.at(-1)!; assert.equal(event.kind, 'progress');
  if (event.kind !== 'progress') throw new Error('Expected heartbeat');
  assert.equal(event.role, 'director'); assert.equal(event.unit, undefined);
  assert.equal(event.callIndex, 1); assert.equal(event.attempt, 1); assert.equal(event.elapsedMs, 3000);
  assert.equal(event.remainingMs, event.timeoutMs - 3000); assert.equal(f.registry.calls.length, 1);
  controller.abort(new Error('Cancelled')); await rejected;
  const length = events.length; t.mock.timers.tick(20000); assert.equal(events.length, length);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(events.at(-1)?.kind, 'error');
});

test('compact heartbeat preserves both internal role and actual unit', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.store.configure(compactAgents); await f.store.approve(await f.store.fingerprint(), 'Approve & Start');
  f.registry.hang = true; t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController(); const begun = deferred(); const events: DispatchEvent[] = [];
  const work = new Dispatcher(f.store, controller.signal, e => { events.push(e); if (e.kind === 'start') begun.resolve(); }).call('director', 'Refine', directorSchema, {});
  const rejected = assert.rejects(work); await begun.promise; t.mock.timers.tick(3000);
  assert.equal(events.at(-1)?.unit, 'planner'); assert.equal(events.at(-1)?.role, 'director');
  controller.abort(); await rejected;
});

test('successful pending call clears heartbeat before success and cannot replay later', async t => {
  const f = await fixture(); t.after(f.cleanup); const release = deferred(); const begun = deferred();
  const original = f.registry.streamSimple.bind(f.registry);
  f.registry.streamSimple = (...args) => { const stream = original(...args); const result = stream.result.bind(stream);
    stream.result = async () => { await release.promise; return result(); }; return stream; };
  t.mock.timers.enable({ apis: ['setInterval'] }); const events: DispatchEvent[] = [];
  const work = new Dispatcher(f.store, undefined, e => { events.push(e); if (e.kind === 'start') begun.resolve(); }).call('director', 'Refine', directorSchema, {});
  await begun.promise; t.mock.timers.tick(3000); release.resolve(); await work;
  assert.deepEqual(events.map(e => e.kind), ['start', 'progress', 'success']);
  t.mock.timers.tick(30000); assert.equal(events.length, 3); assert.equal(f.registry.calls.length, 1);
});

test('output errors stop heartbeat and do not turn into success', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.malformed = true;
  t.mock.timers.enable({ apis: ['setInterval'] }); const events: DispatchEvent[] = [];
  await assert.rejects(new Dispatcher(f.store, undefined, e => events.push(e)).call('director', 'Refine', directorSchema, {}));
  t.mock.timers.tick(20000); assert.deepEqual(events.map(e => e.kind), ['start', 'error']);
});

test('allocated timeout clears heartbeat even when provider ignores abort', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.hang = true;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 100000 });
  const begun = deferred(); const events: DispatchEvent[] = [];
  const work = new Dispatcher(f.store, undefined, e => { events.push(e); if (e.kind === 'start') begun.resolve(); }, { allocateTimeout: () => 5000 })
    .call('director', 'Refine', directorSchema, {});
  const rejected = assert.rejects(work, /allocated timeout/); await begun.promise;
  t.mock.timers.tick(3000); assert.equal(events.at(-1)?.kind, 'progress'); t.mock.timers.tick(2000); await rejected;
  const length = events.length; t.mock.timers.tick(30000); assert.equal(events.length, length);
  assert.equal(f.store.checkpoint.trace[0].failureKind, 'timeout');
});

test('retry starts a new call index with the real attempt; only that attempt has heartbeats', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.malformed = true;
  t.mock.timers.enable({ apis: ['setInterval'] }); const begun = deferred(); const controller = new AbortController();
  const events: DispatchEvent[] = [];
  const work = new Dispatcher(f.store, controller.signal, e => {
    events.push(e);
    if (e.kind === 'error') { f.registry.malformed = false; f.registry.hang = true; }
    if (e.kind === 'start' && e.attempt === 2) begun.resolve();
  }, { recovery: { maxAttempts: 2 } }).call('director', 'Refine', directorSchema, {});
  const rejected = assert.rejects(work); await begun.promise; t.mock.timers.tick(3000);
  const event = events.at(-1)!; assert.equal(event.kind, 'progress'); assert.equal(event.callIndex, 2);
  if (event.kind === 'progress') assert.equal(event.attempt, 2);
  assert.deepEqual(events.map(e => e.kind), ['start', 'error', 'start', 'progress']);
  assert.equal(f.registry.calls.length, 2); controller.abort(); await rejected;
  const length = events.length; t.mock.timers.tick(12000); assert.equal(events.length, length);
});

test('throwing notifications at start/progress/success never break a valid call', async t => {
  const f = await fixture(); t.after(f.cleanup); const release = deferred(); const begun = deferred();
  const original = f.registry.streamSimple.bind(f.registry);
  f.registry.streamSimple = (...args) => { const stream = original(...args); const result = stream.result.bind(stream);
    stream.result = async () => { await release.promise; return result(); }; return stream; };
  t.mock.timers.enable({ apis: ['setInterval'] });
  const work = new Dispatcher(f.store, undefined, e => { if (e.kind === 'start') begun.resolve(); throw new Error('Broken UI'); }).call('director', 'Refine', directorSchema, {});
  await begun.promise; assert.doesNotThrow(() => t.mock.timers.tick(3000)); release.resolve();
  assert.equal((await work).thesis, 'Reliability matters'); assert.equal(f.registry.calls.length, 1);
});

test('unapproved work produces neither start nor heartbeat nor model calls', async t => {
  const f = await fixture(false); t.after(f.cleanup); const events: DispatchEvent[] = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  await assert.rejects(new Dispatcher(f.store, undefined, e => events.push(e)).call('director', 'Refine', directorSchema, {}));
  t.mock.timers.tick(20000); assert.equal(events.length, 0); assert.equal(f.registry.calls.length, 0);
});

test('monitor polls actual checkpoint stages without replaying old started trace entries', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
  const checkpoint = { state: 'RESEARCH' as const, trace: [{}] };
  const monitor = new ProgressMonitor({ checkpoint: () => checkpoint }); monitor.start(); monitor.phase('pipeline');
  const initial = monitor.snapshot; assert.equal(initial.current, undefined); assert.equal(initial.phase, 'research');
  monitor.dispatch(start); t.mock.timers.tick(6000);
  assert.equal(monitor.snapshot.current?.elapsedMs, 6000); assert.equal(monitor.snapshot.current?.remainingMs, 4000);
  await monitor.finish('complete'); const snapshot = monitor.snapshot;
  t.mock.timers.tick(20000); assert.deepEqual(monitor.snapshot, snapshot); assert.equal(snapshot.heartbeatAt, undefined);
});

test('monitor rejects late heartbeats after success or across call attempts', async () => {
  const monitor = new ProgressMonitor({ checkpoint: () => ({ state: 'RESEARCH', trace: [] }) });
  monitor.start(); monitor.dispatch(start); monitor.dispatch(success); const settled = monitor.snapshot;
  monitor.dispatch(beat); assert.deepEqual(monitor.snapshot, settled);
  monitor.dispatch({ ...start, callIndex: 2, attempt: 2 }); const next = monitor.snapshot;
  monitor.dispatch(beat); assert.deepEqual(monitor.snapshot, next);
  await monitor.finish('complete'); const ended = monitor.snapshot; monitor.dispatch(start); monitor.dispatch(beat);
  assert.deepEqual(monitor.snapshot, ended);
});

test('serialized/coalesced writes drain before final status; no running write can win afterward', async () => {
  const release = deferred(); const writing = deferred(); const writes: ProgressSnapshot[] = []; let active = 0; let maximum = 0;
  const monitor = new ProgressMonitor({ checkpoint: () => ({ state: 'RESEARCH', trace: [] }), write: async snapshot => {
    active++; maximum = Math.max(active, maximum); writes.push(snapshot);
    if (writes.length === 1) { writing.resolve(); await release.promise; } active--;
  } });
  monitor.start(); await writing.promise;
  for (let i = 0; i < 100; i++) monitor.phase(`phase-${i}`);
  let finished = false; const end = monitor.finish('error', 'Offline failure').then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(writes.length, 1);
  release.resolve(); await end; assert.equal(maximum, 1); assert.equal(active, 0); assert.equal(writes.length, 2);
  assert.equal(writes.at(-1)?.status, 'error'); assert.equal(writes.at(-1)?.heartbeatAt, undefined);
});

test('cancellation immediately removes heartbeat/listener and drains a terminal snapshot', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const controller = new AbortController(); const writes: ProgressSnapshot[] = [];
  const monitor = new ProgressMonitor({ checkpoint: () => ({ state: 'BUILD', trace: [] }), signal: controller.signal,
    write: async snapshot => { writes.push(snapshot); } });
  monitor.start(); monitor.dispatch(start); controller.abort(new Error('Offline cancelled'));
  await monitor.finish('cancelled'); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const count = writes.length; t.mock.timers.tick(20000); await Promise.resolve(); assert.equal(writes.length, count);
  assert.equal(writes.at(-1)?.status, 'cancelled'); assert.equal(writes.at(-1)?.current, undefined);
  assert.equal(writes.at(-1)?.heartbeatAt, undefined);
});

test('throwing checkpoint, display and writer are isolated and reported, including final write', async () => {
  const monitor = new ProgressMonitor({ checkpoint: () => { throw new Error('Checkpoint unavailable'); },
    display: () => { throw new Error('UI unavailable'); }, write: () => { throw new Error('Disk unavailable'); } });
  assert.doesNotThrow(() => monitor.start()); monitor.dispatch(start); await monitor.finish('error', 'Real failure');
  assert.equal(monitor.snapshot.status, 'error'); assert.equal(monitor.snapshot.lastFailure, 'Real failure');
  assert.match(monitor.snapshot.monitorError!, /Disk unavailable/);
});

test('stale/missing/dead-PID heartbeats are stopped, never displayed as running', async () => {
  const monitor = new ProgressMonitor({ checkpoint: () => ({ state: 'RESEARCH', trace: [] }) });
  monitor.start(); monitor.dispatch(start); const live = monitor.snapshot;
  assert.equal(progressLiveness(live), 'running'); assert.equal(progressLiveness(live, Date.now(), false), 'stopped');
  assert.equal(progressLiveness({ ...live, heartbeatAt: undefined }), 'stopped');
  const stale = { ...live, heartbeatAt: new Date(Date.now() - MONITOR_STALE_MS - 1).toISOString() };
  assert.equal(progressLiveness(stale), 'stopped'); assert.match(progressLines(stale)[0], /stopped/);
  assert.ok(!progressLines(stale).some(line => line.includes('elapsed=')));
  await monitor.finish('complete'); assert.equal(progressLiveness(monitor.snapshot), 'complete');
});

test('persistent file ends complete without heartbeat/current call, with bounded diagnostics', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const monitor = new ProgressMonitor({ checkpoint: () => f.store.checkpoint, write: storeProgressWriter(f.store) });
  monitor.start(); monitor.dispatch({ ...start, task: 'x'.repeat(100000) });
  monitor.dispatch({ kind: 'error', role: 'director', callIndex: 1, callBudget: 180, durationMs: 1, error: 'x'.repeat(100000) });
  await monitor.finish('complete');
  const file = await fs.readFile(await f.store.file('live-test/progress.json'), 'utf8'); const saved = JSON.parse(file);
  assert.equal(saved.status, 'complete'); assert.equal(saved.heartbeatAt, undefined); assert.equal(saved.current, undefined);
  assert.equal(saved.pid, process.pid); assert.equal(saved.lastFailure.length, 1000); assert.ok(file.length < 4096);
  assert.deepEqual(f.store.checkpoint.trace, []); // Progress is not a model call or a gate mutation.
});

test('UI summary shows exact role/unit/attempt/elapsed/last failure, without percentages or ETA', async () => {
  const lines: string[][] = []; const monitor = new ProgressMonitor({ checkpoint: () => ({ state: 'RESEARCH', trace: [{}] }),
    display: progressDisplay({ setStatus() { throw new Error('Status unavailable'); }, setWidget(_key, value) { lines.push(value!); } }, 'offline') });
  monitor.start(); monitor.dispatch(start);
  monitor.dispatch({ kind: 'error', role: 'director', callIndex: 1, callBudget: 180, durationMs: 1, error: 'Rejected output' });
  monitor.dispatch({ ...start, callIndex: 2, attempt: 2 }); const text = lines.at(-1)!.join('\n');
  for (const expected of ['state=RESEARCH', 'role=director', 'unit=planner', 'attempt=2', 'elapsed=', 'timeout=', 'Last failure: Rejected output']) assert.ok(text.includes(expected), expected);
  assert.ok(!/\bETA\b|%/.test(text)); await monitor.finish('complete');
});
