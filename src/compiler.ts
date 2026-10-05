import { createRequire } from 'node:module';
import type PptxModule from 'pptxgenjs';
// PptxGenJS 4 ships CJS type declarations; use its native CJS constructor explicitly.
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs') as typeof PptxModule.default;
import { Store, atomicWrite, boundedRead, digest, safePath } from './storage.js';
import { designSchema, type Design, type Deck, type Evidence, type Source, type Storyboard } from './schema.js';
import { validateDeck, validateEvidence, validateStoryboard, imageMime } from './evidence.js';

/** Fixed geometry and editable text/shapes/charts. No code or layout execution from models. */
export async function compile(store: Store, deck: Deck, evidence: Evidence, board: Storyboard, sources: Source[], design: Design, signal?: AbortSignal) {
  await store.gate(); signal?.throwIfAborted();
  const { contract } = await store.inputs();
  if (sources.length !== contract.sources.length) throw new Error('Compiler source count differs from approved contract');
  for (const [i, source] of sources.entries()) {
    if (source.path !== contract.sources[i] || source.hash !== digest(await boundedRead(await safePath(store.cwd, source.path)))) throw new Error('Compiler source provenance differs from approved inputs');
  }
  validateEvidence(evidence, sources); validateStoryboard(board, evidence, contract); validateDeck(deck, evidence, board, sources); designSchema.parse(design);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'Pi Presenter'; pptx.subject = 'Evidence-grounded presentation';
  pptx.title = (await store.inputs()).contract.title; pptx.company = 'Pi Presenter';
  pptx.theme = { headFontFace: design.font, bodyFontFace: design.font };
  for (const [index, spec] of deck.slides.entries()) {
    signal?.throwIfAborted();
    const slide = pptx.addSlide(); slide.background = { color: design.background };
    const text = (value: string, x: number, y: number, w: number, h: number, size = design.bodySize, bold = false) => {
      slide.addText(value, { x, y, w, h, fontFace: design.font, fontSize: size, color: design.foreground, bold, margin: 0, breakLine: false, valign: 'top', paraSpaceAfter: 10, lang: 'en-US' });
    };
    slide.addShape(pptx.ShapeType.rect, { x: 0.55, y: 0.55, w: 0.09, h: 0.75, fill: { color: design.accent }, line: { color: design.accent } });
    text(spec.title, 0.85, 0.55, 11.7, 0.95, design.titleSize, true);
    const claims = spec.claimIds.map(id => evidence.claims.find(c => c.id === id)!);
    const body = claims.map(c => c.text);
    const drawList = (items: string[], x: number, w: number, y = 1.85, height = 4.65) => {
      const cell = height / items.length;
      items.forEach((item, i) => text(`• ${item}`, x, y + cell * i, w, cell - 0.12));
    };
    switch (spec.layout) {
      case 'title': body.forEach((b, i) => text(b, 1.1, 2.2 + i * 1.7, 10.9, 1.5, design.bodySize + 2)); break;
      case 'bullets': drawList(body, 0.85, 11.6); break;
      case 'two-column': {
        const split = Math.ceil(body.length / 2); drawList(body.slice(0, split), 0.85, 5.5);
        if (split < body.length) drawList(body.slice(split), 6.95, 5.5);
        slide.addShape(pptx.ShapeType.line, { x: 6.65, y: 1.85, w: 0, h: 4.65, line: { color: design.accent, width: 1 } }); break;
      }
      case 'process': {
        const cell = 11.6 / body.length;
        body.forEach((b, i) => {
          const x = 0.85 + i * cell;
          slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.15, w: cell - 0.25, h: 3.8, fill: { color: design.background }, line: { color: design.accent, width: 2 } });
          text(b, x + 0.15, 2.4, cell - 0.55, 3.25, 18);
          if (i < body.length - 1) slide.addShape(pptx.ShapeType.chevron, { x: x + cell - 0.22, y: 3.65, w: 0.2, h: 0.35, fill: { color: design.accent }, line: { color: design.accent } });
        }); break;
      }
      case 'chart': {
        const figure = evidence.figures.find(f => f.id === spec.figureId)!;
        slide.addChart(pptx.ChartType.bar, [{ name: figure.unit || figure.title, labels: figure.labels, values: figure.values }], { x: 0.85, y: 1.85, w: 7.35, h: 4.6, catAxisLabelFontFace: design.font, catAxisLabelFontSize: 14, valAxisLabelFontSize: 14, showLegend: false, showTitle: true, title: figure.title, titleFontSize: 18, chartColors: [design.accent], showValue: true, dataLabelFormatCode: '0.##' });
        drawList(body, 8.65, 3.85); break;
      }
      case 'image': {
        const file = await store.file(spec.asset!); const bytes = await boundedRead(file);
        imageMime(bytes);
        if (!sources.some(s => s.asset === spec.asset && s.hash === digest(bytes))) throw new Error('Image asset hash does not match source provenance');
        slide.addImage({ path: file, x: 0.85, y: 1.85, w: 7.35, h: 4.65, sizing: { type: 'contain', w: 7.35, h: 4.65 } });
        drawList(body, 8.65, 3.85); break;
      }
    }
    const citations = [...new Set(claims.flatMap(c => c.citations.map(ref => ref.sourceId)))];
    text(`Sources: ${citations.join(', ')}  |  ${index + 1}`, 0.85, 6.95, 11.7, 0.25, 10);
    slide.addNotes(claims.map(c => `${c.id}: ${c.text}\n${c.citations.map(ref => `${ref.sourceId}: ${ref.quote}`).join('\n')}`).join('\n\n'));
  }
  const output = await pptx.write({ outputType: 'nodebuffer', compression: true });
  signal?.throwIfAborted(); await store.gate();
  await atomicWrite(await store.file('output/presentation.pptx'), output as Buffer);
  await store.track('output/presentation.pptx');
}
