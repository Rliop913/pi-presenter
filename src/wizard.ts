import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { contractSchema, roles, type Contract, type Agents } from './schema.js';
import { presets, presetEfforts, validateAgents } from './models.js';
import { Store } from './storage.js';

export interface DialogUI {
  input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}
export async function contractWizard(ui: DialogUI, prior?: Contract): Promise<Contract | undefined> {
  const fields = [
    ['title', 'Presentation title', prior?.title], ['purpose', 'Purpose / desired audience action', prior?.purpose],
    ['audience', 'Audience', prior?.audience], ['durationMinutes', 'Duration in minutes (1–180)', String(prior?.durationMinutes ?? 10)],
    ['slideCount', 'Slide count (1–30)', String(prior?.slideCount ?? 8)],
    ['sources', 'Project-relative source paths (one per line; text/CSV/JSON/Markdown/PDF/PNG/JPEG)', prior?.sources.join('\n')],
    ['output', 'Project-relative export path outside .presentation', prior?.output ?? 'presentation.pptx'],
    ['requirements', 'Output requirements / constraints', prior?.requirements ?? 'Editable widescreen slides, grounded in supplied sources.'],
  ] as const;
  const values: Record<string, unknown> = { maxRevisions: prior?.maxRevisions ?? 2 };
  for (const [key, label, placeholder] of fields) {
    const input = await ui.input(label, placeholder);
    if (input === undefined) return undefined;
    const value = input.trim();
    values[key] = ['slideCount', 'durationMinutes'].includes(key) ? Number(value) : key === 'sources' ? value.split(/\r?\n/).map(p => p.trim()).filter(Boolean) : value;
  }
  return contractSchema.parse(values);
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
  const summary = `Title: ${contract.title}\nPurpose: ${contract.purpose}\nAudience: ${contract.audience}\nDuration: ${contract.durationMinutes} minutes | Slides: ${contract.slideCount}\nSources: ${contract.sources.join(', ')}\nExport: ${contract.output}\nRequirements: ${contract.requirements}\nRevision limit: ${contract.maxRevisions}\n\n${matrix}\n\nApproval covers only these inputs. Local source data will be sent to the selected providers; no parent conversation or tools.\nFingerprint: ${fingerprint}`;
  ui.notify(summary, 'info');
  const selected = await ui.select(`Approve full presentation contract and role/model/effort matrix\n${summary}`, ['Approve & Start', 'Cancel']);
  if (selected !== 'Approve & Start') return false;
  await store.approve(fingerprint, selected); return true;
}
