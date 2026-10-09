// OFFLINE language flow / compiler boundary tests. Models are mocks throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { compactFixture, handoff, rawResearch, rawPlanning } from './natural-fixtures.js';
import { MockPipeline, contract } from './fixtures.js';
import { compilerHandoffFile, compilerHandoffSchema, prepareNaturalFlow, validateCompilerHandoff } from '../src/natural-flow.js';

function payload(context: Context): Record<string, unknown> {
  const user = context.messages[1];
  assert.ok(user.role === 'user' && Array.isArray(user.content) && user.content[0].type === 'text');
  return JSON.parse(user.content[0].text);
}
function system(context: Context): string {
  const first = context.messages[0];
  assert.ok(first.role === 'system' && typeof first.content === 'string');
  return first.content;
}

test('prose stays untouched across scalar YAML caches and every downstream context', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  // Deliberately not JSON, beyond old linguistic bounds, multilingual, CRLF, whitespace.
  f.notes.research = rawResearch + '来源与语义，而不是字面匹配。\n'.repeat(250);
  f.notes.planning = rawPlanning + '  A narrative can explain uncertainty in its own words.\n'.repeat(100);
  const result = await prepareNaturalFlow(new MockPipeline(f.store), contract);
  assert.deepEqual(result.deck, handoff.deck);
  assert.equal(f.registry.calls.length, 4);
  assert.equal(await f.store.read('evidence/research-notes.yaml', z.string()), f.notes.research);
  assert.equal(await f.store.read('narrative/planning-notes.yaml', z.string()), f.notes.planning);
  const [research, planner, reviewer, builder] = f.registry.calls;
  for (const call of [research, planner]) {
    assert.ok(!system(call.context).includes('Schema:'));
    assert.ok(!system(call.context).includes('Return exactly one JSON'));
  }
  assert.equal(payload(planner.context).research, f.notes.research);
  for (const call of [reviewer, builder]) {
    assert.equal(payload(call.context).research, f.notes.research);
    assert.equal(payload(call.context).planning, f.notes.planning);
    assert.deepEqual(payload(call.context).sources, f.sources);
  }
  assert.ok(system(reviewer.context).includes("Pi Presenter's fact_reviewer."));
  assert.ok(!('evidence' in payload(reviewer.context)));
  assert.ok(!('argument' in payload(reviewer.context)));
});

test('compiler handoff accepts semantic paraphrases and reformatted numerical language', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const adapted = structuredClone(handoff);
  adapted.evidence.claims[1].text = 'Alpha handled one hundred requests (100 in the pilot).';
  adapted.evidence.claims[1].citations[0].quote = 'The approved pilot report gives Alpha a total of one hundred requests.';
  adapted.evidence.figures[0].quote = 'Alpha: one hundred; Beta: two hundred; requests are the unit.';
  adapted.evidence.figures[0].labels = ['Alpha pilot', 'Beta pilot'];
  adapted.evidence.figures[0].unit = 'requests processed';
  adapted.board.slides[1].title = 'A 100-request pilot — limited evidence';
  adapted.deck.slides[1].title = '100 pilot requests: evidence, not a forecast';
  assert.doesNotThrow(() => validateCompilerHandoff(adapted, f.sources, contract));
  const baseline = f.registry.responseOverride!;
  f.registry.responseOverride = (task, input) => task.includes('Task: Build ONE') ? adapted : baseline(task, input);
  await new MockPipeline(f.store).run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  await new MockPipeline(f.store).export();
});

test('compiler boundary still rejects unknown references, figure cardinality and unapproved counts', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const unknown = structuredClone(handoff);
  unknown.evidence.claims[0].citations[0].sourceId = 'not_approved';
  assert.throws(() => validateCompilerHandoff(unknown, f.sources, contract), /source|citation/i);
  const count = structuredClone(handoff);
  count.board.slides.pop();
  assert.throws(() => validateCompilerHandoff(count, f.sources, contract), /approved slide count/);
  const figure = structuredClone(handoff);
  figure.evidence.figures[0].values.pop();
  assert.throws(() => validateCompilerHandoff(figure, f.sources, contract), /labels\/value length/);
  const layout = structuredClone(handoff);
  layout.deck.slides[0].layout = 'chart';
  assert.throws(() => validateCompilerHandoff(layout, f.sources, contract), /figure/);
});

test('accepted=true does not bypass independent narrative score threshold', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const baseline = f.registry.responseOverride!;
  let verdicts = 0;
  f.registry.responseOverride = (task, input) => {
    if (task.includes('Task: Accept or reject')) return { accepted: true, narrative: verdicts++ === 0 ? 7.9 : 8, rationale: 'Clarify coverage' };
    return baseline(task, input);
  };
  await prepareNaturalFlow(new MockPipeline(f.store), contract);
  assert.equal(verdicts, 2);
  assert.equal(f.store.checkpoint.narrativeRevision, 1);
  assert.equal(f.notes.researchCalls, 2);
  assert.equal(f.notes.planningCalls, 2);
  const repairs = f.registry.calls.filter(call => 'repairFeedback' in payload(call.context));
  assert.equal(repairs.length, 2);
  assert.ok(repairs.every(call => payload(call.context).repairFeedback === 'Clarify coverage'));
});

test('repeated independent rejection exhausts shared narrative counters and preserves raw archives', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const baseline = f.registry.responseOverride!;
  f.registry.responseOverride = (task, input) => task.includes('Task: Accept or reject')
    ? { accepted: false, narrative: 6, rationale: 'Missing supported coverage' } : baseline(task, input);
  const approval = await f.store.fingerprint();
  await assert.rejects(prepareNaturalFlow(new MockPipeline(f.store), contract), /Narrative recovery budget exhausted/);
  assert.equal(f.store.checkpoint.narrativeRevision, 2);
  assert.equal(f.notes.researchCalls, 3);
  assert.equal(f.notes.planningCalls, 3);
  assert.ok(!f.store.checkpoint.artifacts[compilerHandoffFile]);
  const archives = Object.keys(f.store.checkpoint.artifacts).filter(file => file.startsWith('orchestration/narrative-rejection-'));
  assert.equal(archives.length, 2);
  for (const file of archives) {
    const archived = await f.store.read(file, z.object({ research: z.string(), planning: z.string(), sources: z.unknown() }));
    assert.equal(archived.research, rawResearch);
    assert.equal(archived.planning, rawPlanning);
    assert.deepEqual(archived.sources, f.sources);
  }
  const calls = f.registry.calls.length;
  await assert.rejects(prepareNaturalFlow(new MockPipeline(f.store), contract), /Narrative recovery budget exhausted/);
  assert.equal(f.registry.calls.length, calls); // Resume cannot reset the repair budget.
  assert.equal(await f.store.fingerprint(), approval);
});

test('repair invalidates raw notes, old bundles and all compiler/render/review/output projections', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  await f.store.artifact('evidence/research-notes.yaml', 'Old research');
  await f.store.artifact('narrative/planning-notes.yaml', 'Old planning');
  await f.store.artifact('narrative/director-acceptance.yaml', { accepted: false, narrative: 5, rationale: 'Revisit coverage' });
  for (const file of [compilerHandoffFile, 'narrative/planning-bundle.json', 'design/building-bundle.json',
    'evidence/evidence.json', 'evidence/claims.json', 'evidence/figures.json',
    'narrative/director-contract.yaml', 'narrative/argument-map.yaml', 'narrative/storyboard.yaml',
    'config/design-system.yaml', 'deck/deck-spec.yaml', 'renders/stale.json', 'reviews/stale.json', 'output/stale.json']) {
    await f.store.artifact(file, { stale: true });
  }
  const result = await prepareNaturalFlow(new MockPipeline(f.store), contract);
  assert.equal(f.store.checkpoint.narrativeRevision, 1);
  assert.deepEqual(result.deck, handoff.deck);
  assert.equal(f.notes.researchCalls, 1);
  assert.equal(f.notes.planningCalls, 1);
  for (const old of ['narrative/planning-bundle.json', 'design/building-bundle.json', 'renders/stale.json', 'reviews/stale.json', 'output/stale.json']) {
    assert.ok(!f.store.checkpoint.artifacts[old], old);
  }
  assert.equal(await f.store.read('evidence/research-notes.yaml', z.string()), rawResearch);
  assert.deepEqual(await f.store.read(compilerHandoffFile, compilerHandoffSchema), handoff);
  const archive = Object.keys(f.store.checkpoint.artifacts).find(file => file.startsWith('orchestration/narrative-rejection-'))!;
  const rejected = await f.store.read(archive, z.object({ research: z.string(), planning: z.string() }));
  assert.equal(rejected.research, 'Old research');
  assert.equal(rejected.planning, 'Old planning');
});

test('interruption after raw planning uses cached prose unchanged on resume', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const artifact = f.store.artifact.bind(f.store);
  let interrupted = false;
  f.store.artifact = async (file, value) => {
    if (file === 'narrative/director-acceptance.yaml' && !interrupted) { interrupted = true; throw new Error('Mock verdict persistence interruption'); }
    await artifact(file, value);
  };
  await assert.rejects(prepareNaturalFlow(new MockPipeline(f.store), contract), /persistence interruption/);
  f.store.artifact = artifact;
  f.notes.research = 'Changed mock — must not replace cached research';
  f.notes.planning = 'Changed mock — must not replace cached planning';
  await prepareNaturalFlow(new MockPipeline(f.store), contract);
  assert.equal(f.notes.researchCalls, 1);
  assert.equal(f.notes.planningCalls, 1);
  const builder = f.registry.calls.find(call => system(call.context).includes('Task: Build ONE'))!;
  assert.equal(payload(builder.context).research, rawResearch);
  assert.equal(payload(builder.context).planning, rawPlanning);
});

test('compact reviewer cannot change planner operating plan through acceptance control', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const baseline = f.registry.responseOverride!;
  f.registry.responseOverride = (task, input) => task.includes('Task: Accept or reject')
    ? { accepted: true, narrative: 9, rationale: 'Accepted', executionPlan: { narrativeRevisions: 0, maxAttempts: 1 } } : baseline(task, input);
  const pipeline = new MockPipeline(f.store);
  await pipeline.run();
  assert.equal(pipeline.dispatch.executionPlan.narrativeRevisions, 2);
  assert.equal(pipeline.dispatch.executionPlan.maxAttempts, 2);
});

test('post-render fact and image reviewers receive sources plus original narrative', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  await new MockPipeline(f.store).run();
  const postrender = f.registry.calls.filter(call => /Task: Audit factual|Task: Inspect/.test(system(call.context)));
  assert.equal(postrender.length, 3);
  for (const call of postrender) {
    assert.deepEqual(payload(call.context).sources, f.sources);
    assert.deepEqual(payload(call.context).narrative, { research: rawResearch, planning: rawPlanning });
  }
});

test('raw cache tampering and missing artifacts block complete workspace/export', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const pipeline = new MockPipeline(f.store);
  await pipeline.run();
  await f.store.artifact('narrative/planning-notes.yaml', 'A changed plan after QA');
  await assert.rejects(pipeline.export(), /stale review hashes/);
  await f.store.artifact('narrative/planning-notes.yaml', rawPlanning);
  await pipeline.export();
  await f.store.forget(['evidence/research-notes.yaml']);
  await assert.rejects(pipeline.export(), /Workspace is incomplete/);
});

test('raw researcher still enforces exact identity and effort before caching', async t => {
  for (const failure of ['substituted', 'clamped'] as const) {
    const f = await compactFixture(); t.after(f.cleanup);
    f.registry[failure] = true;
    await assert.rejects(prepareNaturalFlow(new MockPipeline(f.store), contract), /substituted|effort/);
    assert.equal(f.registry.calls.length, 1);
    assert.ok(!f.store.checkpoint.artifacts['evidence/research-notes.yaml']);
  }
});

test('raw stages respect cancellation and allocated timeout without adopting late output', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled natural flow'));
  await assert.rejects(prepareNaturalFlow(new MockPipeline(f.store, controller.signal), contract), /Cancelled natural flow/);
  assert.equal(f.registry.calls.length, 0);
  f.registry.hang = true;
  await assert.rejects(prepareNaturalFlow(new MockPipeline(f.store, undefined, undefined, { allocateTimeout: () => 20, recovery: { maxAttempts: 1 } }), contract), /allocated timeout/);
  assert.equal(f.registry.calls.length, 1);
  assert.equal(f.store.checkpoint.trace.at(-1)?.failureKind, 'timeout');
  assert.ok(!f.store.checkpoint.artifacts['evidence/research-notes.yaml']);
});
