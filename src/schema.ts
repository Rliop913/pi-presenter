import { z } from 'zod';

export const roles = ['director', 'evidence_researcher', 'narrative_architect', 'art_director', 'visual_designer', 'fact_reviewer', 'visual_reviewer'] as const;
export type Role = typeof roles[number];
export const effort = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const text = z.string().trim().min(1).max(180);
const long = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sourceText = z.string().trim().min(1).max(300000);
export const contractSchema = z.object({
  title: text, purpose: long, audience: text, durationMinutes: z.number().int().min(1).max(180),
  slideCount: z.number().int().min(1).max(30), sources: z.array(sourceText).min(1).max(20),
  output: z.string().min(1).max(512), requirements: long,
  maxRevisions: z.number().int().min(0).max(3).default(2),
}).strict();
export type Contract = z.infer<typeof contractSchema>;
export const assignmentSchema = z.object({ provider: text, id: z.string().min(1).max(256), effort }).strict();
export type Assignment = z.infer<typeof assignmentSchema>;
export const agentsSchema = z.object(Object.fromEntries(roles.map(r => [r, assignmentSchema])) as Record<Role, typeof assignmentSchema>).strict();
export type Agents = z.infer<typeof agentsSchema>;
export const sourceSchema = z.object({ id, text: sourceText, hash: sha }).strict();
export type Source = z.infer<typeof sourceSchema>;
export const sourcesSchema = z.array(sourceSchema).min(1).max(20);
const citation = z.object({ sourceId: id, quote: z.string().trim().min(1).max(2000) }).strict();
export const claimSchema = z.object({ id, text: z.string().trim().min(1).max(240), citations: z.array(citation).min(1).max(5) }).strict();
export const figureSchema = z.object({ id, title: text, sourceId: id, quote: long, labels: z.array(z.string().min(1).max(35)).min(1).max(8), values: z.array(z.number().finite()).min(1).max(8), unit: z.string().max(30) }).strict();
// Both fields default to `[]` so a model that omits them (e.g. due to
// truncation) gets a clear downstream error instead of a cryptic Zod
// "expected array, received undefined" parse failure. A parent-level
// `.refine()` enforces the "at least one claim" contract because Zod's
// `.default()` bypasses subsequent per-field validators on the default
// value itself.
export const evidenceSchema = z.object({ claims: z.array(claimSchema).max(150).default([]), figures: z.array(figureSchema).max(20).default([]) }).strict().refine((d) => d.claims.length >= 1, { message: 'evidence_researcher returned an empty claims database. The source text may be too short, not contain factual claims, or the model failed to extract them. Provide a longer or more factual source, or retry with a different model.', path: ['claims'] });
export type Evidence = z.infer<typeof evidenceSchema>;
export const directorSchema = z.object({ objective: long, thesis: long, successCriteria: z.array(text).min(1).max(6) }).strict();
export const argumentSchema = z.object({ thesis: long, sections: z.array(z.object({ title: text, claimIds: z.array(id).min(1).max(10), rationale: long }).strict()).min(1).max(30) }).strict();
export const acceptanceSchema = z.object({ accepted: z.boolean(), narrative: z.number().min(0).max(10), rationale: long }).strict();
export const storyboardSchema = z.object({ slides: z.array(z.object({ id, title: z.string().min(1).max(90), claimIds: z.array(id).min(1).max(6), intent: text }).strict()).min(1).max(30) }).strict();
export type Storyboard = z.infer<typeof storyboardSchema>;
export const designSchema = z.object({ font: z.enum(['Aptos', 'Arial', 'Calibri']), background: z.string().regex(/^[A-Fa-f0-9]{6}$/), foreground: z.string().regex(/^[A-Fa-f0-9]{6}$/), accent: z.string().regex(/^[A-Fa-f0-9]{6}$/), titleSize: z.number().min(28).max(36), bodySize: z.number().min(18).max(24) }).strict();
export type Design = z.infer<typeof designSchema>;
export const slideSchema = z.object({ id, title: z.string().min(1).max(90), layout: z.enum(['title', 'two-column', 'bullets', 'process', 'chart']), claimIds: z.array(id).min(1).max(6), figureId: id.optional() }).strict();
export const deckSchema = z.object({ slides: z.array(slideSchema).min(1).max(30) }).strict();
export type Deck = z.infer<typeof deckSchema>;
export const findingSchema = z.object({ slideId: id, severity: z.enum(['minor', 'major', 'critical']), issue: long, fix: long }).strict();
export const reviewSchema = z.object({ factual: z.number().min(0).max(10), narrative: z.number().min(0).max(10), hierarchy: z.number().min(0).max(10), consistency: z.number().min(0).max(10), readability: z.number().min(0).max(10), findings: z.array(findingSchema).max(100) }).strict();
export type Review = z.infer<typeof reviewSchema>;
export const revisionSchema = z.object({ affectedSlideIds: z.array(id).min(1).max(30), instructions: long }).strict();
export const patchSchema = z.object({ slides: z.array(slideSchema).min(1).max(30) }).strict();
export const states = ['UNINITIALIZED', 'PRESENTATION_DEFINED', 'AGENTS_CONFIGURED', 'AWAITING_APPROVAL', 'APPROVED', 'RESEARCH', 'STORYBOARD', 'DESIGN', 'BUILD', 'QA', 'COMPLETE'] as const;
export type State = typeof states[number];
export const checkpointSchema = z.object({
  version: z.literal(1), state: z.enum(states), approval: z.object({ fingerprint: sha, at: z.string(), matrix: agentsSchema }).strict().optional(),
  artifacts: z.record(z.string(), sha), revision: z.number().int().min(0).max(3),
  pendingRevision: revisionSchema.optional(), error: z.string().optional(),
  trace: z.array(z.object({ role: z.enum(roles), provider: z.string(), model: z.string(), effort, reportedEffort: effort.optional(), providerEffort: z.string().optional(), task: z.string(), at: z.string(), usage: z.unknown().optional(), outcome: z.string() }).strict()).max(200),
}).strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
export function passed(fact: Review, visual: Review): boolean {
  return fact.factual >= 9 && fact.narrative >= 8 && visual.narrative >= 8 && visual.hierarchy >= 8 && visual.consistency >= 8 && visual.readability >= 8 &&
    ![...fact.findings, ...visual.findings].some(f => f.severity !== 'minor');
}
