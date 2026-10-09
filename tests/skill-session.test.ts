import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import ts from 'typescript';
import currentSessionPresenter from '../.pi/extensions/pdje-current-session.js';
import presenter from '../src/index.js';

test('current-session aliases register without starting a model, legacy harness or workflow', () => {
  const names: string[] = [], tools: string[] = [], events: string[] = [];
  // SAFETY: registration-only fake API; handlers are not invoked and no live workspace is modified.
  const api = { registerCommand: (name: string) => names.push(name), registerTool: (tool: {name: string}) => tools.push(tool.name), sendMessage: () => { throw new Error('Loading must not start an agent turn'); }, on: (event: string) => events.push(event) } as unknown as Parameters<typeof currentSessionPresenter>[0];
  currentSessionPresenter(api);
  assert.deepEqual(names, ['pdje-m3-test', 'pdje-m3-cancel']);
  assert.deepEqual(tools, ['pdje_presenter_authority', 'pdje_presenter_files']);
  assert.deepEqual(events, ['session_shutdown']);
});
test('current-session adapter imports production handoff, with no SDK streaming/model runtime or old harness dependency', async () => {
  const source = await fs.readFile('.pi/extensions/pdje-current-session.ts', 'utf8');
  const imports = ts.preProcessFile(source).importedFiles.map(file => file.fileName);
  assert.ok(imports.includes('../../src/index.js'));
  assert.ok(!imports.some(file => file.includes('live-test') || file.includes('pipeline') || file.includes('dispatch')));
  const ast = ts.createSourceFile('session.ts', source, ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(ast));
    if (ts.isNewExpression(node)) assert.ok(!['ModelRuntime', 'ModelRegistry', 'Pipeline', 'Dispatcher'].includes(node.expression.getText(ast)));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(calls.includes('presenterCommand'));
  assert.ok(!calls.some(name => name.endsWith('.streamSimple') || name.includes('ModelRuntime.create') || name === 'liveTest'));
});

test('production and local tools coexist without name collisions or automatic work', () => {
  const commands: string[] = [], tools: string[] = [];
  // SAFETY: registration-only test double; none of the actual authority handlers run.
  const api = { registerCommand: (name: string) => commands.push(name), registerTool: (tool: {name: string}) => tools.push(tool.name), on: () => {}, sendMessage: () => { throw new Error('No automatic model work'); } } as unknown as Parameters<typeof presenter>[0];
  presenter(api); currentSessionPresenter(api);
  assert.deepEqual(commands, ['presenter', 'pdje-m3-test', 'pdje-m3-cancel']);
  assert.deepEqual(tools, ['presenter_authority', 'presenter_files', 'pdje_presenter_authority', 'pdje_presenter_files']);
  assert.equal(new Set(tools).size, tools.length);
});
