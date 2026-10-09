// OFFLINE tests only: no provider calls or real deck rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { z } from 'zod';
import { Dispatcher, type DispatchEvent } from '../src/dispatch.js';
import { Pipeline } from '../src/pipeline.js';
import { allocateCallTimeout, defaultTimeoutAllocator, MAX_CALL_TIMEOUT_MS, type CallTimeoutContext } from '../src/call-timeout.js';
import { fixture, model, usage } from './fixtures.js';
import { checkpointSchema } from '../src/schema.js';
const context: CallTimeoutContext = { role: 'director', provider: 'mock-provider', model: 'mock-exact', effort: 'medium', task: 'Task', callIndex: 1, payloadCharacters: 100, imageCount: 0, maxOutputTokens: 12000 };
const schema = z.object({ objective: z.string(), thesis: z.string(), successCriteria: z.array(z.string()) });

test('default allocation scales with role, input, effort and images, up to a hard cap', () => {
  const short = defaultTimeoutAllocator(context);
  assert.ok(defaultTimeoutAllocator({ ...context, role: 'evidence_researcher', payloadCharacters: 100000 }) > short);
  assert.ok(defaultTimeoutAllocator({ ...context, effort: 'high', imageCount: 1 }) > short);
  assert.equal(defaultTimeoutAllocator({ ...context, payloadCharacters: 650000, imageCount: 20 }), MAX_CALL_TIMEOUT_MS);
});
test('overrides and custom allocators cannot exceed safety bounds or the remaining run budget', () => {
  assert.equal(allocateCallTimeout(context, { allocateTimeout: () => 480000 }), 480000);
  assert.equal(allocateCallTimeout(context, { allocateTimeout: () => { throw new Error('must not execute'); } }, 1000), 1000);
  assert.equal(allocateCallTimeout({ ...context, remainingRunMs: 50 }, {}, 1000), 50);
  for (const value of [0, -1, NaN, Infinity, 1.5, MAX_CALL_TIMEOUT_MS + 1]) {
    assert.throws(() => allocateCallTimeout(context, { allocateTimeout: () => value }), /Allocated/);
  }
  assert.throws(() => allocateCallTimeout(context, { deadlineAt: Infinity }), /deadline/);
  assert.throws(() => allocateCallTimeout({ ...context, remainingRunMs: 0 }, {}), /deadline exceeded/);
  assert.throws(() => allocateCallTimeout({ ...context, remainingRunMs: NaN }, {}), /finite integer/);
});
test('pipeline forwards the orchestrator allocator; transport, event and persisted trace agree', async () => {
  const f = await fixture();
  try {
    const events: DispatchEvent[] = [];
    let allocated: CallTimeoutContext | undefined;
    const pipeline = new Pipeline(f.store, undefined, event => events.push(event), {
      allocateTimeout: request => { allocated = request; return 480000; },
    });
    await pipeline.dispatch.call('director', 'Refine', schema, { text: 'payload' });
    assert.equal(allocated?.role, 'director');
    assert.equal(allocated?.effort, 'medium');
    assert.equal(allocated?.payloadCharacters, JSON.stringify({ text: 'payload' }).length);
    assert.equal(f.registry.calls[0].options?.timeoutMs, 480000);
    assert.equal(f.registry.calls[0].options?.reasoning, 'medium');
    assert.equal(f.registry.calls[0].options?.maxRetries, 0);
    assert.equal(f.store.checkpoint.trace[0].timeoutMs, 480000);
    assert.equal(f.store.checkpoint.trace[0].outcome, 'validated');
    assert.equal(typeof f.store.checkpoint.trace[0].durationMs, 'number');
    assert.equal(events[0].kind, 'start');
    if (events[0].kind === 'start') assert.equal(events[0].timeoutMs, 480000);
    await f.store.load(); // New trace fields survive strict schema validation.
    assert.equal(f.store.checkpoint.trace[0].timeoutMs, 480000);
    const legacy = structuredClone(f.store.checkpoint);
    delete legacy.trace[0].timeoutMs;
    delete legacy.trace[0].durationMs;
    assert.doesNotThrow(() => checkpointSchema.parse(legacy));
  } finally { await f.cleanup(); }
});
test('per-call override is applied; invalid allocation and expired run never start a provider call', async () => {
  const f = await fixture();
  try {
    await new Dispatcher(f.store, undefined, undefined, { allocateTimeout: () => 480000 })
      .call('director', 'Refine', schema, {}, [], { timeoutMs: 1000 });
    assert.equal(f.registry.calls[0].options?.timeoutMs, 1000);
    const count = f.registry.calls.length;
    await assert.rejects(new Dispatcher(f.store, undefined, undefined, { allocateTimeout: () => Infinity }).call('director', 'Refine', schema, {}), /Allocated/);
    await assert.rejects(new Dispatcher(f.store, undefined, undefined, { deadlineAt: Date.now() - 1 }).call('director', 'Refine', schema, {}), /deadline exceeded/);
    assert.equal(f.registry.calls.length, count);
  } finally { await f.cleanup(); }
});
test('allocated timeout aborts even a provider ignoring cancellation; late result cannot become validated', async () => {
  const f = await fixture();
  try {
    f.registry.hang = true;
    const original = f.registry.streamSimple.bind(f.registry);
    let late: ReturnType<typeof original> | undefined;
    f.registry.streamSimple = (...args) => (late = original(...args));
    await assert.rejects(new Dispatcher(f.store, undefined, undefined, { allocateTimeout: () => 30 }).call('director', 'Refine', schema, {}), /30 ms allocated timeout/);
    assert.equal(f.registry.calls[0].options?.signal?.aborted, true);
    late?.end({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: JSON.stringify({ objective: 'late', thesis: 'late', successCriteria: [] }) }], usage, stopReason: 'stop', timestamp: Date.now() });
    await tick();
    assert.equal(f.store.checkpoint.trace[0].outcome, 'error');
  } finally { await f.cleanup(); }
});
test('parent cancellation takes precedence over a longer allocated timeout', async () => {
  const f = await fixture();
  try {
    f.registry.hang = true;
    const controller = new AbortController();
    const pending = new Dispatcher(f.store, controller.signal, event => {
      if (event.kind === 'start') controller.abort(new Error('Run cancelled'));
    }, { allocateTimeout: () => 480000 }).call('director', 'Refine', schema, {});
    await assert.rejects(pending, /Run cancelled/);
    assert.equal(f.registry.calls.length, 0);
    assert.equal(f.store.checkpoint.trace[0].outcome, 'error');
  } finally { await f.cleanup(); }
});

test('absolute run deadline bounds an in-flight provider ignoring cancellation', async () => {
  const f = await fixture();
  try {
    f.registry.hang = true;
    await assert.rejects(new Dispatcher(f.store, undefined, undefined, {
      allocateTimeout: () => 480000, deadlineAt: Date.now() + 500,
    }).call('director', 'Refine', schema, {}), /deadline exceeded|allocated timeout/);
    assert.equal(f.registry.calls.length, 1);
    assert.ok((f.registry.calls[0].options?.timeoutMs ?? Infinity) <= 500);
    assert.equal(f.registry.calls[0].options?.signal?.aborted, true);
    assert.equal(f.store.checkpoint.trace[0].outcome, 'error');
  } finally { await f.cleanup(); }
});
