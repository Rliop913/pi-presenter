import test from 'node:test';
import assert from 'node:assert/strict';
import { presets, presetEfforts } from '../src/models.js';

test('quality presets preserve the requested seven-role model and effort assignments', () => {
  assert.deepEqual(presets.economy, ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra']);
  assert.deepEqual(presets.balanced, ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-sol']);
  assert.deepEqual(presets.maximum, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra']);
  assert.deepEqual(presetEfforts.economy, ['medium', 'low', 'medium', 'medium', 'medium', 'medium', 'medium']);
  assert.deepEqual(presetEfforts.balanced, ['high', 'medium', 'high', 'high', 'medium', 'high', 'high']);
  assert.deepEqual(presetEfforts.maximum, Array(7).fill('high'));
});
