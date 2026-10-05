import { getSupportedThinkingLevels, type Api, type Model, type Context, type ModelsSimpleStreamOptions, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { agentsSchema, roles, type Agents, type Assignment, type Role } from './schema.js';

export interface Registry {
  getAvailable(): Model<Api>[];
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
}
export function resolveAssignment(registry: Registry, role: Role, assignment: Assignment): Model<Api> {
  const model = registry.getAvailable().find(m => m.provider === assignment.provider && m.id === assignment.id);
  if (!model) throw new Error(`Unavailable assignment for ${role}: ${assignment.provider}/${assignment.id}. Choose an exact available replacement.`);
  if (role === 'visual_reviewer' && !model.input.includes('image')) throw new Error('Visual reviewer requires image input capability');
  if (!getSupportedThinkingLevels(model).includes(assignment.effort)) throw new Error(`Unsupported effort ${assignment.effort} for ${model.provider}/${model.id}; choose explicitly, no clamping`);
  return model;
}
export function validateAgents(registry: Registry, value: unknown): Agents {
  const agents = agentsSchema.parse(value);
  for (const role of roles) resolveAssignment(registry, role, agents[role]);
  return agents;
}
export function capabilities(registry: Registry, agents: Agents) {
  return roles.map(role => {
    const m = resolveAssignment(registry, role, agents[role]);
    return { role, provider: m.provider, id: m.id, api: m.api, baseUrl: m.baseUrl, input: m.input, reasoning: m.reasoning, effortMap: m.thinkingLevelMap, efforts: getSupportedThinkingLevels(m), contextWindow: m.contextWindow, maxTokens: m.maxTokens };
  });
}
// Suggestions are names only, never executable assignments or provider guesses.
export const presets = {
  economy: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-terra'],
  balanced: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-sol'],
  maximum: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-astra'],
} as const;
export const presetEfforts = {
  economy: ['medium', 'low', 'medium', 'medium', 'medium', 'medium', 'medium'],
  balanced: ['high', 'medium', 'high', 'high', 'medium', 'high', 'high'],
  maximum: ['high', 'high', 'high', 'high', 'high', 'high', 'high'],
} as const;
