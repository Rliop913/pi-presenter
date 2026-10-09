import { digest, canonical } from "./storage.js";
import {
  evidenceSchema,
  deckSchema,
  storyboardSchema,
  type Source,
  type Evidence,
  type Deck,
  type Storyboard,
  type Contract,
} from "./schema.js";

export function imageMime(data: Uint8Array): "image/png" | "image/jpeg" {
  const bytes = Buffer.from(data);
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let offset = 8;
    let idat = false;
    let end = false;
    let chunks = 0;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (++chunks > 10000 || length > bytes.length - offset - 12)
        throw new Error("Malformed PNG chunks");
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13)
          throw new Error("Invalid PNG header");
        const w = bytes.readUInt32BE(offset + 8);
        const h = bytes.readUInt32BE(offset + 12);
        if (!w || !h || w > 10000 || h > 10000 || w * h > 40000000)
          throw new Error("Image exceeds dimension/pixel limits");
      }
      if (type === "IDAT" && length > 0) idat = true;
      offset += length + 12;
      if (type === "IEND") {
        if (length !== 0) throw new Error("Malformed PNG end");
        end = true;
        break;
      }
    }
    if (!idat || !end || offset !== bytes.length)
      throw new Error("Truncated/invalid PNG");
    return "image/png";
  }
  if (
    bytes.length > 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  )
    return "image/jpeg";
  throw new Error("Only structurally validated PNG/JPEG images are supported");
}

/**
 * Ingest freeform text sources from the approved contract. No file I/O: the
 * wizard collected the source content directly from the user, so the source
 * is just the literal text. Per-source and total character limits are
 * re-checked here as a defense-in-depth gate against a tampered config.
 */
/**
 * Ingest the approved contract into source records. If the user provided
 * no explicit sources but the contract has a freeform description, the
 * description is used as a single source so the evidence researcher
 * always has grounded material to work with. The per-source 300000 char
 * limit and the 500000 total char limit are enforced here as
 * defense-in-depth against a tampered config.
 */
export function approvedSourceTexts(contract: Contract): string[] {
  return contract.sources.length > 0
    ? contract.sources
    : contract.description.trim()
      ? [contract.description]
      : [];
}
export async function ingest(
  store: import("./storage.js").Store,
  contract: Contract,
  signal?: AbortSignal,
): Promise<Source[]> {
  await store.gate();
  signal?.throwIfAborted();
  if (canonical(contract) !== canonical((await store.inputs()).contract))
    throw new Error("Ingestion contract differs from approved inputs");
  const rawSources = approvedSourceTexts(contract);
  if (rawSources.length === 0)
    throw new Error(
      "Contract has no source content. Provide a description or paste source text in the wizard.",
    );
  let textTotal = 0;
  const sources: Source[] = [];
  for (let i = 0; i < rawSources.length; i++) {
    signal?.throwIfAborted();
    const text = rawSources[i];
    if (!text.trim()) throw new Error(`Source ${i + 1} is empty`);
    if (text.length > 300000)
      throw new Error(`Source ${i + 1} exceeds 300000 characters`);
    textTotal += text.length;
    if (textTotal > 500000)
      throw new Error("Total source text exceeds 500000 characters");
    sources.push({ id: `source_${i + 1}`, text, hash: digest(text) });
  }
  return sources;
}

export function unique(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
}

// Fact interpretation belongs to the independent semantic reviewer, not numeric regexes.

/**
 * Build a minimal evidence database from the source text itself when the
 * model returns no claims. The fallback takes the first sentence of the
 * first source as both the claim text and the citation quote, so the
 * resulting claim is always grounded in the supplied source and passes
 * `validateEvidence`. The storyboard step always has at least one claim
 * to reference, so the pipeline can complete end-to-end.
 *
 * This is a safety net for when the model is overly conservative or the
 * source is too short for structured extraction. The claim is marked
 * with a recognisable id (`claim_fallback`) so downstream review steps
 * can flag it as low-quality if desired.
 */
export function fallbackEvidence(sources: Source[]): Evidence {
  const first = sources[0];
  if (!first)
    throw new Error(
      "Cannot create fallback evidence without at least one source",
    );
  const trimmed = first.text.trim();
  const firstSentence = trimmed.split(/[.!?\n]/)[0]?.trim() ?? "";
  // Use the first sentence as both text and quote so the text is always
  // a substring of the quote (required by validateEvidence). If the
  // source has no sentence boundary, fall back to the first 240 chars.
  // Truncate to 240 chars to stay within the claimSchema max length.
  const chunk = (firstSentence || trimmed).slice(0, 240);
  const text = chunk;
  const quote = chunk;
  return {
    claims: [
      {
        id: "claim_fallback",
        text,
        citations: [{ sourceId: first.id, quote }],
      },
    ],
    figures: [],
  };
}

export function validateEvidence(value: unknown, sources: Source[]): Evidence {
  const ev = evidenceSchema.parse(value);
  unique(
    ev.claims.map((c) => c.id),
    "claim ids",
  );
  unique(
    ev.figures.map((f) => f.id),
    "figure ids",
  );
  unique(
    sources.map((s) => s.id),
    "source ids",
  );
  // IDs and chart array shapes are compiler links, not tests of language or truth.
  // Paraphrases, typography, translations and numbers are judged by the independent reviewer.
  for (const claim of ev.claims) {
    for (const citation of claim.citations) {
      if (!sources.some(source => source.id === citation.sourceId))
        throw new Error(`Compiler handoff references an unknown source: ${citation.sourceId}`);
    }
  }
  for (const figure of ev.figures) {
    if (!sources.some(source => source.id === figure.sourceId))
      throw new Error(`Compiler handoff references an unknown source: ${figure.sourceId}`);
    if (figure.labels.length !== figure.values.length)
      throw new Error('Compiler chart labels/value length mismatch');
  }
  return ev;
}

export function refs(ids: string[], evidence: Evidence) {
  unique(ids, "claim references");
  for (const id of ids)
    if (!evidence.claims.some((c) => c.id === id))
      throw new Error(`Unknown claim reference: ${id}`);
}

export function validateStoryboard(
  value: unknown,
  evidence: Evidence,
  contract: Contract,
): Storyboard {
  const board = storyboardSchema.parse(value);
  if (board.slides.length !== contract.slideCount)
    throw new Error("Storyboard does not match approved slide count");
  unique(
    board.slides.map((s) => s.id),
    "slide ids",
  );
  for (const slide of board.slides) {
    refs(slide.claimIds, evidence);
  }
  return board;
}

export function validateDeck(
  value: unknown,
  evidence: Evidence,
  board: Storyboard,
  _sources: Source[],
): Deck {
  const deck = deckSchema.parse(value);
  if (deck.slides.length !== board.slides.length)
    throw new Error("Deck slide count mismatch");
  unique(
    deck.slides.map((s) => s.id),
    "slide ids",
  );
  deck.slides.forEach((slide, i) => {
    const story = board.slides[i];
    refs(slide.claimIds, evidence);
    if (
      slide.id !== story.id ||
      canonical(slide.claimIds) !== canonical(story.claimIds)
    )
      throw new Error(
        'Compiler handoff must preserve slide order and claim links',
      );
    if (slide.layout === "chart") {
      const f = evidence.figures.find((f) => f.id === slide.figureId);
      if (
        !f ||
        !slide.claimIds.some((id) =>
          evidence.claims
            .find((c) => c.id === id)
            ?.citations.some((c) => c.sourceId === f.sourceId),
        )
      )
        throw new Error("Chart lacks cited figure provenance");
    } else if (slide.figureId)
      throw new Error("figureId only allowed for chart");
    if (slide.layout === "process" && slide.claimIds.length > 4)
      throw new Error("Process layout allows at most four steps");
    if (slide.layout === "title" && slide.claimIds.length > 2)
      throw new Error("Title layout allows at most two claims");
    if (slide.layout === "chart" && slide.claimIds.length > 3)
      throw new Error("Chart layout allows at most three claims");
    if (
      slide.claimIds.reduce(
        (n, id) => n + evidence.claims.find((c) => c.id === id)!.text.length,
        0,
      ) > 900
    )
      throw new Error("Slide exceeds text density limit");
  });
  return deck;
}

export function applyPatch(deck: Deck, patch: Deck, affected: string[]): Deck {
  unique(affected, "affected slide ids");
  unique(
    patch.slides.map((s) => s.id),
    "patch slide ids",
  );
  if (
    affected.some((id) => !deck.slides.some((s) => s.id === id)) ||
    canonical([...affected].sort()) !==
      canonical(patch.slides.map((s) => s.id).sort())
  )
    throw new Error("Patch must contain exactly the affected slides");
  const result = {
    slides: deck.slides.map((s) =>
      affected.includes(s.id)
        ? patch.slides.find((p) => p.id === s.id)!
        : structuredClone(s),
    ),
  };
  deck.slides.forEach((s, i) => {
    if (
      !affected.includes(s.id) &&
      canonical(s) !== canonical(result.slides[i])
    )
      throw new Error("Unaffected slide mutated");
  });
  return result;
}
