// OFFLINE assignment/approval regressions. No model streams or real rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  agentsSchema, compactAgentsSchema, legacyAgentsSchema, checkpointSchema,
  assignmentForRole, assignmentRoles, isCompactAgents, roles, units, unitForRole,
  type Role, type Unit,
} from '../src/schema.js';
import { capabilities, resolveAssignment, validateAgents } from '../src/models.js';
import { Store } from '../src/storage.js';
import { agentsWizard, approvalDialog, type DialogUI } from '../src/wizard.js';
import { agents, compactAgents, fixture, model, MockRegistry } from './fixtures.js';

const cancelledUI: DialogUI = { input: async () => undefined, select: async () => undefined, notify: () => {} };
const expectedUnits: Record<Role, Unit> = {
  director: 'planner', narrative_architect: 'planner', evidence_researcher: 'researcher',
  art_director: 'builder', visual_designer: 'builder', fact_reviewer: 'reviewer', visual_reviewer: 'reviewer',
};

test('strict assignment union accepts complete four-unit and seven-role matrices only', () => {
  assert.deepEqual(compactAgentsSchema.parse(compactAgents), compactAgents);
  assert.deepEqual(legacyAgentsSchema.parse(agents), agents);
  assert.deepEqual(agentsSchema.parse(compactAgents), compactAgents);
  assert.deepEqual(agentsSchema.parse(agents), agents);
  const { reviewer: _reviewer, ...incompleteCompact } = compactAgents;
  const { visual_reviewer: _visualReviewer, ...incompleteLegacy } = agents;
  for (const invalid of [incompleteCompact, incompleteLegacy, { ...agents, ...compactAgents },
    { ...compactAgents, director: agents.director }, { ...agents, planner: compactAgents.planner },
    { ...compactAgents, tools: ['bash'] }, { ...compactAgents, planner: { ...compactAgents.planner, effort: 'unknown' } }]) {
    assert.equal(agentsSchema.safeParse(invalid).success, false);
  }
});

test('specialty mapping resolves compact units without converting legacy assignments', () => {
  assert.equal(isCompactAgents(compactAgents), true);
  assert.equal(isCompactAgents(agents), false);
  assert.deepEqual(assignmentRoles(compactAgents), units);
  assert.deepEqual(assignmentRoles(agents), roles);
  for (const role of roles) {
    assert.equal(unitForRole(role), expectedUnits[role]);
    assert.equal(assignmentForRole(compactAgents, role), compactAgents[expectedUnits[role]]);
    assert.equal(assignmentForRole(agents, role), agents[role]);
  }
});

test('compact validation checks exact identity/effort and requires reviewer image input', () => {
  const registry = new MockRegistry();
  const textOnly = { ...structuredClone(model), id: 'text-only', input: ['text'] as typeof model.input };
  registry.available.push(textOnly);
  assert.deepEqual(validateAgents(registry, compactAgents), compactAgents);
  assert.deepEqual(capabilities(registry, compactAgents).map(row => row.role), units);
  assert.deepEqual(capabilities(registry, agents).map(row => row.role), roles);
  for (const unit of units) {
    for (const bad of [{ provider: 'wrong-provider' }, { id: 'MOCK-EXACT' }, { effort: 'max' }]) {
      assert.throws(() => validateAgents(registry, { ...compactAgents, [unit]: { ...compactAgents[unit], ...bad } }));
    }
    const value = { ...compactAgents, [unit]: { ...compactAgents[unit], id: textOnly.id } };
    if (unit === 'reviewer') assert.throws(() => validateAgents(registry, value), /image/);
    else assert.doesNotThrow(() => validateAgents(registry, value));
  }
  assert.throws(() => resolveAssignment(registry, 'reviewer', { ...compactAgents.reviewer, id: textOnly.id }), /image/);
  assert.equal(registry.calls.length, 0);
});

test('trace keeps seven specialty roles and optionally records one of four units', () => {
  const trace = { role: 'director', provider: model.provider, model: model.id, effort: 'medium', task: 'Offline', at: 'now', outcome: 'validated' };
  const checkpoint = { version: 1, state: 'APPROVED', artifacts: {}, revision: 0, trace: [trace] };
  assert.deepEqual(checkpointSchema.parse(checkpoint).trace[0], trace);
  for (const unit of units) {
    assert.equal(checkpointSchema.parse({ ...checkpoint, trace: [{ ...trace, unit }] }).trace[0].unit, unit);
  }
  assert.equal(checkpointSchema.safeParse({ ...checkpoint, trace: [{ ...trace, role: 'planner' }] }).success, false);
  assert.equal(checkpointSchema.safeParse({ ...checkpoint, trace: [{ ...trace, unit: 'director' }] }).success, false);
});

test('approved legacy config retains its pre-layer fingerprint and matrix after reload', async t => {
  const f = await fixture(); t.after(f.cleanup);
  // Captured before introducing the union; legacy capability ordering/shape must not change.
  const fingerprint = '4e7dcb09d941998edab172d6fb2a40a572a1543d424a861bd5246240b9d7567e';
  const configBytes = await fs.readFile(await f.store.file('config/agents.yaml'));
  const approval = structuredClone(f.store.checkpoint.approval);
  assert.equal(await f.store.fingerprint(), fingerprint);
  const restored = new Store(f.cwd, f.registry);
  await restored.load(); await restored.gate();
  assert.deepEqual(restored.checkpoint.approval, approval);
  assert.deepEqual(restored.checkpoint.approval?.matrix, agents);
  assert.equal(await restored.fingerprint(), fingerprint);
  assert.deepEqual(await fs.readFile(await restored.file('config/agents.yaml')), configBytes);
  assert.equal(f.registry.calls.length, 0);
});

test('compact reconfiguration clears repairs and cached policy and requires new native approval', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const oldFingerprint = f.store.checkpoint.approval!.fingerprint;
  await f.store.artifact('orchestration/execution-plan.json', { maxAttempts: 1, narrativeRevisions: 0 });
  f.store.checkpoint.revision = 2;
  f.store.checkpoint.pendingRevision = { affectedSlideIds: ['slide_a'], instructions: 'Old repair' };
  f.store.checkpoint.narrativeRevision = 2;
  f.store.checkpoint.narrativeFeedback = 'Old feedback';
  f.store.checkpoint.trace.push({ role: 'director', provider: model.provider, model: model.id, effort: 'medium', task: 'Old attempt', at: 'now', outcome: 'error' });
  await f.store.save();
  await f.store.configure(compactAgents);
  const restored = new Store(f.cwd, f.registry); await restored.load();
  assert.deepEqual(restored.checkpoint, { version: 1, state: 'AWAITING_APPROVAL', artifacts: {}, revision: 0, trace: [] });
  assert.deepEqual((await restored.inputs()).agents, compactAgents);
  assert.notEqual(await restored.fingerprint(), oldFingerprint);
  await assert.rejects(() => restored.gate(), /Approve & Start/);
  await assert.rejects(() => restored.approve(oldFingerprint, 'Approve & Start'), /changed/);
  await assert.rejects(() => restored.approve(oldFingerprint, 'approve'), /Explicit/);
  let displayed = '';
  assert.equal(await approvalDialog({ ...cancelledUI, select: async title => { displayed = title; return 'Cancel'; } }, restored), false);
  for (const unit of units) assert.ok(displayed.includes(`${unit}: mock-provider/mock-exact | effort=medium`));
  for (const role of roles) assert.ok(!displayed.includes(`${role}:`));
  assert.equal(restored.checkpoint.approval, undefined);
  assert.equal(await approvalDialog({ ...cancelledUI, select: async () => 'Approve & Start' }, restored), true);
  await restored.gate();
  const reloaded = await restored.load();
  assert.deepEqual(reloaded.approval?.matrix, compactAgents);
  assert.equal(f.registry.calls.length, 0);
});

test('reconfiguration revocation is persisted even if compact config write fails', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const file = await f.store.file('config/agents.yaml');
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(() => f.store.configure(compactAgents));
  const restored = new Store(f.cwd, f.registry); await restored.load();
  assert.equal(restored.checkpoint.state, 'AGENTS_CONFIGURED');
  assert.equal(restored.checkpoint.approval, undefined);
  await assert.rejects(() => restored.gate(), /Approve & Start/);
  assert.equal(f.registry.calls.length, 0);
});

test('default wizard asks exactly four model/effort pairs and filters reviewer to vision models', async t => {
  const f = await fixture(false); t.after(f.cleanup);
  f.registry.available.unshift({ ...structuredClone(model), id: 'text-only', input: ['text'] });
  const dialogs: { title: string; options: string[] }[] = [];
  const result = await agentsWizard({ ...cancelledUI, select: async (title, options) => {
    dialogs.push({ title, options });
    return title.includes(': effort') ? 'medium' : options[0];
  } }, f.store);
  assert.ok(result);
  assert.deepEqual(Object.keys(result), units);
  assert.equal(dialogs.length, 1 + units.length * 2);
  for (const [index, unit] of units.entries()) {
    const modelDialog = dialogs[1 + index * 2];
    assert.ok(modelDialog.title.startsWith(`${unit}: suggested`));
    assert.ok(modelDialog.title.includes('UNAVAILABLE'));
    assert.ok(dialogs[2 + index * 2].title.startsWith(`${unit}: effort`));
    assert.equal(modelDialog.options.length, unit === 'reviewer' ? 1 : 2);
    assert.equal(result[unit].id, unit === 'reviewer' ? model.id : 'text-only');
    assert.equal(result[unit].effort, 'medium');
  }
  assert.equal(f.registry.calls.length, 0);
  assert.equal(f.store.checkpoint.state, 'AWAITING_APPROVAL');
});

test('compact reviewer capability changes invalidate approval without any model calls', async t => {
  const f = await fixture(false); t.after(f.cleanup);
  await f.store.configure(compactAgents);
  await f.store.approve(await f.store.fingerprint(), 'Approve & Start');
  f.registry.available[0].input = ['text'];
  await assert.rejects(() => f.store.gate(), /image/);
  assert.equal(f.store.checkpoint.state, 'AWAITING_APPROVAL');
  assert.equal(f.store.checkpoint.approval, undefined);
  assert.equal(f.registry.calls.length, 0);
});
