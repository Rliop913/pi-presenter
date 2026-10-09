import test from 'node:test';
import assert from 'node:assert/strict';
import { presets, presetEfforts, legacyPresets, legacyPresetEfforts } from '../src/models.js';
import { units } from '../src/schema.js';

test('legacy presets preserve the seven-role model and effort assignments', () => {
  assert.deepEqual(legacyPresets.economy, ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra']);
  assert.deepEqual(legacyPresets.balanced, ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-sol']);
  assert.deepEqual(legacyPresets.maximum, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra']);
  assert.deepEqual(legacyPresetEfforts.economy, ['medium', 'low', 'medium', 'medium', 'medium', 'medium', 'medium']);
  assert.deepEqual(legacyPresetEfforts.balanced, ['high', 'medium', 'high', 'high', 'medium', 'high', 'high']);
  assert.deepEqual(legacyPresetEfforts.maximum, Array(7).fill('high'));
});

test('default four-unit presets use director/evidence/visual/visual-review suggestions', () => {
  assert.deepEqual(units, ['planner', 'researcher', 'builder', 'reviewer']);
  assert.deepEqual(presets.economy, ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-terra']);
  assert.deepEqual(presets.balanced, ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  assert.deepEqual(presets.maximum, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-6-astra']);
  assert.deepEqual(presetEfforts.economy, ['medium', 'low', 'medium', 'medium']);
  assert.deepEqual(presetEfforts.balanced, ['high', 'medium', 'medium', 'high']);
  assert.deepEqual(presetEfforts.maximum, Array(4).fill('high'));
});
