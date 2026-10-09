// Leaf file operations. No model calls, language-output parsing, QA scoring or stage controller.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { z } from 'zod';
import { Store, atomicWrite, boundedRead, digest, safePath } from './storage.js';
import { assignmentForRole } from './authority-schema.js';
import { resolveRenderTools } from './dependencies.js';
import { runCommand } from './process.js';
import type { DialogUI } from './wizard.js';
import { collectDesignReferences } from './design-references.js';

export interface FileRequest {
  action: string; artifact?: string; workspace?: string;
  kind?: 'fact' | 'visual'; page?: number; jobId?: string;
  provider?: string; model?: string; effort?: string;
}
const pageSchema = z.object({ artifact: z.string(), hash: z.string(), page: z.number().int() });
const manifestSchema = z.object({ draft: z.string(), pptxHash: z.string(), pdf: z.string(), pdfHash: z.string(), pages: z.array(pageSchema) });
const recordSchema = z.object({ kind: z.enum(['fact', 'visual']), page: z.number().int().optional(), artifact: z.string(), hash: z.string(), jobId: z.string(), provider: z.string(), model: z.string(), effort: z.string(), binding: z.string() });
const recordsSchema = z.array(recordSchema);
const manifestFile = 'skill/render-manifest.json';
const reviewsFile = 'skill/review-records.json';
const authorityFile = 'skill/authority.json';
const authoritySchema = z.object({ version: z.literal(1), mode: z.literal('skill-agent'), fingerprint: z.string(), approvedAt: z.string() });
export async function skillAuthority(store: Store): Promise<void> {
  await store.gate();
  if (!store.checkpoint.artifacts[authorityFile]) throw new Error('Native Approve & Start required for skill-agent execution mode; legacy approval cannot authorize tool-capable agents');
  const receipt = await store.read(authorityFile, authoritySchema);
  if (receipt.fingerprint !== store.checkpoint.approval?.fingerprint || receipt.approvedAt !== store.checkpoint.approval?.at) throw new Error('Skill authority does not match current native approval');
}
const relative = (artifact?: string) => {
  if (!artifact || path.isAbsolute(artifact) || artifact.split(/[\\/]/).some(part => part === '..') || artifact.includes('\0')) throw new Error('Expected an artifact path relative to .presentation/skill/');
  const normalized = path.posix.normalize(artifact.replaceAll('\\', '/'));
  if (['authority.json', 'render-manifest.json', 'review-records.json', 'export-receipt.json'].includes(normalized)) throw new Error('Reserved mechanical receipt path');
  return `skill/${normalized}`;
};
async function currentRenders(store: Store) {
  const manifest = await store.read(manifestFile, manifestSchema);
  if (!store.checkpoint.artifacts[manifestFile]) throw new Error('Unregistered render manifest');
  for (const [artifact, hash] of [[manifest.draft, manifest.pptxHash], [manifest.pdf, manifest.pdfHash], ...manifest.pages.map(page => [page.artifact, page.hash])]) {
    if (!artifact.startsWith('skill/') || store.checkpoint.artifacts[artifact] !== hash || digest(await boundedRead(await store.file(artifact), 64 * 1024 * 1024)) !== hash) throw new Error('Render files changed; render and review the current draft again');
  }
  return manifest;
}

export async function presentationFiles(store: Store, request: FileRequest, ui?: DialogUI, signal?: AbortSignal): Promise<unknown> {
  await skillAuthority(store); signal?.throwIfAborted();
  const { contract, agents } = await store.inputs();
  if (request.action === 'authorize') return {
    authority: store.checkpoint.approval, contract, agents,
    owner: 'skill-agent', artifacts: Object.keys(store.checkpoint.artifacts).filter(file => file.startsWith('skill/')),
    warning: 'Authority receipt only. No model work/semantic QA is performed or certified by this helper. Legacy pipeline artifacts are historical only.',
  };
  if (request.action === 'references') return collectDesignReferences(store, contract.designReferenceSites ?? [], signal);
  if (request.action === 'register') {
    const artifact = relative(request.artifact);
    await boundedRead(await store.file(artifact), 64 * 1024 * 1024);
    await store.track(artifact);
    return { artifact, hash: store.checkpoint.artifacts[artifact] };
  }
  if (request.action === 'render') {
    const draft = relative(request.artifact);
    if (!draft.endsWith('.pptx') || !store.checkpoint.artifacts[draft]) throw new Error('Register the actual PPTX before rendering');
    const bytes = await boundedRead(await store.file(draft), 64 * 1024 * 1024);
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (!zip.files['ppt/presentation.xml'] || slides.length !== contract.slideCount) throw new Error('Actual PPTX slide count differs from native-approved scope');
    const tools = await resolveRenderTools(signal);
    const folder = `skill/renders/${randomUUID()}`;
    const directory = await store.file(folder); await fs.mkdir(directory, { recursive: true });
    const profile = await store.file(`skill/profiles/${randomUUID()}`);
    try {
      await runCommand(tools.soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, await store.file(draft)], signal);
      const pdf = `${folder}/${path.basename(draft, '.pptx')}.pdf`;
      const pdfBytes = await boundedRead(await store.file(pdf), 64 * 1024 * 1024);
      if (!pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('No real LibreOffice PDF');
      await runCommand(tools.pdftoppm, ['-png', '-r', '90', await store.file(pdf), `${directory}/slide`], signal);
      const names = (await fs.readdir(directory)).filter(name => /^slide-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
      if (names.length !== slides.length || names.some((name, i) => Number(name.match(/\d+/)![0]) !== i + 1)) throw new Error('Real renderer page count/order differs from approved slide count');
      const pages = [];
      for (const [i, name] of names.entries()) {
        const artifact = `${folder}/${name}`; const image = await boundedRead(await store.file(artifact), 4 * 1024 * 1024);
        if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || image.readUInt32BE(16) < 100 || image.readUInt32BE(20) < 100) throw new Error('Invalid actual PNG file');
        await store.track(artifact); pages.push({ artifact, hash: digest(image), page: i + 1 });
      }
      await store.track(pdf);
      await store.forget([manifestFile, reviewsFile, 'skill/export-receipt.json']);
      const manifest = { draft, pptxHash: digest(bytes), pdf, pdfHash: digest(pdfBytes), pages };
      await store.artifact(manifestFile, manifest);
      await store.gate(); signal?.throwIfAborted(); return manifest;
    } finally { await fs.rm(profile, { recursive: true, force: true }); }
  }
  if (request.action === 'record-review') {
    const manifest = await currentRenders(store);
    const reviewer = assignmentForRole(agents, request.kind === 'visual' ? 'visual_reviewer' : 'fact_reviewer');
    if (!request.kind || !request.jobId || request.provider !== reviewer.provider || request.model !== reviewer.id || request.effort !== reviewer.effort) throw new Error('Supply the actual independent reviewer job ID and exact approved reviewer identity/effort');
    if (request.kind === 'visual' && !manifest.pages.some(page => page.page === request.page)) throw new Error('Visual review must refer to an actual rendered page');
    const artifact = relative(request.artifact);
    if (!/\.(md|txt)$/.test(artifact) || !store.checkpoint.artifacts[artifact]) throw new Error('Register the untouched raw review report first');
    const report = await boundedRead(await store.file(artifact));
    if (!report.length) throw new Error('Missing raw review report');
    const binding = store.checkpoint.artifacts[manifestFile];
    const records = store.checkpoint.artifacts[reviewsFile] ? await store.read(reviewsFile, recordsSchema) : [];
    // These are software provenance receipts, not parsed review verdicts or normalized model output.
    records.push({ kind: request.kind, page: request.kind === 'visual' ? request.page : undefined, artifact, hash: digest(report), jobId: request.jobId, provider: reviewer.provider, model: reviewer.id, effort: reviewer.effort, binding });
    await store.forget([reviewsFile, 'skill/export-receipt.json']); await store.artifact(reviewsFile, records);
    return { recorded: artifact, warning: 'Report text is untouched; the orchestrating agent must read and interpret it. A recorded report is NOT a QA pass. Job metadata is an agent assertion, not cryptographic proof of the subagent runtime.' };
  }
  if (request.action === 'export') {
    const manifest = await currentRenders(store);
    if (!store.checkpoint.artifacts[reviewsFile]) throw new Error('Missing current independent raw review reports');
    const records = (await store.read(reviewsFile, recordsSchema)).filter(record => record.binding === store.checkpoint.artifacts[manifestFile]);
    if (!records.some(record => record.kind === 'fact') || manifest.pages.some(page => !records.some(record => record.kind === 'visual' && record.page === page.page))) throw new Error('Missing factual or per-page independent review for the current render');
    for (const record of records) if (store.checkpoint.artifacts[record.artifact] !== record.hash) throw new Error('Raw review report changed');
    if (!ui) throw new Error('Native export confirmation required after agent-interpreted QA');
    const reportPaths = records.map(record => `.presentation/${record.artifact}`).join('\n');
    const selected = await ui.select(`Export ${contract.output}?\nThe skill agent must have read these raw reports and resolved all blocking findings under approved QA requirements:\n${reportPaths}\nSoftware checks file/provenance bindings, NOT the truth or verdict of review prose. Confirm only after the agent explains QA results.`, ['Approve export', 'Cancel']);
    if (selected !== 'Approve export') return { exported: false };
    await store.gate(); signal?.throwIfAborted();
    const destination = await safePath(store.cwd, contract.output);
    const bytes = await boundedRead(await store.file(manifest.draft), 64 * 1024 * 1024);
    await atomicWrite(destination, bytes);
    await store.forget(['skill/export-receipt.json']);
    await store.artifact('skill/export-receipt.json', { destination: contract.output, pptxHash: digest(bytes), renderBinding: store.checkpoint.artifacts[manifestFile], approval: store.checkpoint.approval?.fingerprint, confirmedAt: new Date().toISOString() });
    return { exported: true, destination };
  }
  throw new Error('Unknown mechanical file action');
}
