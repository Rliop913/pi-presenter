import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/json.js';

test('extractJson passes clean JSON object through unchanged', () => {
  const input = '{"a":1,"b":"two","c":[1,2,3]}';
  assert.equal(extractJson(input), input);
});

test('extractJson passes clean JSON array through unchanged', () => {
  const input = '[1,2,{"three":3}]';
  assert.equal(extractJson(input), input);
});

test('extractJson strips ```json fenced code blocks', () => {
  const wrapped = '```json\n{"objective":"explain"}\n```';
  assert.equal(extractJson(wrapped), '{"objective":"explain"}');
});

test('extractJson strips plain ``` fenced code blocks (no language tag)', () => {
  const wrapped = '```\n{"objective":"explain"}\n```';
  assert.equal(extractJson(wrapped), '{"objective":"explain"}');
});

test('extractJson strips fenced blocks even with extra whitespace and newlines', () => {
  const wrapped = '   \n```json\n\n  {"a": 1}\n\n```\n  ';
  assert.equal(extractJson(wrapped), '{"a": 1}');
});

test('extractJson strips leading prose before JSON', () => {
  const wrapped = 'Here is the result: {"a": 1}';
  assert.equal(extractJson(wrapped), '{"a": 1}');
});

test('extractJson strips trailing prose after JSON', () => {
  const wrapped = '{"a": 1}\nLet me know if you need changes!';
  assert.equal(extractJson(wrapped), '{"a": 1}');
});

test('extractJson strips leading prose and trailing prose together', () => {
  const wrapped = 'Sure! Here is the JSON:\n{"a": 1, "b": 2}\nHope this helps!';
  assert.equal(extractJson(wrapped), '{"a": 1, "b": 2}');
});

test('extractJson handles fenced block surrounded by prose', () => {
  const wrapped = 'Here is the result:\n```json\n{"a": 1}\n```\nLet me know!';
  assert.equal(extractJson(wrapped), '{"a": 1}');
});

test('extractJson handles nested objects from first { to last }', () => {
  const wrapped = '{"a":{"b":{"c":1}},"d":2}';
  assert.equal(extractJson(wrapped), '{"a":{"b":{"c":1}},"d":2}');
});

test('extractJson handles nested objects with prose', () => {
  const wrapped = 'Result: {"outer":{"inner":{"deep":42}}} done.';
  assert.equal(extractJson(wrapped), '{"outer":{"inner":{"deep":42}}}');
});

test('extractJson handles JSON arrays with nested objects', () => {
  const wrapped = '[{"id":"a","x":1},{"id":"b","x":2}]';
  assert.equal(extractJson(wrapped), wrapped);
});

test('extractJson prefers the first fence when multiple are present', () => {
  // The extractor takes the first fenced block. Models rarely emit two
  // fenced blocks, but if they do, we want the first one to avoid
  // grabbing trailing junk.
  const wrapped = '```json\n{"first": 1}\n```\n```json\n{"second": 2}\n```';
  assert.equal(extractJson(wrapped), '{"first": 1}');
});

test('extractJson returns the trimmed text when no JSON is present', () => {
  assert.equal(extractJson('   hello world   '), 'hello world');
});

test('extractJson returns empty string unchanged', () => {
  assert.equal(extractJson(''), '');
});

test('extractJson handles whitespace-only input', () => {
  assert.equal(extractJson('   \n\t  '), '');
});

test('extractJson handles case-insensitive language tag', () => {
  const wrapped = '```JSON\n{"a":1}\n```';
  assert.equal(extractJson(wrapped), '{"a":1}');
});

test('extractJson handles JSON with embedded newlines (pretty-printed)', () => {
  const wrapped = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
  assert.equal(extractJson(wrapped), '{\n  "a": 1,\n  "b": 2\n}');
});

test('extractJson does not repair invalid JSON; caller still gets a SyntaxError from JSON.parse', () => {
  // The extractor is intentionally narrow: it does NOT try to repair.
  // We only assert that the extracted substring is what JSON.parse will
  // be given. The actual parse failure is the caller's concern.
  const wrapped = '```json\n{not valid json}\n```';
  const extracted = extractJson(wrapped);
  assert.equal(extracted, '{not valid json}');
  assert.throws(() => JSON.parse(extracted), SyntaxError);
});
