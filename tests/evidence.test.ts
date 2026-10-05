import test from 'node:test';
import assert from 'node:assert/strict';
import { numbers, groundedNumbers } from '../src/evidence.js';
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

test('evidenceSchema defaults claims to [] when missing (regression: model truncation)', () => {
  // Before the .default([]) fix, a model that returned an object missing
  // `claims` would fail with a cryptic "expected array, received undefined"
  // Zod error. Now it defaults to [] and fails with the clearer
  // "Array must contain at least 1 element(s)" error on the .min(1) check.
  assert.throws(() => evidenceSchema.parse({ figures: [] }), /at least 1 element/);
});

test('evidenceSchema defaults figures to [] when missing', () => {
  // figures has no .min(1), so a valid claims array with no figures
  // should now pass validation (figures defaults to []).
  const result = evidenceSchema.parse({ claims: [{ id: 'claim_a', text: 'Test claim', citations: [{ sourceId: 'source_1', quote: 'Test quote' }] }] });
  assert.deepEqual(result.figures, []);
  assert.equal(result.claims.length, 1);
});

test('evidenceSchema accepts an empty object and surfaces the .min(1) failure', () => {
  // The most common model-mistake case: the model returns {}.
  // Before: cryptic "expected array, received undefined" x2.
  // After: single clear error about claims needing >= 1 element.
  assert.throws(() => evidenceSchema.parse({}), /at least 1 element/);
});
