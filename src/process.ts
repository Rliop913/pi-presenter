import { spawn } from 'node:child_process';
export type CommandRunner = (command: string, args: string[], signal?: AbortSignal) => Promise<string>;
/** Fixed executable/argv only. No shell, with time and output bounds. */
export const runCommand: CommandRunner = (command, args, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const child = spawn(command, args, { shell: false, windowsHide: true, signal });
  let output = ''; let size = 0; let failure: Error | undefined;
  const timer = setTimeout(() => { failure = new Error(`${command} exceeded 120 second timeout`); child.kill(); }, 120000);
  const capture = (data: Buffer) => {
    size += data.length;
    if (size > 2 * 1024 * 1024) { failure = new Error(`${command} exceeded output limit`); child.kill(); }
    else output += data.toString('utf8');
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', err => { clearTimeout(timer); reject(new Error(`Required executable ${command} unavailable or failed: ${err.message}`)); });
  child.on('close', code => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else if (code !== 0) reject(new Error(`${command} failed (${code}): ${output.slice(0, 2000)}`));
    else resolve(output);
  });
});
