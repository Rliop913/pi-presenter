// Native user/configuration and historical receipt metadata only.
// NOT a schema for analysis, planning, design, review or any model response.
import { z } from "zod";

export const roles = [
  "director",
  "evidence_researcher",
  "narrative_architect",
  "art_director",
  "visual_designer",
  "fact_reviewer",
  "visual_reviewer",
] as const;
export type Role = (typeof roles)[number];

// User-facing assignment units; roles remain internal task/trace specialties.
export const units = ["planner", "researcher", "builder", "reviewer"] as const;
export type Unit = (typeof units)[number];
export const effort = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const text = z.string().trim().min(1).max(180);
const long = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sourceText = z.string().trim().min(1).max(300000);
export const contractSchema = z
  .object({
    // The user's freeform description captured by the wizard. This is
    // the primary input; all structured fields below are defaults that
    // the director model can refine after approval.
    description: z.string().trim().max(300000).default(""),
    title: z.string().trim().min(1).max(180).default("Untitled Presentation"),
    purpose: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .default("As described in the presentation brief"),
    audience: z.string().trim().min(1).max(180).default("General audience"),
    durationMinutes: z.number().int().min(1).max(180).default(10),
    slideCount: z.number().int().min(1).max(30).default(5),
    sources: z.array(z.string().trim().min(1).max(300000)).max(20).default([]),
    output: z.string().min(1).max(512).default("presentation.pptx"),
    requirements: z.string().trim().min(1).max(2000).default("As described"),
    // Explicit network opt-in; absent on older/local-only contracts.
    designReferenceSites: z
      .array(
        z.enum([
          "pptnest",
          "beautifuldecks",
          "slideswiki",
          "behance",
          "dribbble",
          "slideshare",
        ]),
      )
      .max(6)
      .refine(
        (sites) => new Set(sites).size === sites.length,
        "Duplicate design reference sites",
      )
      .optional(),
    maxRevisions: z.number().int().min(0).max(3).default(2),
  })
  .strict();
export type Contract = z.infer<typeof contractSchema>;
export const assignmentSchema = z
  .object({ provider: text, id: z.string().min(1).max(256), effort })
  .strict();
export type Assignment = z.infer<typeof assignmentSchema>;
export const legacyAgentsSchema = z
  .object(
    Object.fromEntries(roles.map((r) => [r, assignmentSchema])) as Record<
      Role,
      typeof assignmentSchema
    >,
  )
  .strict();
export type LegacyAgents = z.infer<typeof legacyAgentsSchema>;
export const compactAgentsSchema = z
  .object(
    Object.fromEntries(units.map((unit) => [unit, assignmentSchema])) as Record<
      Unit,
      typeof assignmentSchema
    >,
  )
  .strict();
export type CompactAgents = z.infer<typeof compactAgentsSchema>;
export const agentsSchema = z.union([compactAgentsSchema, legacyAgentsSchema]);
export type Agents = CompactAgents | LegacyAgents;

export function isCompactAgents(agents: Agents): agents is CompactAgents {
  return "planner" in agents;
}

const roleUnits: Record<Role, Unit> = {
  director: "planner",
  narrative_architect: "planner",
  evidence_researcher: "researcher",
  art_director: "builder",
  visual_designer: "builder",
  fact_reviewer: "reviewer",
  visual_reviewer: "reviewer",
};
export function unitForRole(role: Role): Unit {
  return roleUnits[role];
}
export function assignmentForRole(agents: Agents, role: Role): Assignment {
  return isCompactAgents(agents) ? agents[unitForRole(role)] : agents[role];
}
export function assignmentRoles(agents: Agents): (Role | Unit)[] {
  return isCompactAgents(agents) ? [...units] : [...roles];
}

// Read-only compatibility for a prior engine's pending revision receipt.
const revisionSchema = z.object({ affectedSlideIds: z.array(id).min(1).max(30), instructions: long }).strip();
export const states = [
  "UNINITIALIZED",
  "PRESENTATION_DEFINED",
  "AGENTS_CONFIGURED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "RESEARCH",
  "STORYBOARD",
  "DESIGN",
  "BUILD",
  "QA",
  "COMPLETE",
] as const;
export type State = (typeof states)[number];
export const checkpointSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(states),
    approval: z
      .object({ fingerprint: sha, at: z.string(), matrix: agentsSchema })
      .strict()
      .optional(),
    artifacts: z.record(z.string(), sha),
    revision: z.number().int().min(0).max(3),
    pendingRevision: revisionSchema.optional(),
    narrativeRevision: z.number().int().min(0).max(2).optional(),
    narrativeFeedback: z.string().max(2000).optional(),
    error: z.string().optional(),
    trace: z
      .array(
        z
          .object({
            role: z.enum(roles),
            unit: z.enum(units).optional(),
            provider: z.string(),
            model: z.string(),
            effort,
            reportedEffort: effort.optional(),
            providerEffort: z.string().optional(),
            task: z.string(),
            at: z.string(),
            timeoutMs: z.number().int().min(1).max(600000).optional(),
            durationMs: z.number().int().nonnegative().optional(),
            maxOutputTokens: z.number().int().min(1).max(32000).optional(),
            attempt: z.number().int().min(1).max(3).optional(),
            failureKind: z.enum(['timeout', 'transient', 'invalid_output', 'terminal']).optional(),
            usage: z.unknown().optional(),
            outcome: z.string(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
