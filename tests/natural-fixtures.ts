// OFFLINE natural-flow fixtures. No live models or production renderer.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fixture, model, evidence, board, deck, design, usage } from './fixtures.js';
import { units, type CompactAgents } from '../src/schema.js';
import type { CompilerHandoff } from '../src/natural-flow.js';

export const rawResearch = '  Grounded research — source_1\r\nThe pilot prioritises reliability; Alpha handled one hundred requests.\nUncertainty: this does not establish production scalability.\n\n';
export const rawPlanning = '\n方向 / Direction: make the evidence understandable.\nStart with reliability, then explain the pilot and its limitations.\nTwo slides are suggested; wording need not copy source text.  \n';
export const handoff: CompilerHandoff = {
  evidence, board, design, deck,
  direction: { objective: 'Explain the pilot', thesis: 'Reliability matters', successCriteria: ['Audience understands evidence'], executionPlan: { maxOutputTokens: 4096 } },
  argument: { thesis: 'Reliability matters', sections: [{ title: 'Pilot', claimIds: ['claim_a', 'claim_b'], rationale: 'Ground the decision' }] },
};

export async function compactFixture(approved = true) {
  const f = await fixture(false);
  const agents = Object.fromEntries(units.map(unit => [unit, { provider: model.provider, id: model.id, effort: 'medium' }])) as CompactAgents;
  await f.store.configure(agents);
  if (approved) await f.store.approve(await f.store.fingerprint(), 'Approve & Start'); // Test-only explicit approval.
  f.registry.failVisual = 1;
  const notes = { research: rawResearch, planning: rawPlanning, researchCalls: 0, planningCalls: 0 };
  const structuredStream = f.registry.streamSimple.bind(f.registry);
  // MockRegistry's shared implementation JSON-serializes every value. Override only
  // text stages so these tests exercise actual, unwrapped provider text responses.
  f.registry.streamSimple = (m, context, options) => {
    const first = context.messages[0];
    const system = first.role === 'system' && typeof first.content === 'string' ? first.content : '';
    const research = system.includes('Task: Research the approved sources');
    const planning = system.includes('Task: Plan the approved presentation in natural language');
    if (!research && !planning) return structuredStream(m, context, options);
    f.registry.calls.push({ model: m, context, options });
    const stream = createAssistantMessageEventStream();
    if (f.registry.hang) return stream;
    const text = research ? notes.research : notes.planning;
    if (research) notes.researchCalls++; else notes.planningCalls++;
    stream.end({ role: 'assistant', api: m.api, provider: m.provider,
      model: f.registry.substituted ? 'fallback' : m.id,
      thinkingLevel: f.registry.clamped ? 'low' : undefined,
      content: [{ type: 'text', text: text.slice(0, 12) }, { type: 'text', text: text.slice(12) }],
      usage, stopReason: 'stop', timestamp: Date.now() });
    return stream;
  };
  f.registry.responseOverride = (system, payload) => {
    if (system.includes('Task: Build ONE structured COMPILER HANDOFF')) return structuredClone(handoff);
    return f.registry.response(system, payload);
  };
  return { ...f, notes };
}
