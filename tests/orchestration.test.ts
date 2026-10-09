// OFFLINE recovery tests. Mock roles and mock slide rendering are not real QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, CALL_BUDGET } from '../src/dispatch.js';
import { executionPlanSchema, directorSchema, evidenceSchema } from '../src/schema.js';
import { validateEvidence } from '../src/evidence.js';
import { fixture, MockPipeline, evidence, model } from './fixtures.js';

const refinement = { objective: 'Explain the pilot', thesis: 'Reliability matters', successCriteria: ['Audience understands evidence'] };

test('execution plans permit agent-selected operating parameters, but not scope/model/QA changes', () => {
  assert.doesNotThrow(() => executionPlanSchema.parse({ maxAttempts: 3, narrativeRevisions: 2, retryDelayMs: 1000, maxOutputTokens: 24000, timeoutsByRole: { evidence_researcher: 480000 } }));
  for (const plan of [{ model: 'fallback' }, { sources: ['new URL'] }, { narrativeGate: 0 }, { maxAttempts: 4 }, { narrativeRevisions: 3 }, { maxOutputTokens: 32001 }, { timeoutsByRole: { evidence_researcher: Infinity } }]) {
    assert.throws(() => executionPlanSchema.parse(plan));
  }
});
test('malformed JSON retries with diagnostic feedback, same identity, and separate audit entries', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.malformed = true;
  const dispatch = new Dispatcher(f.store, undefined, event => { if (event.kind === 'error') f.registry.malformed = false; }, { recovery: { maxAttempts: 2 } });
  const original = { title: 'Original user input' };
  const result = await dispatch.call('director', 'Refine', directorSchema, original);
  assert.equal(result.objective, refinement.objective);
  assert.equal(f.registry.calls.length, 2);
  assert.deepEqual(f.store.checkpoint.trace.map(row => row.outcome), ['error', 'validated']);
  assert.equal(f.store.checkpoint.trace[0].failureKind, 'invalid_output');
  assert.equal(f.store.checkpoint.trace[1].attempt, 2);
  assert.ok(JSON.stringify(f.registry.calls[1].context).includes('recoveryFeedback'));
  assert.deepEqual(original, { title: 'Original user input' });
  assert.ok(f.registry.calls.every(call => call.model.id === model.id && call.options?.reasoning === 'medium' && call.options.maxRetries === 0));
});
test('broken compiler source references go back to the same role without judging quote wording', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let attempts = 0;
  f.registry.responseOverride = () => {
    if (attempts++ === 0) return { claims: [{ id: 'bad', text: 'Claim', citations: [{ sourceId: 'missing_source', quote: 'Paraphrase' }] }], figures: [] };
    return evidence;
  };
  const result = await new Dispatcher(f.store, undefined, undefined, { recovery: { maxAttempts: 2 } })
    .call('evidence_researcher', 'Extract', evidenceSchema, { sources: f.sources }, [], { validate: value => { validateEvidence(value, f.sources); } });
  assert.deepEqual(result, evidence);
  assert.equal(f.store.checkpoint.trace[0].outcome, 'error');
  assert.ok(JSON.stringify(f.registry.calls[1].context).includes('unknown source'));
});
test('validation callbacks cannot transform the original model response', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const result = await new Dispatcher(f.store).call('director', 'Refine', directorSchema, {}, [], {
    validate: value => { value.objective = 'Fabricated replacement'; },
  });
  assert.equal(result.objective, refinement.objective);
});
test('time-out recovery increases the next allocation without switching models', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.hang = true;
  const dispatcher = new Dispatcher(f.store, undefined, event => { if (event.kind === 'error') f.registry.hang = false; }, {
    allocateTimeout: () => 80, recovery: { maxAttempts: 2 },
  });
  await dispatcher.call('director', 'Refine', directorSchema, {});
  assert.deepEqual(f.store.checkpoint.trace.map(row => row.timeoutMs), [80, 120]);
  assert.equal(f.store.checkpoint.trace[0].failureKind, 'timeout');
  assert.equal(f.registry.calls.length, 2);
});
test('synchronous transient provider errors recover; authentication errors remain terminal', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const original = f.registry.streamSimple.bind(f.registry);
  let invocation = 0;
  f.registry.streamSimple = (m, context, options) => {
    if (invocation++ === 0) { f.registry.calls.push({ model: m, context, options }); throw Object.assign(new Error('Unavailable'), { status: 503 }); }
    return original(m, context, options);
  };
  const dispatcher = new Dispatcher(f.store, undefined, undefined, { recovery: { maxAttempts: 2 } });
  dispatcher.applyPlan({ retryDelayMs: 0 });
  await dispatcher.call('director', 'Refine', directorSchema, {});
  assert.equal(f.registry.calls.length, 2);
  assert.equal(f.store.checkpoint.trace[0].failureKind, 'transient');
  f.registry.streamSimple = () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); };
  const count = f.store.checkpoint.trace.length;
  await assert.rejects(dispatcher.call('director', 'Refine', directorSchema, {}), /Unauthorized/);
  assert.equal(f.store.checkpoint.trace.length, count + 1);
});
test('even a permissive recovery policy cannot retry substitution or unapproved work', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.substituted = true;
  const dispatcher = new Dispatcher(f.store, undefined, undefined, { recovery: { maxAttempts: 3, decide: () => { throw new Error('Policy must not execute'); } } });
  await assert.rejects(dispatcher.call('director', 'Refine', directorSchema, {}), /substituted/);
  assert.equal(f.registry.calls.length, 1);
  const unapproved = await fixture(false); t.after(unapproved.cleanup);
  await assert.rejects(new Dispatcher(unapproved.store, undefined, undefined, { recovery: { maxAttempts: 3 } }).call('director', 'Refine', directorSchema, {}));
  assert.equal(unapproved.registry.calls.length, 0);
});
test('retry rechecks approval and cannot bypass the global call budget', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.malformed = true;
  const dispatcher = new Dispatcher(f.store, undefined, undefined, { recovery: { maxAttempts: 3, decide: () => {
    f.registry.available[0].input = ['text'];
    return { action: 'retry' };
  } } });
  await assert.rejects(dispatcher.call('director', 'Refine', directorSchema, {}));
  assert.equal(f.registry.calls.length, 1);
  const limited = await fixture(); t.after(limited.cleanup);
  limited.registry.malformed = true;
  limited.store.checkpoint.trace = Array.from({ length: CALL_BUDGET - 1 }, () => ({ role: 'director', provider: model.provider, model: model.id, effort: 'medium', task: 'Mock prior call', at: new Date().toISOString(), outcome: 'validated' }));
  await limited.store.save();
  await assert.rejects(new Dispatcher(limited.store, undefined, undefined, { recovery: { maxAttempts: 3 } }).call('director', 'Refine', directorSchema, {}));
  assert.equal(limited.registry.calls.length, 1);
  assert.equal(limited.store.checkpoint.trace.length, CALL_BUDGET);
});
test('cancellation interrupts retry backoff and never starts the next call', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.malformed = true;
  const controller = new AbortController();
  const dispatcher = new Dispatcher(f.store, controller.signal, undefined, { recovery: { maxAttempts: 3, decide: () => {
    setTimeout(() => controller.abort(new Error('Cancelled')), 10);
    return { action: 'retry', delayMs: 1000 };
  } } });
  await assert.rejects(dispatcher.call('director', 'Refine', directorSchema, {}));
  assert.equal(f.registry.calls.length, 1);
});
test('director chooses runtime settings and repairs rejected narrative without modifying approved inputs', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.failVisual = 1;
  const fingerprint = await f.store.fingerprint();
  let judgments = 0;
  f.registry.responseOverride = (system, payload) => {
    if (system.includes('Task: Refine')) return { ...refinement, executionPlan: { maxAttempts: 3, maxOutputTokens: 2048, narrativeRevisions: 2, timeoutsByRole: { evidence_researcher: 480000 } } };
    if (system.includes('Task: Accept or reject')) return judgments++ === 0 ? { accepted: false, narrative: 6, rationale: 'Missing coverage: rebuild evidence and argument', executionPlan: { maxOutputTokens: 3072 } } : { accepted: true, narrative: 9, rationale: 'Corrected' };
    return f.registry.response(system, payload);
  };
  const pipeline = new MockPipeline(f.store);
  await pipeline.run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  assert.equal(f.store.checkpoint.narrativeRevision, 1);
  assert.equal(await f.store.fingerprint(), fingerprint);
  assert.equal(f.store.checkpoint.approval?.fingerprint, fingerprint);
  assert.equal(f.store.checkpoint.trace.filter(row => row.role === 'evidence_researcher').length, 2);
  assert.ok(Object.keys(f.store.checkpoint.artifacts).some(file => file.startsWith('orchestration/narrative-rejection-')));
  const extraction = f.registry.calls.find(call => JSON.stringify(call.context.messages[0]).includes("Pi Presenter's evidence_researcher."));
  assert.equal(extraction?.options?.timeoutMs, 480000);
  assert.equal(extraction?.options?.maxTokens, 2048);
  const extractions = f.registry.calls.filter(call => JSON.stringify(call.context.messages[0]).includes("Pi Presenter's evidence_researcher."));
  assert.equal(extractions[1].options?.maxTokens, 3072);
  assert.ok(JSON.stringify(f.registry.calls).includes('repairFeedback'));
  await pipeline.export();
  const savedPlan = await f.store.read('orchestration/execution-plan.json', executionPlanSchema);
  assert.equal(savedPlan.maxOutputTokens, 3072);
  const standalone = new MockPipeline(f.store);
  const workspace = await standalone.workspace();
  await standalone.reviews(workspace.deck, workspace.sources, workspace.evidence, workspace.board, workspace.design);
  assert.equal(standalone.dispatch.executionPlan.maxOutputTokens, 3072);
});
test('narrative failure budget is durable on resume and cannot silently lower the acceptance gate', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.responseOverride = (system, payload) => {
    if (system.includes('Task: Refine')) return { ...refinement, executionPlan: { narrativeRevisions: 1 } };
    if (system.includes('Task: Accept or reject')) return { accepted: true, narrative: 6, rationale: 'Still below gate' };
    return f.registry.response(system, payload);
  };
  const pipeline = new MockPipeline(f.store);
  await assert.rejects(pipeline.run(), /Narrative recovery budget exhausted/);
  assert.equal(f.store.checkpoint.narrativeRevision, 1);
  assert.equal(pipeline.renderCount, 0);
  const count = f.registry.calls.length;
  await assert.rejects(new MockPipeline(f.store).run(), /Narrative recovery budget exhausted/);
  assert.equal(f.registry.calls.length, count);
  await assert.rejects(pipeline.export());
});
test('interrupted narrative repair resumes with saved feedback, not another refinement or reapproval', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.failVisual = 1;
  let reject = true;
  let interrupt = true;
  let extracting = 0;
  f.registry.responseOverride = (system, payload) => {
    if (system.includes('Task: Accept or reject')) {
      if (reject) { reject = false; return { accepted: false, narrative: 6, rationale: 'Add missing supported content' }; }
      return { accepted: true, narrative: 9, rationale: 'Corrected' };
    }
    if (system.includes('Task: Extract') && ++extracting > 1 && interrupt) throw new Error('Mock interruption');
    return f.registry.response(system, payload);
  };
  await assert.rejects(new MockPipeline(f.store).run(), /Mock interruption/);
  assert.equal(f.store.checkpoint.narrativeRevision, 1);
  assert.match(f.store.checkpoint.narrativeFeedback ?? '', /missing supported/);
  assert.equal(f.store.checkpoint.artifacts['narrative/director-acceptance.yaml'], undefined);
  interrupt = false;
  await new MockPipeline(f.store).run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  assert.equal(f.registry.calls.filter(call => JSON.stringify(call.context.messages[0]).includes('Task: Refine')).length, 1);
});

test('plan updates merge role budgets; callers impose ceilings, not fixed retry targets', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const dispatch = new Dispatcher(f.store, undefined, undefined, { recovery: { maxAttempts: 3 } });
  dispatch.applyPlan({ maxAttempts: 1, timeoutsByRole: { evidence_researcher: 480000 } });
  dispatch.applyPlan({ timeoutsByRole: { visual_designer: 300000 } });
  assert.deepEqual(dispatch.executionPlan.timeoutsByRole, { evidence_researcher: 480000, visual_designer: 300000 });
  const snapshot = dispatch.executionPlan;
  snapshot.maxAttempts = 3;
  assert.equal(dispatch.executionPlan.maxAttempts, 1);
  f.registry.malformed = true;
  await assert.rejects(dispatch.call('director', 'Refine', directorSchema, {}));
  assert.equal(f.registry.calls.length, 1);
});
test('distant run deadlines never overflow into immediate Node timers', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const result = await new Dispatcher(f.store, undefined, undefined, { deadlineAt: Date.now() + 2 ** 32 }).call('director', 'Refine', directorSchema, {});
  assert.equal(result.objective, refinement.objective);
});
