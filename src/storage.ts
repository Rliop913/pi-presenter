import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import type { z } from 'zod';
import { agentsSchema, checkpointSchema, contractSchema, states, type Agents, type Checkpoint, type Contract, type State } from './schema.js';
import { capabilities, validateAgents, type Registry } from './models.js';

export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
/** Check every existing component, including symlinks/junctions; never allow escapes. */
export async function safePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Expected a root-relative path');
  const base = await fs.realpath(root);
  const dest = path.resolve(base, relative);
  if (!inside(base, dest)) throw new Error(`Path escapes project root: ${relative}`);
  let cursor = dest;
  for (;;) {
    try { if (!inside(base, await fs.realpath(cursor))) throw new Error(`Symlink escapes root: ${relative}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (cursor === base) break;
    cursor = path.dirname(cursor);
  }
  return dest;
}
export async function boundedRead(file: string, max = 8 * 1024 * 1024): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error(`Not a file or exceeds ${max} bytes: ${file}`);
    const data = await handle.readFile();
    if (data.length > max) throw new Error(`File grew beyond size limit: ${file}`);
    return data;
  } finally { await handle.close(); }
}
export async function atomicWrite(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const h = await fs.open(temp, 'wx', 0o600);
  try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}
export class Store {
  checkpoint: Checkpoint = { version: 1, state: 'UNINITIALIZED', artifacts: {}, revision: 0, trace: [] };
  private locked = false;
  constructor(readonly cwd: string, readonly registry: Registry) {}
  async file(rel: string) {
    const root = await fs.realpath(this.cwd); const managed = path.join(root, '.presentation');
    if (path.isAbsolute(rel) || !inside(managed, path.resolve(managed, rel))) throw new Error('Managed artifact path escapes .presentation');
    const file = await safePath(root, `.presentation/${rel}`);
    // Managed directories are never symlinks, even when their target stays inside cwd.
    // Otherwise cleaning renders/profile could delete unrelated project files.
    let cursor = file;
    while (cursor !== root) {
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Managed presentation paths cannot contain symlinks/junctions'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      cursor = path.dirname(cursor);
    }
    return file;
  }
  async read<T>(rel: string, schema: z.ZodType<T>): Promise<T> {
    const data = (await boundedRead(await this.file(rel))).toString('utf8');
    try { return schema.parse(rel.endsWith('.json') ? JSON.parse(data) : parse(data, { maxAliasCount: 0 })); }
    catch (cause) { throw new Error(`Invalid artifact/config ${rel}`, { cause }); }
  }
  async load() {
    try { this.checkpoint = await this.read('checkpoint.json', checkpointSchema); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return this.checkpoint;
  }
  async save() { await atomicWrite(await this.file('checkpoint.json'), JSON.stringify(checkpointSchema.parse(this.checkpoint), null, 2)); }
  async move(state: State) {
    const transitions: Partial<Record<State, State[]>> = {
      AWAITING_APPROVAL: ['APPROVED'], APPROVED: ['RESEARCH'], RESEARCH: ['STORYBOARD'],
      STORYBOARD: ['DESIGN'], DESIGN: ['BUILD'], BUILD: ['QA'], QA: ['BUILD', 'COMPLETE'], COMPLETE: ['QA'],
      AGENTS_CONFIGURED: ['AWAITING_APPROVAL'],
    };
    const reset = state === 'PRESENTATION_DEFINED' || (state === 'AGENTS_CONFIGURED' && this.checkpoint.state !== 'UNINITIALIZED');
    if (state !== this.checkpoint.state && !reset && !transitions[this.checkpoint.state]?.includes(state)) throw new Error(`Invalid state transition ${this.checkpoint.state} -> ${state}`);
    this.checkpoint.state = state; delete this.checkpoint.error; await this.save();
  }
  async advance(state: State) {
    if (states.indexOf(this.checkpoint.state) < states.indexOf(state)) await this.move(state);
  }
  async inputs(): Promise<{ contract: Contract; agents: Agents }> {
    return { contract: await this.read('config/presentation.yaml', contractSchema), agents: await this.read('config/agents.yaml', agentsSchema) };
  }
  async fingerprint() {
    const { contract, agents } = await this.inputs();
    const sourceHashes = [];
    let total = 0;
    for (const source of contract.sources) {
      if (path.normalize(source).split(path.sep)[0] === '.presentation') throw new Error('Sources cannot be generated presentation artifacts');
      const data = await boundedRead(await safePath(this.cwd, source)); total += data.length;
      if (total > 24 * 1024 * 1024) throw new Error('Sources exceed total 24 MiB limit');
      sourceHashes.push({ path: source, hash: digest(data) });
    }
    const output = await safePath(this.cwd, contract.output);
    if (!output.endsWith('.pptx') || inside(path.resolve(this.cwd, '.presentation'), output)) throw new Error('Export must be a project-relative .pptx outside .presentation');
    return digest(canonical({
      presentation: digest(await boundedRead(await this.file('config/presentation.yaml'))),
      agents: digest(await boundedRead(await this.file('config/agents.yaml'))),
      sourceHashes, capabilities: capabilities(this.registry, agents),
    }));
  }
  async define(contract: Contract) {
    contractSchema.parse(contract);
    this.checkpoint = { version: 1, state: 'PRESENTATION_DEFINED', artifacts: {}, revision: 0, trace: [] };
    await this.save(); // revoke first, even if config write fails
    await atomicWrite(await this.file('config/presentation.yaml'), stringify(contract));
  }
  async configure(agents: Agents) {
    validateAgents(this.registry, agents);
    delete this.checkpoint.approval;
    this.checkpoint.artifacts = {}; this.checkpoint.revision = 0; delete this.checkpoint.pendingRevision;
    await this.move('AGENTS_CONFIGURED');
    await atomicWrite(await this.file('config/agents.yaml'), stringify(agents));
    await this.move('AWAITING_APPROVAL');
  }
  async approve(displayedFingerprint: string, action: string) {
    if (action !== 'Approve & Start' || this.checkpoint.state !== 'AWAITING_APPROVAL') throw new Error('Explicit matrix approval required');
    const current = await this.fingerprint();
    if (current !== displayedFingerprint) throw new Error('Inputs changed during approval; inspect matrix again');
    const { agents } = await this.inputs();
    this.checkpoint.approval = { fingerprint: current, matrix: agents, at: new Date().toISOString() };
    await this.move('APPROVED');
  }
  async gate() {
    if (!this.checkpoint.approval || ['UNINITIALIZED', 'PRESENTATION_DEFINED', 'AGENTS_CONFIGURED', 'AWAITING_APPROVAL'].includes(this.checkpoint.state)) throw new Error('Presentation execution requires Approve & Start');
    try {
      const current = await this.fingerprint();
      const { agents } = await this.inputs();
      if (current !== this.checkpoint.approval.fingerprint || canonical(agents) !== canonical(this.checkpoint.approval.matrix)) throw new Error('Approved fingerprint is stale');
    } catch (e) {
      delete this.checkpoint.approval; this.checkpoint.state = 'AWAITING_APPROVAL'; this.checkpoint.artifacts = {}; this.checkpoint.revision = 0; delete this.checkpoint.pendingRevision;
      this.checkpoint.error = String(e); await this.save(); throw e;
    }
    for (const [rel, hash] of Object.entries(this.checkpoint.artifacts)) {
      try {
        if (digest(await boundedRead(await this.file(rel), 64 * 1024 * 1024)) !== hash) throw new Error(`Stale/tampered artifact: ${rel}. Reconfigure to restart safely.`);
      } catch (e) {
        if (rel.startsWith('config/')) {
          delete this.checkpoint.approval; this.checkpoint.state = 'AWAITING_APPROVAL'; this.checkpoint.artifacts = {}; this.checkpoint.revision = 0; delete this.checkpoint.pendingRevision; await this.save();
        }
        throw e;
      }
    }
  }
  async artifact(rel: string, value: unknown) {
    const data = rel.endsWith('.json') ? JSON.stringify(value, null, 2) : stringify(value);
    await atomicWrite(await this.file(rel), data);
    await this.track(rel);
  }
  async track(rel: string) {
    this.checkpoint.artifacts[rel] = digest(await boundedRead(await this.file(rel), 64 * 1024 * 1024));
    await this.save();
  }
  async forget(prefixes: string[]) {
    for (const rel of Object.keys(this.checkpoint.artifacts)) if (prefixes.some(p => rel.startsWith(p))) delete this.checkpoint.artifacts[rel];
    await this.save();
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) throw new Error('Another presenter operation is active');
    this.locked = true;
    let acquired = false;
    const token = randomUUID();
    try {
      const file = await this.file('operation.lock');
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        const h = await fs.open(file, 'wx', 0o600);
        await h.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token })); await h.close(); acquired = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another presenter operation holds the disk lock. For a crashed process, verify its PID is dead before removing .presentation/operation.lock.');
        throw e;
      }
      await this.load();
      return await fn();
    } finally {
      if (acquired) await fs.rm(await this.file('operation.lock'), { force: true });
      this.locked = false;
    }
  }
}
