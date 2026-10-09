import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import presenter, { presenterCommand } from '../src/index.js';
import { Pipeline } from '../src/pipeline.js';
import { Dispatcher } from '../src/dispatch.js';
import { z } from 'zod';
import { skillFixture, cancelUI } from './skill-fixture.js';

test('published runtime import graph excludes all model workflow/output-validation engines', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const seen = new Set<string>(); const queue = ['src/index.ts'];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    assert.ok(pkg.files.includes(file), `Runtime dependency missing from package: ${file}`);
    const text = await fs.readFile(file, 'utf8');
    // AST inspection of CODE only, never regex/string gates over a model's language.
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.notEqual(node.expression.name.text, 'streamSimple', `${file} must not call a model`);
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) assert.ok(!['Pipeline', 'Dispatcher'].includes(node.expression.text));
      ts.forEachChild(node, visit);
    }; visit(ast);
    for (const imported of ts.preProcessFile(text).importedFiles) if (imported.fileName.startsWith('.')) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), imported.fileName.replace(/\.js$/, '.ts'))));
  }
  for (const retired of ['pipeline', 'dispatch', 'natural-flow', 'compact', 'schema', 'evidence', 'compiler', 'renderer', 'orchestration', 'call-timeout', 'progress']) {
    assert.ok(!seen.has(`src/${retired}.ts`)); assert.ok(!pkg.files.includes(`src/${retired}.ts`));
  }
  assert.ok(!pkg.files.includes('src'), 'A broad src publication would reintroduce the retired engines');
});
test('skill is actionable, owns delegation/interpretation and has resolvable bundled references', async () => {
  const root = 'skills/presenter'; const skill = await fs.readFile(`${root}/SKILL.md`, 'utf8');
  assert.ok(skill.includes('You, the agent')); assert.ok(skill.includes('Do not use schema/structured-output options'));
  assert.ok(skill.includes('do not parse a sentinel')); assert.ok(skill.includes('tool-capable agents'));
  for (const file of ['references/orchestration.md', 'references/pptx-authoring.md', 'scripts/pptx.mjs']) assert.ok((await fs.stat(`${root}/${file}`)).isFile());
});
test('all approved production commands hand off without model work or stage advances', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  const initial = f.store.checkpoint.state; const tasks: string[] = [];
  for (const action of ['run', 'resume', 'review', 'export']) {
    await presenterCommand(action, { cwd: f.cwd, modelRegistry: f.registry, hasUI: false, ui: cancelUI, handoff: text => tasks.push(text) });
    await f.store.load(); assert.equal(f.store.checkpoint.state, initial);
    assert.equal(f.calls(), 0); assert.equal(f.store.checkpoint.trace.length, 0);
  }
  assert.equal(tasks.length, 4); assert.ok(tasks.every(text => text.includes('orchestrating agent') && text.includes('No schema or JSON')));
  await assert.rejects(fs.stat(path.join(f.cwd, 'export/test.pptx')));
  await assert.rejects(fs.stat(await f.store.file('operation.lock')));
});
test('unapproved and legacy-approved work cannot silently enter tool-capable agent mode', async t => {
  const f = await skillFixture(false); t.after(f.cleanup);
  await assert.rejects(presenterCommand('run', { cwd: f.cwd, modelRegistry: f.registry, hasUI: false, ui: cancelUI }), /approval/i);
  await f.store.approve(await f.store.fingerprint(), 'Approve & Start'); // OFFLINE legacy-mode fixture only.
  await assert.rejects(presenterCommand('resume', { cwd: f.cwd, modelRegistry: f.registry, hasUI: false, ui: cancelUI }), /skill-agent execution mode/);
  assert.equal(f.calls(), 0);
});
test('native approval explicitly discloses agent-owned execution and does not launch any worker', async t => {
  const f = await skillFixture(false); t.after(f.cleanup); let prompt = ''; let task = '';
  await presenterCommand('approve', { cwd: f.cwd, modelRegistry: f.registry, hasUI: true, ui: { ...cancelUI, select: async title => { prompt = title; return 'Approve & Start'; } }, handoff: text => { task = text; } });
  assert.ok(prompt.includes('tool-capable isolated agents')); assert.ok(prompt.includes('PPTX-generation JavaScript'));
  assert.ok(prompt.includes('planner: offline-fixture/offline-only')); assert.ok(task.includes('Read '));
  await f.store.load(); assert.ok(f.store.checkpoint.artifacts['skill/authority.json']); assert.equal(f.calls(), 0);
});
test('new saves pending defaults for intent alignment, never autoapproves or begins a pipeline', async t => {
  const f = await skillFixture(false); t.after(f.cleanup); let selections = 0;
  await presenterCommand('new', { cwd: f.cwd, modelRegistry: f.registry, hasUI: true, ui: { input: async () => 'User brief', select: async (_title, options) => { selections++; return options.includes('medium') ? 'medium' : options[0]; }, notify: () => {} } });
  await f.store.load(); assert.equal(f.store.checkpoint.state, 'AWAITING_APPROVAL'); assert.equal(f.store.checkpoint.approval, undefined); assert.equal(f.calls(), 0); assert.ok(selections > 0);
});
test('retired dispatcher and pipeline fail closed even through historical harness entrypoints', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  const pipeline = new Pipeline(f.store);
  for (const action of [() => pipeline.run(), () => pipeline.review(), () => pipeline.export(), () => new Dispatcher(f.store).call('director', 'Any task', z.unknown(), {})]) await assert.rejects(action, /Retired/);
  assert.equal(f.calls(), 0);
});
test('native wizard cancellation is cancellable and releases its lock', async t => {
  const f = await skillFixture(false); t.after(f.cleanup);
  let ready!: () => void; const begun = new Promise<void>(resolve => { ready = resolve; });
  const ctx = { cwd: f.cwd, modelRegistry: f.registry, hasUI: true, ui: { ...cancelUI, input: async (_title: string, _placeholder?: string, options?: {signal?: AbortSignal}) => { ready(); return new Promise<undefined>(resolve => options?.signal?.addEventListener('abort', () => resolve(undefined), { once: true })); } } };
  const setup = presenterCommand('new', ctx); await begun;
  await presenterCommand('cancel', ctx); await setup;
  assert.equal(f.calls(), 0); await f.store.exclusive(async () => {});
});
test('extension registers only authority/file tools and a handoff command, not a hidden workflow hook', () => {
  const commands: string[] = [], tools: string[] = [], events: string[] = [];
  // SAFETY: this deliberately partial API records registration only; no production handlers are executed.
  presenter({ registerCommand: (name: string) => commands.push(name), registerTool: (tool: {name: string}) => tools.push(tool.name), on: (event: string) => events.push(event) } as unknown as Parameters<typeof presenter>[0]);
  assert.deepEqual(commands, ['presenter']); assert.deepEqual(tools, ['presenter_authority', 'presenter_files']); assert.deepEqual(events, ['session_shutdown']);
});
