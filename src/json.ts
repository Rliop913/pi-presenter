/**
 * Tolerant JSON extractor for model output.
 *
 * Models (notably Minimax, OpenAI, Anthropic) frequently wrap JSON in
 * Markdown fences or surround it with prose despite instructions to
 * return strict JSON. This module pulls a single JSON value out of
 * such text so the rest of the pipeline does not have to care.
 *
 * The strategy is intentionally narrow:
 *   1. If a fenced code block is present, take the first one.
 *   2. Otherwise, take the substring from the first `{` or `[` to the
 *      last matching `}` or `]`.
 *   3. Trim whitespace.
 *
 * It does NOT try to repair malformed JSON. If the extracted substring
 * is not valid JSON, the caller will get a normal `SyntaxError` from
 * `JSON.parse`.
 */

/**
 * Pull a single JSON value out of possibly-prose-wrapped model output.
 * Returns the extracted substring; the caller is expected to feed it
 * to `JSON.parse`.
 */
export function extractJson(text: string): string {
  // 1) Prefer a fenced code block (```json ... ``` or ``` ... ```).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && typeof fenced[1] === 'string') {
    return fenced[1].trim();
  }
  // 2) Otherwise, find the first opening bracket and the last matching
  //    closing bracket and slice the substring between them. This
  //    tolerates leading prose ("Here is the JSON: ") and trailing
  //    commentary ("Let me know if you need changes.").
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let first = -1;
  if (firstBrace === -1) first = firstBracket;
  else if (firstBracket === -1) first = firstBrace;
  else first = Math.min(firstBrace, firstBracket);
  if (first === -1) return text.trim();
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const last = Math.max(lastBrace, lastBracket);
  if (last <= first) return text.trim();
  return text.slice(first, last + 1).trim();
}
