import { getSupportedThinkingLevels, type Api, type Model, type Context, type ModelsSimpleStreamOptions, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { agentsSchema, isCompactAgents, roles, units, type Agents, type Assignment, type Role, type Unit } from './authority-schema.js';

export interface Registry {
  getAvailable(): Model<Api>[];
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
}
export function resolveAssignment(registry: Registry, role: Role | Unit, assignment: Assignment): Model<Api> {
  const model = registry.getAvailable().find(m => m.provider === assignment.provider && m.id === assignment.id);
  if (!model) throw new Error(`Unavailable assignment for ${role}: ${assignment.provider}/${assignment.id}. Choose an exact available replacement.`);
  if ((role === 'visual_reviewer' || role === 'reviewer') && !model.input.includes('image')) throw new Error('Visual reviewer requires image input capability');
  if (!getSupportedThinkingLevels(model).includes(assignment.effort)) throw new Error(`Unsupported effort ${assignment.effort} for ${model.provider}/${model.id}; choose explicitly, no clamping`);
  return model;
}
// Preserve legacy role order and record shape: both are approval fingerprint inputs.
function assignmentEntries(agents: Agents) {
  return isCompactAgents(agents)
    ? units.map(unit => [unit, agents[unit]] as const)
    : roles.map(role => [role, agents[role]] as const);
}
export function validateAgents(registry: Registry, value: unknown): Agents {
  const agents = agentsSchema.parse(value);
  for (const [role, assignment] of assignmentEntries(agents)) resolveAssignment(registry, role, assignment);
  return agents;
}
export function capabilities(registry: Registry, agents: Agents) {
  return assignmentEntries(agents).map(([role, assignment]) => {
    const m = resolveAssignment(registry, role, assignment);
    return { role, provider: m.provider, id: m.id, api: m.api, baseUrl: m.baseUrl, input: m.input, reasoning: m.reasoning, effortMap: m.thinkingLevelMap, efforts: getSupportedThinkingLevels(m), contextWindow: m.contextWindow, maxTokens: m.maxTokens };
  });
}
// Suggestions are names only, never executable assignments or provider guesses.
export const legacyPresets = {
  economy: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra'],
  balanced: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-sol'],
  maximum: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra'],
} as const;
export const legacyPresetEfforts = {
  economy: ['medium', 'low', 'medium', 'medium', 'medium', 'medium', 'medium'],
  balanced: ['high', 'medium', 'high', 'high', 'medium', 'high', 'high'],
  maximum: ['high', 'high', 'high', 'high', 'high', 'high', 'high'],
} as const;
// Four-unit suggestions use the old director/evidence/visual/visual-review slots.
export const presets = {
  economy: [legacyPresets.economy[0], legacyPresets.economy[1], legacyPresets.economy[4], legacyPresets.economy[6]],
  balanced: [legacyPresets.balanced[0], legacyPresets.balanced[1], legacyPresets.balanced[4], legacyPresets.balanced[6]],
  maximum: [legacyPresets.maximum[0], legacyPresets.maximum[1], legacyPresets.maximum[4], legacyPresets.maximum[6]],
} as const;
export const presetEfforts = {
  economy: [legacyPresetEfforts.economy[0], legacyPresetEfforts.economy[1], legacyPresetEfforts.economy[4], legacyPresetEfforts.economy[6]],
  balanced: [legacyPresetEfforts.balanced[0], legacyPresetEfforts.balanced[1], legacyPresetEfforts.balanced[4], legacyPresetEfforts.balanced[6]],
  maximum: [legacyPresetEfforts.maximum[0], legacyPresetEfforts.maximum[1], legacyPresetEfforts.maximum[4], legacyPresetEfforts.maximum[6]],
} as const;
