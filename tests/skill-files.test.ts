import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../src/storage.js';
import { presentationFiles } from '../src/file-tools.js';
import { skillFixture, mockFileBinding, cancelUI, model } from './skill-fixture.js';

async function report(f: Awaited<ReturnType<typeof skillFixture>>, kind: 'fact' | 'visual', page?: number, prose = '# 검토\n인용은 번역·요약입니다. “원문”과 다른 표기도 의미를 검토해야 합니다. 약 100개.\n\n이 설명은 JSON이 아닙니다.') {
  const artifact = `reviews/${kind}-${page ?? 'all'}-${Date.now()}.md`;
  await atomicWrite(await f.store.file(`skill/${artifact}`), prose);
  await presentationFiles(f.store, { action: 'register', artifact });
  const request = { action: 'record-review', artifact, kind, page, jobId: `OFFLINE-job-${kind}-${page ?? 'all'}`, provider: model.provider, model: model.id, effort: 'medium' };
  return { artifact, prose, request, result: await presentationFiles(f.store, request) };
}
test('all mechanical helpers reject missing native authority before reading or running anything', async t => {
  const f = await skillFixture(false); t.after(f.cleanup);
  for (const action of ['authorize', 'register', 'render', 'references', 'record-review', 'export']) await assert.rejects(presentationFiles(f.store, { action, artifact: 'draft.pptx' }), /Approve/);
  assert.equal(f.calls(), 0);
});
test('legacy approval cannot authorize the new agent/file mode', async t => {
  const f = await skillFixture(false); t.after(f.cleanup);
  await f.store.approve(await f.store.fingerprint(), 'Approve & Start');
  await assert.rejects(presentationFiles(f.store, { action: 'authorize' }), /legacy approval/);
});
test('authorize returns the exact approved matrix/source scope, not a task sequence or model call', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  const value = await presentationFiles(f.store, { action: 'authorize' }) as {owner: string; agents: unknown; contract: {sources: string[]}};
  assert.equal(value.owner, 'skill-agent'); assert.deepEqual(value.agents, (await f.store.inputs()).agents); assert.deepEqual(value.contract.sources, ['Source fixture text']); assert.equal(f.calls(), 0);
});
test('raw multilingual/Markdown/non-JSON reports are saved exactly and recording never certifies QA', async t => {
  const f = await skillFixture(); t.after(f.cleanup); await mockFileBinding(f.store);
  for (const prose of ['아직 critical 문제가 남아 있습니다. 수정이 필요합니다.', '## 검수\n약 100건 — 충실한 바꿔쓰기입니다.\n\nJSON 문법이 아니어도 됩니다.', 'The quotation\nwas translated. It is not literally identical.']) {
    const r = await report(f, 'fact', undefined, prose);
    assert.equal(await fs.readFile(await f.store.file(`skill/${r.artifact}`), 'utf8'), prose);
    assert.ok(JSON.stringify(r.result).includes('NOT a QA pass'));
  }
  assert.equal(f.store.checkpoint.state, 'APPROVED'); assert.equal(f.calls(), 0);
  await assert.rejects(fs.stat(path.join(f.cwd, 'export/test.pptx')));
});
test('review recording enforces actual page/provenance metadata, never prose format', async t => {
  const f = await skillFixture(); t.after(f.cleanup); await mockFileBinding(f.store);
  const r = await report(f, 'fact');
  await assert.rejects(presentationFiles(f.store, { ...r.request, model: 'fallback' }), /exact approved/);
  await assert.rejects(presentationFiles(f.store, { ...r.request, kind: 'visual', page: 99 }), /actual rendered page/);
  await assert.rejects(presentationFiles(f.store, { ...r.request, jobId: undefined }), /job ID/);
});
test('export requires all current raw review bindings and real native user confirmation', async t => {
  const f = await skillFixture(); t.after(f.cleanup); await mockFileBinding(f.store);
  await assert.rejects(presentationFiles(f.store, { action: 'export' }, cancelUI), /Missing current/);
  await report(f, 'fact'); await report(f, 'visual', 1);
  await assert.rejects(presentationFiles(f.store, { action: 'export' }, cancelUI), /per-page/);
  await report(f, 'visual', 2);
  await assert.rejects(presentationFiles(f.store, { action: 'export' }), /Native export confirmation/);
  assert.deepEqual(await presentationFiles(f.store, { action: 'export' }, cancelUI), { exported: false });
  await assert.rejects(fs.stat(path.join(f.cwd, 'export/test.pptx')));
  let disclosure = '';
  const result = await presentationFiles(f.store, { action: 'export' }, { ...cancelUI, select: async title => { disclosure = title; return 'Approve export'; } });
  assert.ok(disclosure.includes('NOT the truth or verdict')); assert.ok(JSON.stringify(result).includes('"exported":true'));
  assert.deepEqual(await fs.readFile(path.join(f.cwd, 'export/test.pptx')), await fs.readFile(await f.store.file('skill/drafts/one.pptx')));
});
test('old reviews cannot authorize a new render binding', async t => {
  const f = await skillFixture(); t.after(f.cleanup); await mockFileBinding(f.store);
  await report(f, 'fact'); await report(f, 'visual', 1); await report(f, 'visual', 2);
  await mockFileBinding(f.store, 'two');
  await assert.rejects(presentationFiles(f.store, { action: 'export' }, cancelUI), /current render/);
});
test('reserved receipts, root escapes and symlinked managed paths cannot be registered', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  for (const artifact of ['authority.json', './authority.json', './/render-manifest.json', '../config/agents.yaml', '/tmp/outside']) await assert.rejects(presentationFiles(f.store, { action: 'register', artifact }), /relative|Reserved/);
  const target = path.join(f.cwd, 'protected'); await fs.mkdir(target); await atomicWrite(path.join(target, 'keep.md'), 'keep');
  await fs.symlink(target, await f.store.file('skill/link'), 'junction');
  await assert.rejects(presentationFiles(f.store, { action: 'register', artifact: 'link/keep.md' }), /symlinks/);
  assert.equal(await fs.readFile(path.join(target, 'keep.md'), 'utf8'), 'keep');
});
test('file edits and cancellation block mechanical work without interpreting language', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  await atomicWrite(await f.store.file('skill/note.md'), '원문'); await presentationFiles(f.store, { action: 'register', artifact: 'note.md' });
  await atomicWrite(await f.store.file('skill/note.md'), 'Changed');
  await assert.rejects(presentationFiles(f.store, { action: 'authorize' }), /tampered/);
  const other = await skillFixture(); t.after(other.cleanup); const controller = new AbortController(); controller.abort(new Error('User cancelled'));
  await assert.rejects(presentationFiles(other.store, { action: 'authorize' }, undefined, controller.signal), /User cancelled/);
});
test('invalid PPTX file cannot reach render command execution', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  await atomicWrite(await f.store.file('skill/draft.pptx'), 'not a PPTX'); await presentationFiles(f.store, { action: 'register', artifact: 'draft.pptx' });
  await assert.rejects(presentationFiles(f.store, { action: 'render', artifact: 'draft.pptx' }), /zip|central directory/i);
  assert.equal(f.calls(), 0);
});
