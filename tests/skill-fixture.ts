// Disposable OFFLINE authority fixture. Native selections are mocked for tests only.
// This is not a production approval, model response, review or certified deck.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { Store, atomicWrite, digest } from '../src/storage.js';
import { units, type CompactAgents, type Contract } from '../src/authority-schema.js';
import type { Registry } from '../src/models.js';
import { presenterCommand } from '../src/index.js';
import type { DialogUI } from '../src/wizard.js';
export const model: Model<Api> = { id: 'offline-only', provider: 'offline-fixture', name: 'OFFLINE only', api: 'openai-completions', baseUrl: 'https://invalid.local', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { xhigh: null, max: null } };
export const matrix = Object.fromEntries(units.map(unit => [unit, { provider: model.provider, id: model.id, effort: 'medium' }])) as CompactAgents;
export const contract: Contract = { description: 'OFFLINE fixture', title: 'OFFLINE fixture', purpose: 'Test mechanical boundaries', audience: 'Developers', slideCount: 2, durationMinutes: 8, sources: ['Source fixture text'], requirements: 'OFFLINE tests only', output: 'export/test.pptx', maxRevisions: 2 };
export const cancelUI: DialogUI = { input: async () => undefined, select: async () => undefined, notify: () => {} };
export async function skillFixture(approved = true) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'presenter-skill-test-'));
  let calls = 0;
  const registry: Registry = { getAvailable: () => [model], streamSimple: () => { calls++; throw new Error('No model calls in a file/authority test'); } };
  const store = new Store(cwd, registry);
  await store.define(contract); await store.configure(matrix);
  if (approved) {
    await presenterCommand('approve', { cwd, modelRegistry: registry, hasUI: true, ui: { ...cancelUI, select: async (_title, options) => options.includes('Approve & Start') ? 'Approve & Start' : undefined } });
    await store.load();
  }
  return { cwd, store, registry, calls: () => calls, cleanup: () => fs.rm(cwd, { recursive: true, force: true }) };
}
export async function mockFileBinding(store: Store, suffix = 'one') {
  // Explicit fake render bytes for binding unit tests, not a real rendering claim.
  const draft = `skill/drafts/${suffix}.pptx`, pdf = `skill/renders/${suffix}.pdf`;
  await atomicWrite(await store.file(draft), `OFFLINE-DRAFT-${suffix}`); await store.track(draft);
  await atomicWrite(await store.file(pdf), '%PDF-OFFLINE-MOCK'); await store.track(pdf);
  const pages = [];
  for (let i = 1; i <= 2; i++) {
    const artifact = `skill/renders/${suffix}-${i}.png`; const bytes = Buffer.from(`OFFLINE-IMAGE-${suffix}-${i}`);
    await atomicWrite(await store.file(artifact), bytes); await store.track(artifact);
    pages.push({ artifact, hash: digest(bytes), page: i });
  }
  await store.forget(['skill/render-manifest.json']);
  await store.artifact('skill/render-manifest.json', { draft, pptxHash: store.checkpoint.artifacts[draft], pdf, pdfHash: store.checkpoint.artifacts[pdf], pages });
}
