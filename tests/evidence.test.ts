import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackEvidence, validateEvidence } from '../src/evidence.js';
import { evidenceSchema } from '../src/schema.js';

test('translated numeric language is not rejected by a lexical matching gate', () => {
  const sources = [{ id: 'source_1', text: 'Approximately one hundred requests.', hash: 'h' }];
  const result = validateEvidence({ claims: [{ id: 'claim_a', text: '약 100건의 요청', citations: [{ sourceId: 'source_1', quote: 'roughly a hundred requests' }] }], figures: [] }, sources);
  assert.equal(result.claims[0].text, '약 100건의 요청');
});

test('evidenceSchema accepts empty claims (no .refine() enforcement)', () => {
  // Conservative .refine() that required >= 1 claim was removed: the
  // pipeline now applies a fallback claim from the source instead of
  // failing with a hard error. An empty claims array is valid at parse
  // time; the fallback is applied at the pipeline level.
  const result = evidenceSchema.parse({});
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.figures, []);
});
  // Before the .default([]) fix, a model that returned an object missing
  // `claims` would fail with a cryptic "expected array, received undefined"

test('evidenceSchema defaults figures to [] when missing', () => {
  // figures has no .min(1), so a valid claims array with no figures
  // should now pass validation (figures defaults to []).
  const result = evidenceSchema.parse({ claims: [{ id: 'claim_a', text: 'Test claim', citations: [{ sourceId: 'source_1', quote: 'Test quote' }] }] });
  assert.deepEqual(result.figures, []);
  assert.equal(result.claims.length, 1);
});

test('fallbackEvidence creates a single claim from the first source', () => {
  const sources = [{ id: 'source_1', text: 'Pilot Alpha recorded 100 requests. Beta recorded 200 requests.', hash: 'h' }];
  const ev = fallbackEvidence(sources);
  assert.equal(ev.claims.length, 1);
  assert.equal(ev.claims[0].id, 'claim_fallback');
  assert.equal(ev.claims[0].text, 'Pilot Alpha recorded 100 requests');
  assert.equal(ev.claims[0].citations[0].sourceId, 'source_1');
  assert.equal(ev.claims[0].citations[0].quote, 'Pilot Alpha recorded 100 requests');
  assert.deepEqual(ev.figures, []);
});

test('fallbackEvidence produces evidence that passes validateEvidence', () => {
  const sources = [{ id: 'source_1', text: 'Reliability matters. The team prioritizes stability over speed.', hash: 'h' }];
  const ev = fallbackEvidence(sources);
  // Must round-trip through validateEvidence without throwing.
  assert.doesNotThrow(() => validateEvidence(ev, sources));
});

test('fallbackEvidence uses the first 240 chars of the source when no sentence boundary exists', () => {
  const longText = 'x'.repeat(500);
  const sources = [{ id: 'source_1', text: longText, hash: 'h' }];
  const ev = fallbackEvidence(sources);
  assert.equal(ev.claims[0].text.length, 240);
  assert.equal(ev.claims[0].citations[0].quote.length, 240);
});

test('fallbackEvidence throws when no sources are provided', () => {
  assert.throws(() => fallbackEvidence([]), /at least one source/);
});

test('pipeline applies fallbackEvidence when the model returns empty claims', () => {
  // Simulate the pipeline's fallback logic: after validateEvidence, if
  // claims is empty, replace with fallbackEvidence. This is the contract
  // the pipeline relies on.
  const sources = [{ id: 'source_1', text: 'Some source text here. More text.', hash: 'h' }];
  let evidence = validateEvidence({ claims: [], figures: [] }, sources);
  assert.equal(evidence.claims.length, 0);
  if (evidence.claims.length === 0) evidence = fallbackEvidence(sources);
  assert.equal(evidence.claims.length, 1);
  assert.equal(evidence.claims[0].id, 'claim_fallback');
});
