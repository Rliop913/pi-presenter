// Thin native authority adapter. This module never calls a model or runs a workflow.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { Store, safePath } from './storage.js';
import { contractSchema } from './authority-schema.js';
import { contractWizard, agentsWizard, approvalDialog, type DialogUI } from './wizard.js';
import type { Registry } from './models.js';
import { ensureDependencies } from './dependencies.js';
import { presentationFiles } from './file-tools.js';

export interface CommandContext {
  cwd: string;
  modelRegistry: Registry;
  hasUI: boolean;
  ui: DialogUI;
  signal?: AbortSignal;
  handoff?: (instructions: string) => void;
}
// Authority needs catalog inspection only. Deliberately make streaming unavailable.
function authorityRegistry(registry: Pick<Registry, 'getAvailable'>): Registry {
  return { getAvailable: () => registry.getAvailable(), streamSimple: () => { throw new Error('Authority adapter cannot call a model'); } };
}
const active = new Map<string, AbortController>();
const skillPath = fileURLToPath(new URL('../skills/presenter/SKILL.md', import.meta.url));
export function skillInstructions(action: string, workspace: string): string {
  return `Read ${skillPath} completely and follow it as the orchestrating agent. Requested action: ${action}. Workspace: ${workspace}. Use presenter_files authorize before any presentation work. YOU choose tasks, delegate to actual isolated agents with exact approved identities/effort, read their untouched prose and actual slide images, interpret QA and decide revisions. Do not use the retired Pipeline, Dispatcher, compact/natural-flow engines or old live harness. Historical QA/checkpoints are not skill-run acceptance. No schema or JSON is required from analysts/reviewers. Do not start a workflow-tool script unless the user explicitly requests it.`;
}
export async function presenterCommand(args: string, ctx: CommandContext): Promise<void> {
  const action = args.trim() || 'status';
  if (action === 'cancel') {
    active.get(ctx.cwd)?.abort(new Error('Presenter cancelled by user'));
    ctx.ui.notify('Cancellation requested. The orchestrating agent must cancel its active child jobs.', 'info');
    ctx.handoff?.(`User cancelled presenter work in ${ctx.cwd}. Stop work and cancel owned child jobs; do not generate, render or export.`);
    return;
  }
  if (!['new', 'configure', 'approve', 'status', 'dependencies', 'run', 'resume', 'review', 'export'].includes(action)) {
    throw new Error('Usage: /presenter new|configure|approve|status|dependencies|run|resume|review|export|cancel');
  }
  const store = new Store(ctx.cwd, ctx.modelRegistry);
  let handoff = false;
  await store.exclusive(async () => {
    const controller = new AbortController(); active.set(ctx.cwd, controller);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    const ui: DialogUI = {
      input: (title, placeholder) => ctx.ui.input(title, placeholder, { signal }),
      select: (title, options) => ctx.ui.select(title, options, { signal }),
      notify: (message, type) => ctx.ui.notify(message, type),
    };
    try {
      if (action === 'dependencies') {
        if (!ctx.hasUI) throw new Error('Native UI required for dependency installation approval');
        await ensureDependencies(ui, signal); return;
      }
      if (action === 'status') {
        ctx.ui.notify(`Presenter authority: ${store.checkpoint.approval ? 'approval recorded (authorize checks freshness)' : 'not approved'}. Historical engine state: ${store.checkpoint.state}. Production orchestration belongs to the skill agent, not this command.`, 'info');
        return;
      }
      if (action === 'new' || action === 'configure') {
        if (!ctx.hasUI) throw new Error('Native dialog-capable UI is required for setup and approval');
        if (action === 'new') {
          const contract = await contractWizard(ui); if (!contract) return;
          signal.throwIfAborted(); await store.define(contract);
        } else {
          if (store.checkpoint.state === 'UNINITIALIZED') throw new Error('Use /presenter new first');
          delete store.checkpoint.approval;
          store.checkpoint.artifacts = {}; store.checkpoint.revision = 0; delete store.checkpoint.pendingRevision;
          await store.move('PRESENTATION_DEFINED');
          const selection = await ui.select('Configure presentation', ['Agents only', 'Contract & agents', 'Cancel']);
          if (!selection || selection === 'Cancel') return;
          if (selection === 'Contract & agents') {
            const prior = await store.read('config/presentation.yaml', contractSchema);
            const contract = await contractWizard(ui, prior); if (!contract) return;
            signal.throwIfAborted(); await store.define(contract);
          }
        }
        const agents = await agentsWizard(ui, store); if (!agents) return;
        signal.throwIfAborted(); await store.configure(agents);
        ctx.ui.notify('Pending inputs saved. Align authority metadata with the user brief before approval, then use /presenter approve. No presentation work has started.', 'info');
        return;
      }
      // Tool-capable agents are a new authority boundary, not an implicit legacy migration.
      if (store.checkpoint.approval && !store.checkpoint.artifacts['skill/authority.json']) {
        if (!ctx.hasUI) throw new Error('Native Approve & Start required for skill-agent execution mode');
        delete store.checkpoint.approval; store.checkpoint.state = 'AWAITING_APPROVAL'; await store.save();
      }
      if (store.checkpoint.state === 'AWAITING_APPROVAL') {
        if (!ctx.hasUI) throw new Error('Explicit native UI matrix approval required');
        const modeUI: DialogUI = { ...ui, select: (title, options) => ui.select(`Execution mode: skill-owned, tool-capable isolated agents under host permissions. The agent delegates and interprets natural-language QA; no code-driven model pipeline. Builder may author and execute PPTX-generation JavaScript. No new sources, assets, installation or model substitution is authorized. Final export requires your separate confirmation.\n\n${title}`, options) };
        if (!(await approvalDialog(modeUI, store))) return;
        await store.artifact('skill/authority.json', { version: 1, mode: 'skill-agent', fingerprint: store.checkpoint.approval!.fingerprint, approvedAt: store.checkpoint.approval!.at });
      }
      await store.gate(); signal.throwIfAborted(); handoff = true;
    } finally { active.delete(ctx.cwd); }
  });
  // Release the authority lock BEFORE the agent starts work. There is no call chain here.
  if (handoff) {
    const instructions = skillInstructions(action, ctx.cwd);
    if (ctx.handoff) ctx.handoff(instructions);
    else ctx.ui.notify(instructions, 'info');
  }
}

export default function presenter(pi: ExtensionAPI) {
  pi.registerCommand('presenter', {
    description: 'Native approval and skill-agent handoff; no automatic model pipeline',
    handler: async (args, ctx) => {
      try {
        await presenterCommand(args, { ...ctx, modelRegistry: authorityRegistry(ctx.modelRegistry),
          handoff: instructions => { pi.sendMessage({ customType: 'presenter-skill', content: instructions, display: true }, { triggerTurn: true }); },
        });
      } catch (error) { ctx.ui.notify(String(error), 'error'); }
    },
  });
  registerPresenterTools(pi);
}

// Local integration can supply its own namespace without colliding with an installed package.
// These are native/file helpers only; registering them starts no agent work.
export function registerPresenterTools(pi: ExtensionAPI, namespace = 'presenter') {
  pi.registerTool({
    name: `${namespace}_authority`, label: 'Presenter native approval',
    description: 'Prepare pending native configuration, approve exact scope/assignments, or inspect authority. No model calls. new/configure stop BEFORE approval so user-intent metadata can be aligned first. Approval is a real native dialog, never a tool argument.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('new'), Type.Literal('configure'), Type.Literal('approve'), Type.Literal('status'), Type.Literal('dependencies'), Type.Literal('cancel')]), workspace: Type.Optional(Type.String()) }),
    async execute(_id, args, signal, _update, ctx) {
      const cwd = args.workspace ? await safePath(ctx.cwd, args.workspace) : ctx.cwd;
      let instructions: string | undefined;
      await presenterCommand(args.action, { cwd, modelRegistry: authorityRegistry(ctx.modelRegistry), hasUI: ctx.hasUI, ui: ctx.ui, signal, handoff: text => { instructions = text; } });
      return { content: [{ type: 'text', text: instructions ?? 'Native authority operation finished. No model work was started; inspect pending configuration or authorize before proceeding.' }], details: { instructions } };
    },
  });
  pi.registerTool({
    name: `${namespace}_files`, label: 'Presenter authority / files',
    description: 'Mechanical helpers only: authorize exact approved scope, register existing files, render real PPTX, bind raw independent review reports, and native-confirmed export. Does not call models, parse review prose, score it, choose stages or retry agents.',
    parameters: Type.Object({
      action: Type.Union(['authorize', 'register', 'render', 'references', 'record-review', 'export'].map(value => Type.Literal(value))),
      workspace: Type.Optional(Type.String({ description: 'Project-relative workspace; omit for current directory' })),
      artifact: Type.Optional(Type.String({ description: 'Path relative to .presentation/skill/' })),
      kind: Type.Optional(Type.Union([Type.Literal('fact'), Type.Literal('visual')])),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      jobId: Type.Optional(Type.String()), provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal, _update, ctx) {
      const cwd = args.workspace ? await safePath(ctx.cwd, args.workspace) : ctx.cwd;
      const store = new Store(cwd, authorityRegistry(ctx.modelRegistry));
      const result = await store.exclusive(() => presentationFiles(store, args, ctx.hasUI ? ctx.ui : undefined, signal));
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], details: result };
    },
  });
  pi.on('session_shutdown', () => { for (const controller of active.values()) controller.abort(new Error('Pi session shutdown')); });
}
