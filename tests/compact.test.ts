// OFFLINE four-unit integration: mocked models/rendering, real PPTX compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MockPipeline, board, evidence } from './fixtures.js';
import { compactFixture, rawResearch, rawPlanning } from './natural-fixtures.js';
import { units, deckSchema } from '../src/schema.js';
import { compilerHandoffFile, compilerHandoffSchema } from '../src/natural-flow.js';

test('four-unit happy path uses raw planning/research, one compiler handoff and independent review contexts', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const events: string[] = [];
  const pipeline = new MockPipeline(f.store, undefined, event => { if (event.kind === 'start') events.push(event.unit ?? event.role); });
  await pipeline.run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  assert.equal(f.registry.calls.length, 7); // 2 prose stages + verdict + builder + fact + 2 image reviews.
  assert.deepEqual(events, ['researcher', 'planner', 'reviewer', 'builder', 'reviewer', 'reviewer', 'reviewer']);
  assert.ok(f.store.checkpoint.trace.every(row => row.unit && units.includes(row.unit)));
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'planner').length, 1);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'builder').length, 1);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'reviewer').length, 4);
  const reviewCalls = f.registry.calls.filter(call => JSON.stringify(call.context.messages[0]).includes("Pi Presenter's fact_reviewer.") || JSON.stringify(call.context.messages[0]).includes("Pi Presenter's visual_reviewer."));
  assert.equal(reviewCalls.length, 4);
  const imageCounts = reviewCalls.map(call => {
    const user = call.context.messages[1];
    return user.role === 'user' && Array.isArray(user.content) ? user.content.filter(block => block.type === 'image').length : 0;
  });
  assert.deepEqual(imageCounts, [0, 0, 1, 1]);
  assert.equal(await f.store.read('evidence/research-notes.yaml', z.string()), rawResearch);
  assert.equal(await f.store.read('narrative/planning-notes.yaml', z.string()), rawPlanning);
  await f.store.read(compilerHandoffFile, compilerHandoffSchema);
  assert.ok(!f.store.checkpoint.artifacts['narrative/planning-bundle.json']);
  await pipeline.export();
  const count = f.registry.calls.length;
  await new MockPipeline(f.store).run();
  assert.equal(f.registry.calls.length, count);
});

test('compact configuration cannot execute before its own explicit approval', async t => {
  const f = await compactFixture(false); t.after(f.cleanup);
  await assert.rejects(new MockPipeline(f.store).run(), /Approve & Start/);
  assert.equal(f.registry.calls.length, 0);
});

test('independent narrative rejection regenerates both raw stages within the same approved scope', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const baseline = f.registry.responseOverride!;
  let judgments = 0;
  f.registry.responseOverride = (system, payload) => {
    if (system.includes('Task: Accept or reject')) return judgments++ === 0
      ? { accepted: false, narrative: 6, rationale: 'Missing supported coverage' }
      : { accepted: true, narrative: 9, rationale: 'Corrected' };
    return baseline(system, payload);
  };
  const fingerprint = await f.store.fingerprint();
  await new MockPipeline(f.store).run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  assert.equal(f.store.checkpoint.narrativeRevision, 1);
  assert.equal(await f.store.fingerprint(), fingerprint);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'planner').length, 2);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'researcher').length, 2);
  assert.ok(f.registry.calls.filter(call => JSON.stringify(call.context.messages[0]).includes('Task: Accept or reject')).every(call => JSON.stringify(call.context.messages[0]).includes("Pi Presenter's fact_reviewer.")));
});

test('invalid compiler references are retried before projection, without normalizing the prose stages', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const baseline = f.registry.responseOverride!;
  let builds = 0;
  f.registry.responseOverride = (system, payload) => {
    const result = baseline(system, payload);
    if (system.includes('Task: Build ONE') && builds++ === 0) {
      const bad = compilerHandoffSchema.parse(result);
      bad.board.slides[0].claimIds = ['invented'];
      return bad;
    }
    return result;
  };
  await new MockPipeline(f.store).run();
  assert.equal(builds, 2);
  assert.equal(f.store.checkpoint.trace.find(row => row.unit === 'builder')?.outcome, 'error');
  assert.equal(f.notes.researchCalls, 1);
  assert.equal(f.notes.planningCalls, 1);
  const bundle = await f.store.read(compilerHandoffFile, compilerHandoffSchema);
  assert.deepEqual(bundle.board, board);
  assert.deepEqual(bundle.argument.sections[0].claimIds, evidence.claims.map(claim => claim.id));
});

test('interrupted compiler projection resumes without repeating text stages or builder', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  const artifact = f.store.artifact.bind(f.store);
  let interrupted = false;
  f.store.artifact = async (path, value) => {
    if (path === 'narrative/argument-map.yaml' && !interrupted) { interrupted = true; throw new Error('Mock projection interruption'); }
    await artifact(path, value);
  };
  await assert.rejects(new MockPipeline(f.store).run(), /Mock projection interruption/);
  assert.ok(f.store.checkpoint.artifacts[compilerHandoffFile]);
  f.store.artifact = artifact;
  await new MockPipeline(f.store).run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'planner').length, 1);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'researcher').length, 1);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'builder').length, 1);
});

test('resume after an applied QA patch does not overwrite it with the cached compiler baseline', async t => {
  const f = await compactFixture(); t.after(f.cleanup);
  f.registry.failVisual = 0;
  class Interrupted extends MockPipeline {
    protected override async renderDeck(slides: { id: string }[]) {
      if (this.store.checkpoint.revision === 1) throw new Error('Mock post-patch render interruption');
      return super.renderDeck(slides);
    }
  }
  await assert.rejects(new Interrupted(f.store).run(), /Mock post-patch render interruption/);
  const patched = await f.store.read('deck/deck-spec.yaml', deckSchema);
  assert.equal(patched.slides[0].layout, 'title');
  const baseline = await f.store.read(compilerHandoffFile, compilerHandoffSchema);
  assert.notEqual(baseline.deck.slides[0].layout, patched.slides[0].layout);
  await new MockPipeline(f.store).run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE');
  assert.deepEqual(await f.store.read('deck/deck-spec.yaml', deckSchema), patched);
  assert.equal(f.store.checkpoint.trace.filter(row => row.unit === 'builder' && row.task.startsWith('Build')).length, 1);
});
