import path from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { roles, type Contract, type Agents } from './schema.js';
import { presets, presetEfforts, validateAgents } from './models.js';
import { Store } from './storage.js';

export interface DialogUI {
  input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

/**
 * Ask the user for one input. If parsing fails, surface the error and re-prompt
 * so a transient typo never aborts the whole wizard. Returning undefined means
 * the user cancelled (Esc / dialog dismiss).
 */
async function ask<T>(ui: DialogUI, label: string, parse: (raw: string) => T, placeholder?: string): Promise<T | undefined> {
  for (;;) {
    const raw = await ui.input(label, placeholder);
    if (raw === undefined) return undefined;
    try { return parse(raw); }
    catch (e) { ui.notify(`${label}: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
  }
}

const textField = (max: number) => (raw: string) => {
  const v = raw.trim();
  if (!v) throw new Error('Required');
  if (v.length > max) throw new Error(`Too long (${v.length}/${max} characters)`);
  return v;
};


const sourceChunkField = () => (raw: string): string | null => {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 300000) throw new Error(`Too long (${v.length}/300000 characters); split into a separate source`);
  return v;
};

const outputField = (raw: string): string => {
  const v = raw.trim();
  if (!v) throw new Error('Required');
  if (v.length > 512) throw new Error(`Too long (${v.length}/512 characters)`);
  if (path.isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v)) throw new Error('Must be project-relative (no absolute path or drive letter)');
  if (v.includes('\0')) throw new Error('Invalid path');
  if (v === '.presentation' || v.startsWith('.presentation/') || v.startsWith('.presentation\\')) throw new Error('Cannot write inside .presentation');
  if (!v.endsWith('.pptx')) throw new Error('Must end with .pptx');
  return v;
};

/**
 * Iteratively collect 1-20 freeform text sources. The user pastes a chunk per
 * dialog; an empty submission after the first source finishes the list. Each
 * chunk is a natural-language context description (no file paths, no file I/O).
 */
async function askSources(ui: DialogUI): Promise<string[] | undefined> {
  const sources: string[] = [];
  for (let i = 0; i < 20; i++) {
    const isFirst = i === 0;
    const label = isFirst
      ? 'Source 1: freeform context (paste the source content; you describe it, no file path)'
      : `Source ${i + 1}: paste another freeform context, or leave empty to finish`;
    const placeholder = isFirst ? 'Paste the source content as natural-language context' : undefined;
    const chunk = await ask<string | null>(ui, label, sourceChunkField(), placeholder);
    if (chunk === undefined) return undefined;
    if (chunk === null) {
      if (isFirst) { ui.notify('At least one source is required.', 'error'); i--; continue; }
      break;
    }
    sources.push(chunk);
    const total = sources.reduce((n, s) => n + s.length, 0);
    if (total > 500000) {
      sources.pop();
      ui.notify(`Total source text would be ${total} characters (max 500000). Remove or shorten the last source.`, 'error');
      i--;
    }
  }
  return sources;
}

/**
 * Recognized field keys in a freeform brief. Matches case-insensitively
 * and tolerates a leading `- ` or `* ` bullet, an optional colon, and
 * trailing whitespace. Anything else in the brief is treated as freeform
 * context and ignored by the local parser.
 */
const BRIEF_KEYS = ['title', 'purpose', 'audience', 'duration', 'slides', 'output', 'requirements'] as const;
type BriefKey = typeof BRIEF_KEYS[number];

/**
 * Extract structured fields from a multi-line brief. Supports both
 * structured format (`Title: ...`) and YAML-like format (`title: ...`).
 * Lines that do not match a known key are ignored. Missing fields are
 * simply absent from the result; the caller is responsible for prompting
 * the user for anything that was not provided.
 */
export function parseBrief(text: string): Partial<Record<BriefKey, string | number>> {
  const out: Partial<Record<BriefKey, string | number>> = {};
  if (typeof text !== 'string' || !text.trim()) return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s+/, '').trim();
    if (!line) continue;
    const m = line.match(/^(title|purpose|audience|duration|slides|output|requirements)\s*:\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase() as BriefKey;
    const value = m[2].trim();
    if (!value) continue;
    if (key === 'duration' || key === 'slides') {
      const cleaned = value.replace(/[^0-9-]/g, '');
      if (!cleaned) continue;
      const n = Number(cleaned);
      if (Number.isInteger(n) && n >= 0) out[key] = n;
    } else {
      out[key] = value;
    }
  }
  return out;
}

const BRIEF_PLACEHOLDER = `Paste your brief in any format. Recognized lines (case-insensitive, one per line):
  Title: <your title>
  Purpose: <desired audience action>
  Audience: <who will see this>
  Duration: <number> minutes
  Slides: <number>
  Output: <project-relative path ending in .pptx>
  Requirements: <constraints>

Example:
  Title: Q4 Review
  Purpose: Show progress to the board
  Audience: Executive team
  Duration: 15 minutes
  Slides: 8
  Output: presentation.pptx
  Requirements: Match brand colors, include Q4 highlights

All fields are optional. Leave the brief empty to use sensible defaults (the director will refine the contract after approval).`;

/**
 * Sensible defaults for every contract field. The director refines these
 * after approval, so the user only has to provide a brief and sources.
 */
export function defaultContract(sources: string[]): Omit<Contract, 'maxRevisions'> {
  const firstSource = sources.find((s) => s.trim().length > 0) ?? '';
  const firstSentence = firstSource.split(/[.!?\n]/)[0]?.trim() ?? '';
  const title = firstSentence.length > 180 ? firstSentence.slice(0, 180).trimEnd() : (firstSentence || 'Untitled Presentation');
  const slideCount = Math.min(20, Math.max(3, sources.length * 2 + 1));
  return {
    title,
    purpose: 'Explain the topic to the audience using the supplied sources.',
    audience: 'General audience',
    durationMinutes: 10,
    slideCount,
    sources,
    output: 'presentation.pptx',
    requirements: 'Editable widescreen slides, grounded in supplied sources.',
  };
}

/**
 * Apply a string validator to a parsed brief value; fall back to a default
 * if the value is missing or fails validation. This lets the user paste
 * partially-valid briefs without the wizard aborting.
 */
function pickValid(value: string | number | undefined, validate: (raw: string) => string, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try { return validate(value); } catch { return fallback; }
}

function pickInt(value: string | number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

/**
 * Merge a parsed brief with defaults and the user-supplied sources.
 * Invalid brief values silently fall back to the corresponding default.
 */
export function mergeBrief(parsed: Partial<Record<BriefKey, string | number>>, sources: string[], prior?: Contract): Contract {
  const d = defaultContract(sources);
  return {
    title: pickValid(parsed.title, textField(180), d.title),
    purpose: pickValid(parsed.purpose, textField(2000), d.purpose),
    audience: pickValid(parsed.audience, textField(180), d.audience),
    durationMinutes: pickInt(parsed.duration, 1, 180, d.durationMinutes),
    slideCount: pickInt(parsed.slides, 1, 30, d.slideCount),
    sources,
    output: pickValid(parsed.output, outputField, d.output),
    requirements: pickValid(parsed.requirements, textField(2000), d.requirements),
    maxRevisions: prior?.maxRevisions ?? 2,
  };
}

export async function contractWizard(ui: DialogUI, prior?: Contract): Promise<Contract | undefined> {
  // Step 1: one optional text input for the whole brief. Empty submission
  // is allowed; the user can paste structured fields, prose, or nothing.
  const brief = await ui.input('Brief (optional; paste fields or prose; leave empty for defaults)', BRIEF_PLACEHOLDER);
  if (brief === undefined) return undefined;
  const parsed = parseBrief(brief);

  // Step 2: collect sources (at least one required).
  const sources = await askSources(ui);
  if (sources === undefined) return undefined;

  // Step 3: merge parsed brief with defaults and validate. Invalid brief
  // values silently fall back to defaults; the approval dialog will show
  // the final contract for review.
  return mergeBrief(parsed, sources, prior);
}

export async function agentsWizard(ui: DialogUI, store: Store): Promise<Agents | undefined> {
  const choice = await ui.select('Quality preset (suggestions only; every assignment is explicit)', Object.keys(presets));
  if (!choice) return undefined;
  const preset = choice as keyof typeof presets;
  if (!(preset in presets)) throw new Error('Invalid preset selection');
  const agents = {} as Agents;
  for (const [i, role] of roles.entries()) {
    const available = store.registry.getAvailable().filter(m => role !== 'visual_reviewer' || m.input.includes('image'));
    if (!available.length) throw new Error(`No available ${role === 'visual_reviewer' ? 'vision ' : ''}models; configure Pi credentials/catalog first`);
    const suggestion = presets[preset][i];
    const found = available.some(m => m.id === suggestion);
    const options = available.map((m, index) => `${index + 1}. ${m.provider}/${m.id}${m.id === suggestion ? ' (suggested)' : ''}`);
    const selected = await ui.select(`${role}: suggested ${suggestion}${found ? '' : ' UNAVAILABLE — choose an explicit replacement'}`, options);
    if (selected === undefined) return undefined;
    const index = options.indexOf(selected);
    if (index < 0) throw new Error('Invalid model selection');
    const model = available[index]; const levels = getSupportedThinkingLevels(model);
    const level = await ui.select(`${role}: effort (suggested ${presetEfforts[preset][i]}; only host-supported choices)`, levels);
    if (level === undefined) return undefined;
    if (!levels.includes(level as typeof levels[number])) throw new Error('Unsupported effort choice');
    agents[role] = { provider: model.provider, id: model.id, effort: level as typeof levels[number] };
  }
  return validateAgents(store.registry, agents);
}

export async function approvalDialog(ui: DialogUI, store: Store): Promise<boolean> {
  if (store.checkpoint.state !== 'AWAITING_APPROVAL') throw new Error('Configure every role before approval');
  const { contract, agents } = await store.inputs();
  const fingerprint = await store.fingerprint();
  const matrix = roles.map(r => `${r}: ${agents[r].provider}/${agents[r].id} | effort=${agents[r].effort}`).join('\n');
  const sourcesPreview = contract.sources.map((s, i) => `source_${i + 1} (${s.length} chars): ${s.slice(0, 80).replace(/\s+/g, ' ')}${s.length > 80 ? '…' : ''}`).join('\n  ');
  const summary = `Title: ${contract.title}\nPurpose: ${contract.purpose}\nAudience: ${contract.audience}\nDuration: ${contract.durationMinutes} minutes | Slides: ${contract.slideCount}\nSources (${contract.sources.length} freeform chunks):\n  ${sourcesPreview}\nExport: ${contract.output}\nRequirements: ${contract.requirements}\nRevision limit: ${contract.maxRevisions}\n\n${matrix}\n\nApproval covers only these inputs. Source text will be sent to the selected providers; no parent conversation or tools.\nFingerprint: ${fingerprint}`;
  ui.notify(summary, 'info');
  const selected = await ui.select(`Approve full presentation contract and role/model/effort matrix\n${summary}`, ['Approve & Start', 'Cancel']);
  if (selected !== 'Approve & Start') return false;
  await store.approve(fingerprint, selected); return true;
}
