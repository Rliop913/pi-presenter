import { z } from 'zod';
import { directorSchema, argumentSchema, storyboardSchema, designSchema, deckSchema, type Contract, type Evidence, type Source } from './schema.js';
import { refs, validateStoryboard, validateDeck } from './evidence.js';

/** One planner invocation replaces refinement, argument and storyboard invocations. */
export const planningBundleSchema = z.object({
  direction: directorSchema,
  argument: argumentSchema,
  board: storyboardSchema,
}).strict();
export type PlanningBundle = z.infer<typeof planningBundleSchema>;

/** One builder invocation replaces design-system and visual-spec invocations. */
export const buildingBundleSchema = z.object({ design: designSchema, deck: deckSchema }).strict();
export type BuildingBundle = z.infer<typeof buildingBundleSchema>;

export function validatePlanningBundle(bundle: PlanningBundle, evidence: Evidence, contract: Contract): void {
  bundle.argument.sections.forEach(section => refs(section.claimIds, evidence));
  validateStoryboard(bundle.board, evidence, contract);
}
export function validateBuildingBundle(bundle: BuildingBundle, evidence: Evidence, board: z.infer<typeof storyboardSchema>, sources: Source[]): void {
  validateDeck(bundle.deck, evidence, board, sources);
}
