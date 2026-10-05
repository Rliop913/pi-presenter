import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, boundedRead, digest } from './storage.js';
import { runCommand, type CommandRunner } from './process.js';
import { imageMime } from './evidence.js';

export const renderSchema = z.object({ pptxHash: z.string(), pages: z.array(z.object({ path: z.string(), hash: z.string(), slideId: z.string() }).strict()).min(1).max(30) }).strict();
export type RenderManifest = z.infer<typeof renderSchema>;
export async function validateRenders(store: Store, slides: { id: string }[]): Promise<RenderManifest> {
  const manifest = await store.read('renders/manifest.json', renderSchema);
  if (!store.checkpoint.artifacts['renders/presentation.pdf'] || !store.checkpoint.artifacts['renders/manifest.json']) throw new Error('Uncheckpointed render manifest/PDF');
  if (manifest.pptxHash !== digest(await boundedRead(await store.file('output/presentation.pptx'), 64 * 1024 * 1024)) || manifest.pages.length !== slides.length) throw new Error('Stale render manifest');
  const names = (await fs.readdir(await store.file('renders'))).filter(n => n.endsWith('.png'));
  if (names.length !== slides.length) throw new Error('Render page count mismatch/stale images');
  for (const [i, page] of manifest.pages.entries()) {
    if (page.slideId !== slides[i].id || !/^renders\/slide-\d+\.png$/.test(page.path) || Number(page.path.match(/\d+/)![0]) !== i + 1) throw new Error('Render order/path mismatch');
    if (store.checkpoint.artifacts[page.path] !== page.hash) throw new Error('Uncheckpointed render PNG');
    const bytes = await boundedRead(await store.file(page.path), 3 * 1024 * 1024);
    if (digest(bytes) !== page.hash || imageMime(bytes) !== 'image/png') throw new Error('Invalid rendered PNG');
    if (bytes.length < 24 || bytes.readUInt32BE(16) < 100 || bytes.readUInt32BE(20) < 100) throw new Error('Invalid render dimensions');
  }
  return manifest;
}
export async function render(store: Store, slides: { id: string }[], signal?: AbortSignal, runner: CommandRunner = runCommand): Promise<RenderManifest> {
  await store.gate(); signal?.throwIfAborted();
  if (!store.checkpoint.artifacts['output/presentation.pptx']) throw new Error('No current compiled PPTX');
  await store.forget(['renders/']);
  const dir = await store.file('renders');
  await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
  const profile = await store.file('lo-profile');
  await fs.rm(profile, { recursive: true, force: true });
  try {
    await runner('soffice', [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, await store.file('output/presentation.pptx')], signal);
    const pdf = await boundedRead(await store.file('renders/presentation.pdf'), 64 * 1024 * 1024);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('LibreOffice did not produce a PDF');
    await runner('pdftoppm', ['-png', '-r', '90', await store.file('renders/presentation.pdf'), await store.file('renders/slide')], signal);
    const names = (await fs.readdir(dir)).filter(n => /^slide-\d+\.png$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    if (names.length !== slides.length || names.some((n, i) => Number(n.match(/\d+/)![0]) !== i + 1)) throw new Error(`Actual rendering page count mismatch: expected ${slides.length}, got ${names.length}`);
    const manifest: RenderManifest = { pptxHash: digest(await boundedRead(await store.file('output/presentation.pptx'), 64 * 1024 * 1024)), pages: [] };
    for (const [i, name] of names.entries()) {
      const relative = `renders/${name}`; const data = await boundedRead(await store.file(relative), 3 * 1024 * 1024);
      imageMime(data); manifest.pages.push({ path: relative, hash: digest(data), slideId: slides[i].id });
      await store.track(relative);
    }
    await store.track('renders/presentation.pdf'); await store.artifact('renders/manifest.json', manifest);
    await validateRenders(store, slides); await store.gate(); signal?.throwIfAborted();
    return manifest;
  } catch (e) {
    await store.forget(['renders/']); await fs.rm(dir, { recursive: true, force: true });
    throw new Error(`Real slide rendering failed. Install LibreOffice (soffice) and Poppler (pdftoppm) on PATH; no synthetic renders are accepted. ${String(e)}`, { cause: e });
  } finally { await fs.rm(profile, { recursive: true, force: true }); }
}
