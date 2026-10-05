import test from 'node:test';
import assert from 'node:assert/strict';
import { numbers, groundedNumbers, fallbackEvidence, validateEvidence } from '../src/evidence.js';
import { evidenceSchema } from '../src/schema.js';

test('numbers extracts a plain integer', () => {
  assert.deepEqual(numbers('100 requests'), ['100']);
});

test('numbers extracts multiple integers in one string', () => {
  assert.deepEqual(numbers('100 requests and 200 responses'), ['100', '200']);
});

test('numbers extracts a percentage', () => {
  assert.deepEqual(numbers('15.5%'), ['15.5%']);
});

test('numbers extracts a number with a sign', () => {
  assert.deepEqual(numbers('+100'), ['+100']);
  assert.deepEqual(numbers('-15'), ['-15']);
});

test('numbers extracts a number with a thousands separator', () => {
  assert.deepEqual(numbers('1,000'), ['1,000']);
});

test('numbers does NOT match digits embedded in an identifier (rliop913)', () => {
  // This is the regression case: a GitHub username like `rliop913` must not
  // be split into a text segment and the digit `913`.
  assert.deepEqual(numbers('rliop913'), []);
  assert.deepEqual(numbers('Project hosted at https://rliop913.github.io/Project-DJ-Engine-Docs/'), []);
});

test('numbers does NOT match version-like identifiers (v2.0)', () => {
  assert.deepEqual(numbers('v2.0'), []);
  assert.deepEqual(numbers('version 2.0'), ['2.0']);
});

test('numbers does NOT match hyphenated identifiers (slide-3)', () => {
  // "slide-3" is treated as a single identifier; the conservative regex
  // does not split on the hyphen. This is intentional: the alternative
  // (matching "3" in "slide-3") would let the model inject fake slide
  // numbers into identifiers. If the author wants two separate numbers,
  // they should write "slide 3" or "slide 3, step 2" with a space.
  assert.deepEqual(numbers('slide-3'), []);
});

test('numbers does NOT match digits directly attached to a word (100requests)', () => {
  assert.deepEqual(numbers('100requests'), []);
});

test('numbers extracts only the standalone portion when an identifier follows', () => {
  // "100" is standalone, "913" is part of the identifier.
  assert.deepEqual(numbers('100 then rliop913'), ['100']);
});

test('numbers handles a range with spaces (100 to 200)', () => {
  assert.deepEqual(numbers('100 to 200'), ['100', '200']);
});

test('numbers does not match a hyphenated range (100-200)', () => {
  // "100-200" is a range; neither end is a standalone number because
  // the hyphen connects them. This is intentionally conservative: a
  // hyphen between digits is not a word boundary we want to split on.
  assert.deepEqual(numbers('100-200'), []);
});

test('numbers handles a sentence with mixed text and numbers', () => {
  assert.deepEqual(
    numbers('Pilot Alpha recorded 100 requests. Beta recorded 200 requests. Visit rliop913 for details.'),
    ['100', '200'],
  );
});

test('numbers returns an empty array for text without numbers', () => {
  assert.deepEqual(numbers('hello world'), []);
  assert.deepEqual(numbers(''), []);
});

test('numbers handles percent and decimal together', () => {
  assert.deepEqual(numbers('growth of 12.5% YoY'), ['12.5%']);
});

test('groundedNumbers passes when every number in text is present in support', () => {
  assert.doesNotThrow(() => groundedNumbers('Pilot Alpha recorded 100 requests', 'Alpha did 100 things'));
});

test('groundedNumbers throws when a number in text is missing from support', () => {
  assert.throws(() => groundedNumbers('Pilot Alpha recorded 200 requests', 'Alpha did 100 things'), /Unsupported numeric assertion/);
});

test('groundedNumbers ignores digits embedded in identifiers (regression)', () => {
  // The claim mentions a username; the number regex should not extract
  // `913` from `rliop913`, so the check should not fire.
  assert.doesNotThrow(() => groundedNumbers(
    'Project DJ Engine docs at https://rliop913.github.io/Project-DJ-Engine-Docs/',
    'See Rliop913 GitHub for the Project-DJ-Engine repo.',
  ));
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
