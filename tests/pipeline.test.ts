import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type ZipModule from 'jszip';
import { compile } from '../src/compiler.js';
import { render, validateRenders } from '../src/renderer.js';
import { runCommand } from '../src/process.js';
import { Pipeline } from '../src/pipeline.js';
import { Store, atomicWrite, boundedRead, digest } from '../src/storage.js';
import { deckSchema, evidenceSchema, passed, type Deck, type Source, type Storyboard } from '../src/schema.js';
import { ingest } from '../src/evidence.js';
import { agents, contract, board, deck, design, evidence, fixture, goodReview, mockPng, MockPipeline } from './fixtures.js';
const JSZip = createRequire(import.meta.url)('jszip') as typeof ZipModule;

test('offline real PPTX compiler creates editable text/shapes/charts/images for all six layouts', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const bytes = mockPng(); await atomicWrite(path.join(f.cwd, 'source.png'), bytes);
  await f.store.define({ ...contract, slideCount: 6, sources: ['source.md', 'source.png'] }); await f.store.configure(agents); await f.store.approve(await f.store.fingerprint(), 'Approve & Start');
  await atomicWrite(await f.store.file('assets/source_2.png'), bytes); await f.store.track('assets/source_2.png');
  const sources: Source[] = [...f.sources, { id: 'source_2', path: 'source.png', hash: digest(bytes), kind: 'image', text: '', asset: 'assets/source_2.png' }];
  const layouts = ['title', 'two-column', 'bullets', 'process', 'chart', 'image'] as const;
  const b: Storyboard = { slides: layouts.map((_, i) => ({ id: `slide_${i}`, title: `Pilot evidence`, claimIds: ['claim_b'], intent: 'Explain pilot' })) };
  const d: Deck = { slides: layouts.map((layout, i) => ({ id: b.slides[i].id, title: b.slides[i].title, claimIds: b.slides[i].claimIds, layout, ...(layout === 'chart' ? { figureId: 'figure_a' } : {}), ...(layout === 'image' ? { asset: 'assets/source_2.png' } : {}) })) };
  await compile(f.store, d, evidence, b, sources, design);
  const pptx = await boundedRead(await f.store.file('output/presentation.pptx'));
  assert.equal(pptx.subarray(0, 2).toString(), 'PK');
  const zip = await JSZip.loadAsync(pptx);
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)); assert.equal(slides.length, 6);
  assert.ok((await zip.file('ppt/slides/slide1.xml')!.async('string')).includes('Pilot Alpha recorded 100 requests.'));
  assert.ok(Object.keys(zip.files).some(n => /^ppt\/charts\/chart\d+\.xml$/.test(n)));
  assert.ok(Object.keys(zip.files).some(n => /embeddings\/.*xlsx$/.test(n)));
  assert.ok(Object.keys(zip.files).some(n => /^ppt\/media\//.test(n)));
  assert.ok((await zip.file('ppt/slides/slide6.xml')!.async('string')).includes('<p:pic>'));
  assert.ok((await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).includes('source_1'));
  assert.equal(f.registry.calls.length, 0);
});
test('renderer missing executables fails closed and clears all stale renders', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await compile(f.store, deck, evidence, board, f.sources, design);
  await atomicWrite(await f.store.file('renders/stale.png'), mockPng()); await f.store.track('renders/stale.png');
  await assert.rejects(() => render(f.store, deck.slides, undefined, async () => { throw new Error('soffice missing'); }), /Real slide rendering failed.*soffice/s);
  assert.equal(f.store.checkpoint.artifacts['renders/manifest.json'], undefined);
  await assert.rejects(() => fs.stat(awaitPath(f.cwd, 'renders/stale.png')));
  await assert.rejects(() => new Pipeline(f.store).export(), /COMPLETE/);
  await assert.rejects(() => runCommand('pi-presenter-nonexistent-renderer-726', []), /unavailable/);
});
function awaitPath(cwd: string, rel: string) { return path.join(cwd, '.presentation', rel); }
test('renderer fixed argv calls LibreOffice then pdftoppm; mock command output wrong count rejected', async t => {
  const f = await fixture(); t.after(f.cleanup); await compile(f.store, deck, evidence, board, f.sources, design);
  const commands: string[] = [];
  await assert.rejects(() => render(f.store, deck.slides, undefined, async (cmd, args) => {
    commands.push(cmd);
    if (cmd === 'soffice') { assert.ok(args.includes('--headless')); await atomicWrite(await f.store.file('renders/presentation.pdf'), '%PDF-MOCK-ONLY'); }
    if (cmd === 'pdftoppm') { assert.ok(args.includes('-png')); await atomicWrite(await f.store.file('renders/slide-1.png'), mockPng()); }
    return '';
  }), /page count mismatch/);
  assert.deepEqual(commands, ['soffice', 'pdftoppm']); assert.equal(f.store.checkpoint.artifacts['renders/manifest.json'], undefined);
});
test('MOCK integration: approval -> evidence -> storyboard -> real compilation -> MOCK rendering -> revision -> QA -> export', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const pipeline = new MockPipeline(f.store); await pipeline.run();
  assert.equal(f.store.checkpoint.state, 'COMPLETE'); assert.equal(f.store.checkpoint.revision, 1); assert.equal(pipeline.renderCount, 2);
  const d = await f.store.read('deck/deck-spec.yaml', deckSchema);
  const before = await f.store.read('deck/before-revision-1.yaml', deckSchema);
  assert.equal(d.slides[0].layout, 'title'); assert.deepEqual(d.slides[1], before.slides[1]);
  const e = await f.store.read('evidence/evidence.json', evidenceSchema); assert.deepEqual(e, evidence);
  assert.equal(f.store.checkpoint.trace.filter(r => r.role === 'evidence_researcher').length, 1);
  const visual = f.registry.calls.filter(c => JSON.stringify(c.context.messages[0]).includes("visual_reviewer"));
  assert.equal(visual.length, 4);
  for (const call of visual) {
    const user = call.context.messages[1]; assert.ok(user.role === 'user' && Array.isArray(user.content));
    if (user.role === 'user' && Array.isArray(user.content)) {
      const images = user.content.filter(c => c.type === 'image'); assert.equal(images.length, 1);
      assert.equal(Buffer.from(images[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  }
  const destination = await pipeline.export(); assert.equal(destination, await fs.realpath(path.join(f.cwd, contract.output)));
  assert.equal(digest(await boundedRead(destination)), f.store.checkpoint.artifacts['output/presentation.pptx']);
  const priorCalls = f.registry.calls.length;
  const restored = new Store(f.cwd, f.registry); await restored.load(); await new Pipeline(restored).run();
  assert.equal(f.registry.calls.length, priorCalls);
  await fs.appendFile(await f.store.file('output/presentation.pptx'), 'tamper');
  await assert.rejects(() => pipeline.export(), /tampered/);
});
test('MOCK integration: bounded revisions exhausted remains QA, no export', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.alwaysFailVisual = true;
  const pipeline = new MockPipeline(f.store);
  await assert.rejects(() => pipeline.run(), /revision budget exhausted/);
  assert.equal(f.store.checkpoint.state, 'QA'); assert.equal(f.store.checkpoint.revision, 2); assert.equal(pipeline.renderCount, 3);
  await assert.rejects(() => pipeline.export(), /COMPLETE/);
});
test('MOCK integration: Director revision cannot expand affected scope', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.registry.responseOverride = system => system.includes('Task: Integrate') ? { affectedSlideIds: ['slide_a', 'slide_b'], instructions: 'Change both' } : undefined;
  await assert.rejects(() => new MockPipeline(f.store).run(), /expanded scope/);
  assert.equal(f.store.checkpoint.revision, 0); assert.equal(f.store.checkpoint.state, 'QA');
});
test('MOCK integration: stopped patch resumes durably without repeating evidence/narrative', async t => {
  const f = await fixture(); t.after(f.cleanup); let stop = true;
  f.registry.responseOverride = system => {
    if (stop && system.includes('Task: Patch')) throw new Error('simulated patch interruption');
    return undefined;
  };
  await assert.rejects(() => new MockPipeline(f.store).run(), /patch interruption/);
  assert.equal(f.store.checkpoint.pendingRevision?.affectedSlideIds[0], 'slide_a');
  const sourceCalls = f.store.checkpoint.trace.filter(r => r.role === 'evidence_researcher').length;
  stop = false; const restored = new Store(f.cwd, f.registry); await restored.load(); await new MockPipeline(restored).run();
  assert.equal(restored.checkpoint.state, 'COMPLETE'); assert.equal(restored.checkpoint.trace.filter(r => r.role === 'evidence_researcher').length, sourceCalls);
});
test('all QA score thresholds and major findings gate export', () => {
  assert.equal(passed(goodReview, goodReview), true);
  assert.equal(passed({ ...goodReview, factual: 8.99 }, goodReview), false);
  for (const field of ['narrative', 'hierarchy', 'consistency', 'readability'] as const) assert.equal(passed(goodReview, { ...goodReview, [field]: 7.99 }), false);
  assert.equal(passed({ ...goodReview, narrative: 7.99 }, goodReview), false);
  assert.equal(passed(goodReview, { ...goodReview, findings: [{ slideId: 'slide_a', severity: 'major', issue: 'Bad', fix: 'Fix' }] }), false);
});
test('stale extra PNG, missing review record and stale binding block export', async t => {
  const f = await fixture(); t.after(f.cleanup); f.registry.failVisual = 1;
  const pipeline = new MockPipeline(f.store); await pipeline.run();
  await atomicWrite(await f.store.file('renders/slide-99.png'), mockPng());
  await assert.rejects(() => pipeline.export(), /page count/); await fs.rm(await f.store.file('renders/slide-99.png'));
  const reviewFile = 'reviews/fact-0.json';
  const record = await fs.readFile(await f.store.file(reviewFile), 'utf8');
  let value: { binding: string; result: typeof goodReview };
  try { value = JSON.parse(record); } catch { throw new Error('Invalid test review record'); }
  value.binding = 'stale'; await f.store.artifact(reviewFile, value);
  await assert.rejects(() => pipeline.export(), /stale review hashes/);
  delete f.store.checkpoint.artifacts[reviewFile]; await f.store.save();
  await assert.rejects(() => pipeline.export(), /all current review/);
});
test('local CSV/JSON/text/images ingested and PDF missing extractor fails explicitly', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const sources = ['data.csv', 'data.json', 'notes.txt', 'photo.png'];
  const data = ['name,value\nAlpha,100', '{"Alpha":100}', 'Plain text', mockPng()];
  for (const [i, file] of sources.entries()) await atomicWrite(path.join(f.cwd, file), data[i]);
  const c = { ...contract, sources }; await f.store.define(c); await f.store.configure(agents); await f.store.approve(await f.store.fingerprint(), 'Approve & Start');
  const result = await ingest(f.store, c); assert.equal(result.length, 4); assert.equal(result[3].kind, 'image'); assert.ok(result[3].asset);
  await f.store.define({ ...contract, sources: ['report.pdf'] }); await atomicWrite(path.join(f.cwd, 'report.pdf'), '%PDF-MOCK'); await f.store.configure(agents); await f.store.approve(await f.store.fingerprint(), 'Approve & Start');
  await assert.rejects(() => ingest(f.store, { ...contract, sources: ['report.pdf'] }, undefined, async () => { throw new Error('pdftotext missing'); }), /pdftotext missing/);
});
