// Mechanical integration tests only. No production/native M3 authority is created.
// The temporary fixture mocks its native UI; actual PptxGenJS/LibreOffice/Poppler are used.
// No PDJE claims, agent reviews or presentation certification are implied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { boundedRead } from '../src/storage.js';
import { presentationFiles } from '../src/file-tools.js';
import { skillFixture } from './skill-fixture.js';

async function makeEditableDiagnosticDeck(file: string) {
  const adapterURL = new URL('../skills/presenter/scripts/pptx.mjs', import.meta.url).href;
  const { createPresentation } = await import(adapterURL);
  const pptx = createPresentation();
  pptx.title = 'Mechanical fixture — not a certified presentation';
  const first = pptx.addSlide();
  first.addText('편집 가능한 렌더링 테스트', { x: 0.6, y: 0.5, w: 12, h: 0.8, fontFace: 'Arial', fontSize: 30 });
  first.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.5, w: 12, h: 0, line: { color: '3366AA', width: 2 } });
  first.addText('Only software/file integration is being tested.', { x: 0.6, y: 2, w: 12, h: 1, fontSize: 24 });
  first.addNotes('Synthetic mechanical fixture. No factual source or QA certification.');
  const second = pptx.addSlide();
  second.addText('Native editable chart — synthetic fixture data', { x: 0.6, y: 0.5, w: 12, h: 0.8, fontSize: 28 });
  second.addChart(pptx.ChartType.bar, [{ name: 'Synthetic', labels: ['A', 'B'], values: [1, 2] }], { x: 1, y: 1.6, w: 10, h: 4.8 });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await pptx.writeFile({ fileName: file });
}

test('bundled authoring adapter produces real editable text/shapes/chart without a normalized content schema', async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  const file = await f.store.file('skill/drafts/mechanical.pptx');
  await makeEditableDiagnosticDeck(file);
  const zip = await JSZip.loadAsync(await boundedRead(file));
  assert.equal(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 2);
  const first = await zip.file('ppt/slides/slide1.xml')!.async('string');
  assert.ok(first.includes('편집 가능한 렌더링 테스트'));
  assert.ok(first.includes('<p:sp>'));
  assert.ok(zip.file('ppt/charts/chart1.xml'));
  assert.ok(zip.file('ppt/notesSlides/notesSlide1.xml'));
  assert.equal(f.calls(), 0);
});

test('real LibreOffice PDF and Poppler PNG conversion through the production leaf helper', {
  skip: process.env.PRESENTER_REAL_RENDER_TEST !== '1', timeout: 120000,
}, async t => {
  const f = await skillFixture(); t.after(f.cleanup);
  await makeEditableDiagnosticDeck(await f.store.file('skill/drafts/mechanical.pptx'));
  await presentationFiles(f.store, { action: 'register', artifact: 'drafts/mechanical.pptx' });
  const result = await presentationFiles(f.store, { action: 'render', artifact: 'drafts/mechanical.pptx' });
  // Narrow software metadata, not language-output validation.
  const manifest = result as {pdf: string; pages: {artifact: string; page: number}[]};
  assert.equal(manifest.pages.length, 2);
  assert.equal((await boundedRead(await f.store.file(manifest.pdf))).subarray(0, 5).toString(), '%PDF-');
  for (const page of manifest.pages) {
    const png = await boundedRead(await f.store.file(page.artifact));
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.ok(png.readUInt32BE(16) >= 100 && png.readUInt32BE(20) >= 100);
  }
  assert.equal(f.calls(), 0);
  await assert.rejects(presentationFiles(f.store, { action: 'export' }), /Missing current independent raw review reports/);
  await assert.rejects(fs.stat(path.join(f.cwd, 'export/test.pptx')));
  t.diagnostic('Real 2-slide PDF/PNG rendering passed in a disposable mocked-authority fixture. Zero model calls; no independent review or certified export.');
});
