import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { contractSchema, units, type Contract, type CompactAgents } from "./authority-schema.js";
import { presets, presetEfforts, validateAgents } from "./models.js";
import { Store } from "./storage.js";
import { DESIGN_REFERENCE_SITES } from "./reference-sites.js";

export interface DialogUI {
  input(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  select(
    title: string,
    options: string[],
    dialogOptions?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

const DESCRIPTION_PLACEHOLDER = `Describe your presentation in natural language. Include whatever feels useful: the topic, the audience, the tone, how long it should run, any data or context the model should ground it in, and the output path.

Example:
  "15-minute Q4 review for the board. Focus on reliability improvements from the
   pilot. Alpha recorded 100 requests, Beta recorded 200. Output to q4-review.pptx.
   Match our brand colors and include a chart of pilot metrics."

You can leave the description empty if you want to start from a blank slate, or paste a long brief. After approval, the director will refine the contract and the evidence researcher will extract grounded claims from anything you include here.`;

const SOURCES_PLACEHOLDER = `Optional: paste any source content the presentation should be grounded in. This is a single block of text; if you have multiple sources, separate them with "---" on its own line. Leave empty to use just the description above.`;

/**
 * The contract wizard is intentionally minimal: one input for the user's
 * freeform description, and one optional input for additional sources.
 * The skill drives the conversation in natural language; the schema
 * fills in sensible defaults for every structured field. After approval,
 * the director model refines the contract from the description.
 */
export async function contractWizard(
  ui: DialogUI,
  prior?: Contract,
): Promise<Contract | undefined> {
  const description = await ui.input(
    "Describe your presentation in natural language",
    DESCRIPTION_PLACEHOLDER,
  );
  if (description === undefined) return undefined;

  const sourcesRaw = await ui.input(
    "Optional source content (leave empty to skip)",
    SOURCES_PLACEHOLDER,
  );
  if (sourcesRaw === undefined) return undefined;

  const sources = sourcesRaw
    .split(/^---\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const referenceChoice = await ui.select(
    "Optional online design references (network requests only after Approve & Start)",
    [
      "Skip online references",
      "Use all six reference sites",
      "Choose reference sites",
    ],
  );
  if (referenceChoice === undefined) return undefined;
  const designReferenceSites: NonNullable<Contract["designReferenceSites"]> =
    [];
  if (referenceChoice === "Use all six reference sites") {
    designReferenceSites.push(...DESIGN_REFERENCE_SITES.map((site) => site.id));
  } else if (referenceChoice === "Choose reference sites") {
    for (const site of DESIGN_REFERENCE_SITES) {
      const choice = await ui.select(
        `Design inspiration: ${site.label}\n${site.url}`,
        ["Skip this site", "Use this site"],
      );
      if (choice === undefined) return undefined;
      if (choice === "Use this site") designReferenceSites.push(site.id);
      else if (choice !== "Skip this site")
        throw new Error("Invalid reference site selection");
    }
  } else if (referenceChoice !== "Skip online references")
    throw new Error("Invalid reference selection");
  // Parse through the schema so every field is filled in (the schema
  // provides defaults for title, purpose, audience, etc.). The user only
  // provides description + optional sources; the schema fills the rest.
  return contractSchema.parse({
    description,
    sources,
    designReferenceSites,
    maxRevisions: prior?.maxRevisions ?? 2,
  });
}

export async function agentsWizard(
  ui: DialogUI,
  store: Store,
): Promise<CompactAgents | undefined> {
  const choice = await ui.select(
    "Quality preset (suggestions only; every assignment is explicit)",
    Object.keys(presets),
  );
  if (!choice) return undefined;
  const preset = choice as keyof typeof presets;
  if (!(preset in presets)) throw new Error("Invalid preset selection");
  const agents = {} as CompactAgents;
  for (const [i, role] of units.entries()) {
    const available = store.registry
      .getAvailable()
      .filter((m) => role !== "reviewer" || m.input.includes("image"));
    if (!available.length)
      throw new Error(
        `No available ${role === "reviewer" ? "vision " : ""}models; configure Pi credentials/catalog first`,
      );
    const suggestion = presets[preset][i];
    const found = available.some((m) => m.id === suggestion);
    const options = available.map(
      (m, index) =>
        `${index + 1}. ${m.provider}/${m.id}${m.id === suggestion ? " (suggested)" : ""}`,
    );
    const selected = await ui.select(
      `${role}: suggested ${suggestion}${found ? "" : " UNAVAILABLE — choose an explicit replacement"}`,
      options,
    );
    if (selected === undefined) return undefined;
    const index = options.indexOf(selected);
    if (index < 0) throw new Error("Invalid model selection");
    const model = available[index];
    const levels = getSupportedThinkingLevels(model);
    const level = await ui.select(
      `${role}: effort (suggested ${presetEfforts[preset][i]}; only host-supported choices)`,
      levels,
    );
    if (level === undefined) return undefined;
    if (!levels.includes(level as (typeof levels)[number]))
      throw new Error("Unsupported effort choice");
    agents[role] = {
      provider: model.provider,
      id: model.id,
      effort: level as (typeof levels)[number],
    };
  }
  validateAgents(store.registry, agents);
  return agents;
}

export async function approvalDialog(
  ui: DialogUI,
  store: Store,
): Promise<boolean> {
  if (store.checkpoint.state !== "AWAITING_APPROVAL")
    throw new Error("Configure every assignment before approval");
  const { contract, agents } = await store.inputs();
  const fingerprint = await store.fingerprint();
  const matrix = Object.entries(agents)
    .map(([role, assignment]) =>
      `${role}: ${assignment.provider}/${assignment.id} | effort=${assignment.effort}`,
    )
    .join("\n");
  const descriptionBlock = contract.description
    ? `Description (your words, may be refined by the director):\n  ${contract.description.replace(/\n/g, "\n  ").slice(0, 2000)}${contract.description.length > 2000 ? "…" : ""}\n\n`
    : "";
  const sourcesPreview = contract.sources.length
    ? contract.sources
        .map(
          (s, i) =>
            `source_${i + 1} (${s.length} chars): ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""}`,
        )
        .join("\n  ")
    : "(none)";
  const referencePreview =
    DESIGN_REFERENCE_SITES.filter((site) =>
      contract.designReferenceSites?.includes(site.id),
    )
      .map((site) => `${site.label}: ${site.url}`)
      .join("\n  ") || "(disabled — no network requests)";
  const summary = `${descriptionBlock}Title: ${contract.title}\nPurpose: ${contract.purpose}\nAudience: ${contract.audience}\nDuration: ${contract.durationMinutes} minutes | Slides: ${contract.slideCount}\nSources (${contract.sources.length} freeform chunks):\n  ${sourcesPreview}\nExport: ${contract.output}\nRequirements: ${contract.requirements}\nRevision limit: ${contract.maxRevisions}\nDesign references:\n  ${referencePreview}\nSelected sites receive bounded unauthenticated page requests after approval; no brief/source text is uploaded. References are inspiration, never factual evidence. Blocked sites are reported, not bypassed.\nMissing render tools require separate installation approval after safety checks.\n\n${matrix}\n\nApproval covers only these inputs. Source text will be sent to the selected providers; no parent conversation is included.\nFingerprint: ${fingerprint}`;
  ui.notify(summary, "info");
  const selected = await ui.select(
    `Approve full presentation contract and assignment/model/effort matrix\n${summary}`,
    ["Approve & Start", "Cancel"],
  );
  if (selected !== "Approve & Start") return false;
  await store.approve(fingerprint, selected);
  return true;
}
