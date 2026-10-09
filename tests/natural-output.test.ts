// Analysis prose must reach semantic review unchanged, not lexical validators.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../src/dispatch.js';
import { validateEvidence, validateStoryboard } from '../src/evidence.js';
import { evidenceSchema, type Evidence } from '../src/schema.js';
import { fixture, board, contract } from './fixtures.js';

test('natural language transport preserves explanation, typography, Markdown and numbers unchanged', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const prose = '# 조사 결과\nGodot 4.5에서 약 100개 요청을 처리할 수 있다는 설명입니다.\n인용은 요약·번역일 수 있습니다. “중요” — 원문 검토가 필요합니다.\n\n{not JSON}';
  f.registry.responseOverride = () => prose;
  const result = await new Dispatcher(f.store).text('evidence_researcher', 'Research in natural language', { sources: f.sources });
  assert.equal(result, prose);
  assert.equal(f.registry.calls.length, 1);
  const system = f.registry.calls[0].context.messages[0];
  assert.equal(system.role, 'system');
  if (system.role !== 'system' || typeof system.content !== 'string') throw new Error('Unexpected request');
  assert.ok(system.content.includes('No JSON or fixed wording is required'));
  assert.ok(!system.content.includes('Schema:'));
  assert.ok(!system.content.includes('OUTPUT FORMAT'));
});
test('paraphrased citations and translated numbers are not interpreted by regex/string gates', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const ev: Evidence = { claims: [{ id: 'claim_a', text: '약 100개 요청을 처리했습니다. 다른 표현도 가능합니다.', citations: [{ sourceId: 'source_1', quote: 'around one hundred requests processed — a paraphrase' }] }, { id: 'claim_b', text: '“결과”를 설명합니다.', citations: [{ sourceId: 'source_1', quote: "'Results' described without identical punctuation" }] }], figures: [] };
  assert.deepEqual(validateEvidence(ev, f.sources), ev);
  assert.doesNotThrow(() => validateStoryboard({ slides: [{ ...board.slides[0], title: '약 100개 요청의 의미' }, board.slides[1]] }, ev, contract));
  f.registry.responseOverride = () => ev;
  const result = await new Dispatcher(f.store).call('visual_designer', 'Prepare compiler data', evidenceSchema, {}, [], { validate: value => { validateEvidence(value, f.sources); } });
  assert.deepEqual(result, ev);
  assert.equal(f.registry.calls.length, 1);
});
test('natural prose cannot bypass approval, identity, effort or cancellation boundaries', async t => {
  const unapproved = await fixture(false); t.after(unapproved.cleanup);
  await assert.rejects(new Dispatcher(unapproved.store).text('director', 'Plan', {}), /Approve & Start/);
  assert.equal(unapproved.registry.calls.length, 0);
  const f = await fixture(); t.after(f.cleanup);
  f.registry.responseOverride = () => 'Free-form analysis';
  f.registry.substituted = true;
  await assert.rejects(new Dispatcher(f.store).text('director', 'Plan', {}), /substituted/);
  f.registry.substituted = false; f.registry.clamped = true;
  await assert.rejects(new Dispatcher(f.store).text('director', 'Plan', {}), /no clamping/);
  const controller = new AbortController(); controller.abort(new Error('User cancelled'));
  const count = f.registry.calls.length;
  await assert.rejects(new Dispatcher(f.store, controller.signal).text('director', 'Plan', {}), /User cancelled/);
  assert.equal(f.registry.calls.length, count);
});
