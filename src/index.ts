import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Store } from './storage.js';
import { Pipeline } from './pipeline.js';
import { contractSchema } from './schema.js';
import { contractWizard, agentsWizard, approvalDialog, type DialogUI } from './wizard.js';
import type { Registry } from './models.js';

export interface CommandContext { cwd: string; modelRegistry: Registry; hasUI: boolean; ui: DialogUI; signal?: AbortSignal }
const active = new Map<string, AbortController>();
export async function presenterCommand(args: string, ctx: CommandContext) {
  const action = args.trim() || 'status';
  if (action === 'cancel') { active.get(ctx.cwd)?.abort(new Error('Presenter cancelled by user')); ctx.ui.notify('Cancellation requested', 'info'); return; }
  if (!['new', 'configure', 'status', 'run', 'review', 'resume', 'export'].includes(action)) throw new Error('Usage: /presenter new|configure|status|run|review|resume|export|cancel');
  const store = new Store(ctx.cwd, ctx.modelRegistry);
  await store.exclusive(async () => {
    const controller = new AbortController(); active.set(ctx.cwd, controller);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    const pipeline = new Pipeline(store, signal);
    const ui: DialogUI = {
      input: (title, placeholder) => ctx.ui.input(title, placeholder, { signal }),
      select: (title, options) => ctx.ui.select(title, options, { signal }),
      notify: (message, type) => ctx.ui.notify(message, type),
    };
    try {
      if (action === 'status') {
        if (store.checkpoint.approval) await store.gate();
        ctx.ui.notify(`Pi Presenter: ${store.checkpoint.state}\nRevision: ${store.checkpoint.revision}\nApproval: ${store.checkpoint.approval?.fingerprint ?? 'none'}\nArtifacts: ${Object.keys(store.checkpoint.artifacts).length}\nModel calls: ${store.checkpoint.trace.length}\n${store.checkpoint.error ?? ''}`, 'info'); return;
      }
      if (['new', 'configure'].includes(action)) {
        if (!ctx.hasUI) throw new Error('Native dialog-capable UI is required for setup and approval');
        if (action === 'new') {
          const contract = await contractWizard(ui); if (!contract) return;
          signal.throwIfAborted(); await store.define(contract);
        } else {
          if (store.checkpoint.state === 'UNINITIALIZED') throw new Error('Use /presenter new first');
          // Entering configuration revokes approval even if a later dialog is cancelled.
          delete store.checkpoint.approval; store.checkpoint.artifacts = {}; store.checkpoint.revision = 0; delete store.checkpoint.pendingRevision;
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
        if (!await approvalDialog(ui, store)) return;
        signal.throwIfAborted(); await pipeline.run();
      } else if (action === 'run') {
        if (store.checkpoint.state === 'AWAITING_APPROVAL') {
          if (!ctx.hasUI) throw new Error('Explicit native UI matrix approval required');
          if (!await approvalDialog(ui, store)) return;
        }
        await pipeline.run();
      } else if (action === 'resume') await pipeline.run();
      else if (action === 'review') await pipeline.review();
      else if (action === 'export') { ctx.ui.notify(`Exported: ${await pipeline.export()}`, 'info'); return; }
      ctx.ui.notify(`Pi Presenter: ${store.checkpoint.state}. Export with /presenter export.`, 'info');
    } catch (e) {
      store.checkpoint.error = String(e).slice(0, 4000); await store.save(); throw e;
    } finally { active.delete(ctx.cwd); }
  });
}
export default function presenter(pi: ExtensionAPI) {
  pi.registerCommand('presenter', {
    description: 'Approval-gated deck production: new, configure, status, run, review, resume, export, cancel',
    handler: async (args, ctx) => {
      try { await presenterCommand(args, ctx); }
      catch (e) { ctx.ui.notify(String(e), 'error'); }
    },
  });
  pi.on('session_shutdown', () => { for (const controller of active.values()) controller.abort(new Error('Pi session shutdown')); });
}
