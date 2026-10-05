import { digest, canonical } from './storage.js';
import { evidenceSchema, deckSchema, storyboardSchema, type Source, type Evidence, type Deck, type Storyboard, type Contract } from './schema.js';

export function imageMime(data: Uint8Array): 'image/png' | 'image/jpeg' {
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8; let idat = false; let end = false; let chunks = 0;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (++chunks > 10000 || length > bytes.length - offset - 12) throw new Error('Malformed PNG chunks');
      if (offset === 8) {
        if (type !== 'IHDR' || length !== 13) throw new Error('Invalid PNG header');
        const w = bytes.readUInt32BE(offset + 8); const h = bytes.readUInt32BE(offset + 12);
        if (!w || !h || w > 10000 || h > 10000 || w * h > 40000000) throw new Error('Image exceeds dimension/pixel limits');
      }
      if (type === 'IDAT' && length > 0) idat = true;
      offset += length + 12;
      if (type === 'IEND') { if (length !== 0) throw new Error('Malformed PNG end'); end = true; break; }
    }
    if (!idat || !end || offset !== bytes.length) throw new Error('Truncated/invalid PNG');
    return 'image/png';
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) return 'image/jpeg';
  throw new Error('Only structurally validated PNG/JPEG images are supported');
}

/**
 * Ingest freeform text sources from the approved contract. No file I/O: the
 * wizard collected the source content directly from the user, so the source
 * is just the literal text. Per-source and total character limits are
 * re-checked here as a defense-in-depth gate against a tampered config.
 */
export async function ingest(store: import('./storage.js').Store, contract: Contract, signal?: AbortSignal): Promise<Source[]> {
  await store.gate(); signal?.throwIfAborted();
  if (canonical(contract) !== canonical((await store.inputs()).contract)) throw new Error('Ingestion contract differs from approved inputs');
  let textTotal = 0;
  const sources: Source[] = [];
  for (let i = 0; i < contract.sources.length; i++) {
    signal?.throwIfAborted();
    const text = contract.sources[i];
    if (!text.trim()) throw new Error(`Source ${i + 1} is empty`);
    if (text.length > 300000) throw new Error(`Source ${i + 1} exceeds 300000 characters`);
    textTotal += text.length;
    if (textTotal > 500000) throw new Error('Total source text exceeds 500000 characters');
    sources.push({ id: `source_${i + 1}`, text, hash: digest(text) });
  }
  return sources;
}

export function unique(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
}

/** Conservative numeric gate: exact lexical numbers, no derived arithmetic or invented metrics. */
export function numbers(text: string): string[] { return text.match(/[-+]?\d+(?:[.,]\d+)*(?:%|\b)/g) ?? []; }
export function groundedNumbers(text: string, support: string) {
  const allowed = new Set(numbers(support));
  if (numbers(text).some(n => !allowed.has(n))) throw new Error(`Unsupported numeric assertion: ${text}`);
}

export function validateEvidence(value: unknown, sources: Source[]): Evidence {
  const ev = evidenceSchema.parse(value);
  unique(ev.claims.map(c => c.id), 'claim ids'); unique(ev.figures.map(f => f.id), 'figure ids'); unique(sources.map(s => s.id), 'source ids');
  const quote = (sourceId: string, q: string) => {
    const source = sources.find(s => s.id === sourceId);
    if (!source || !source.text.includes(q)) throw new Error(`Invalid citation/quote for ${sourceId}`);
  };
  for (const claim of ev.claims) {
    claim.citations.forEach(c => quote(c.sourceId, c.quote));
    groundedNumbers(claim.text, claim.citations.map(c => c.quote).join('\n'));
    if (numbers(claim.text).length && !claim.citations.some(c => c.quote.includes(claim.text))) throw new Error(`Unsupported numeric assertion must be an exact sourced statement: ${claim.text}`);
  }
  for (const figure of ev.figures) {
    quote(figure.sourceId, figure.quote);
    if (figure.labels.length !== figure.values.length) throw new Error('Figure labels/value length mismatch');
    groundedNumbers(`${figure.title} ${figure.unit} ${figure.values.join(' ')}`, figure.quote);
    if (figure.labels.some(label => !figure.quote.includes(label)) || (figure.unit && !figure.quote.includes(figure.unit))) throw new Error('Figure labels/unit lack literal provenance');
    unique(figure.labels, 'figure labels');
    const fragments = figure.quote.split(/\n|;|(?<=[.!?])\s+/);
    figure.labels.forEach((label, i) => {
      const supported = fragments.some(fragment => {
        const start = fragment.indexOf(label); if (start < 0) return false;
        const rest = fragment.slice(start + label.length);
        const boundaries = figure.labels.filter(other => other !== label).map(other => rest.indexOf(other)).filter(n => n >= 0);
        const segment = rest.slice(0, boundaries.length ? Math.min(...boundaries) : undefined);
        return numbers(segment).includes(String(figure.values[i]));
      });
      if (!supported) throw new Error(`Figure label/value association lacks literal provenance: ${label}`);
    });
  }
  return ev;
}

export function refs(ids: string[], evidence: Evidence) {
  unique(ids, 'claim references');
  for (const id of ids) if (!evidence.claims.some(c => c.id === id)) throw new Error(`Unknown claim reference: ${id}`);
}

export function validateStoryboard(value: unknown, evidence: Evidence, contract: Contract): Storyboard {
  const board = storyboardSchema.parse(value);
  if (board.slides.length !== contract.slideCount) throw new Error('Storyboard does not match approved slide count');
  unique(board.slides.map(s => s.id), 'slide ids');
  for (const slide of board.slides) {
    refs(slide.claimIds, evidence);
    const claims = evidence.claims.filter(c => slide.claimIds.includes(c.id));
    groundedNumbers(slide.title, claims.map(c => c.text).join(' '));
    if (numbers(slide.title).length && !claims.some(c => c.text.includes(slide.title))) throw new Error('Numeric title must be an exact supported claim substring');
  }
  return board;
}

export function validateDeck(value: unknown, evidence: Evidence, board: Storyboard, sources: Source[]): Deck {
  const deck = deckSchema.parse(value);
  if (deck.slides.length !== board.slides.length) throw new Error('Deck slide count mismatch');
  unique(deck.slides.map(s => s.id), 'slide ids');
  deck.slides.forEach((slide, i) => {
    const story = board.slides[i]; refs(slide.claimIds, evidence);
    if (slide.id !== story.id || slide.title !== story.title || canonical(slide.claimIds) !== canonical(story.claimIds)) throw new Error('Visual spec must preserve storyboard order, titles and claim references');
    if (slide.layout === 'chart') {
      const f = evidence.figures.find(f => f.id === slide.figureId);
      if (!f || !slide.claimIds.some(id => evidence.claims.find(c => c.id === id)?.citations.some(c => c.sourceId === f.sourceId))) throw new Error('Chart lacks cited figure provenance');
    } else if (slide.figureId) throw new Error('figureId only allowed for chart');
    if (slide.layout === 'process' && slide.claimIds.length > 4) throw new Error('Process layout allows at most four steps');
    if (slide.layout === 'title' && slide.claimIds.length > 2) throw new Error('Title layout allows at most two claims');
    if (slide.layout === 'chart' && slide.claimIds.length > 3) throw new Error('Chart layout allows at most three claims');
    if (slide.claimIds.reduce((n, id) => n + evidence.claims.find(c => c.id === id)!.text.length, 0) > 900) throw new Error('Slide exceeds text density limit');
  });
  return deck;
}

export function applyPatch(deck: Deck, patch: Deck, affected: string[]): Deck {
  unique(affected, 'affected slide ids'); unique(patch.slides.map(s => s.id), 'patch slide ids');
  if (affected.some(id => !deck.slides.some(s => s.id === id)) || canonical([...affected].sort()) !== canonical(patch.slides.map(s => s.id).sort())) throw new Error('Patch must contain exactly the affected slides');
  const result = { slides: deck.slides.map(s => affected.includes(s.id) ? patch.slides.find(p => p.id === s.id)! : structuredClone(s)) };
  deck.slides.forEach((s, i) => { if (!affected.includes(s.id) && canonical(s) !== canonical(result.slides[i])) throw new Error('Unaffected slide mutated'); });
  return result;
}
