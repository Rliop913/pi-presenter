import path from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { contractSchema, roles, type Contract, type Agents } from './schema.js';
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

const integerField = (min: number, max: number, label: string) => (raw: string) => {
  const v = raw.trim();
  if (!v) throw new Error('Required');
  if (!/^-?\d+$/.test(v)) throw new Error(`${label} must be an integer`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return n;
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

export async function contractWizard(ui: DialogUI, prior?: Contract): Promise<Contract | undefined> {
  const title = await ask(ui, 'Presentation title', textField(180), prior?.title); if (title === undefined) return undefined;
  const purpose = await ask(ui, 'Purpose / desired audience action', textField(2000), prior?.purpose); if (purpose === undefined) return undefined;
  const audience = await ask(ui, 'Audience', textField(180), prior?.audience); if (audience === undefined) return undefined;
  const durationMinutes = await ask(ui, 'Duration in minutes (1-180)', integerField(1, 180, 'Duration'), prior ? String(prior.durationMinutes) : '10'); if (durationMinutes === undefined) return undefined;
  const slideCount = await ask(ui, 'Slide count (1-30)', integerField(1, 30, 'Slide count'), prior ? String(prior.slideCount) : '8'); if (slideCount === undefined) return undefined;
  const sources = await askSources(ui); if (sources === undefined) return undefined;
  const output = await ask(ui, 'Project-relative export path (must end in .pptx, outside .presentation)', outputField, prior?.output ?? 'presentation.pptx'); if (output === undefined) return undefined;
  const requirements = await ask(ui, 'Output requirements / constraints', textField(2000), prior?.requirements ?? 'Editable widescreen slides, grounded in supplied sources.'); if (requirements === undefined) return undefined;
  const maxRevisions = prior?.maxRevisions ?? 2;
  return contractSchema.parse({ title, purpose, audience, durationMinutes, slideCount, sources, output, requirements, maxRevisions });
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
