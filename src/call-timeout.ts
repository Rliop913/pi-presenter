import type { Assignment, Role } from './schema.js';
import type { RecoveryPolicy } from './orchestration.js';

/** Never permit an unbounded model call, even with a custom allocator. */
export const MAX_CALL_TIMEOUT_MS = 10 * 60 * 1000;
export interface CallTimeoutContext {
  readonly role: Role;
  readonly provider: string;
  readonly model: string;
  readonly effort: Assignment['effort'];
  readonly task: string;
  readonly callIndex: number;
  readonly payloadCharacters: number;
  readonly imageCount: number;
  readonly maxOutputTokens: number;
  readonly remainingRunMs?: number;
}
export type TimeoutAllocator = (context: CallTimeoutContext) => number;
export interface DispatchOptions {
  /** Synchronous per-call allocation; cannot change models, effort or approval. */
  readonly allocateTimeout?: TimeoutAllocator;
  /** Absolute epoch milliseconds. The run's AbortSignal remains authoritative too. */
  readonly deadlineAt?: number;
  readonly recovery?: RecoveryPolicy;
}
export interface CallOptions {
  /** Explicit per-call override; still subject to the hard cap and run deadline. */
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
}

/** Bounded heuristic, not a guarantee of provider latency. */
export const defaultTimeoutAllocator: TimeoutAllocator = context => {
  const roleExtra = context.role === 'evidence_researcher' || context.role === 'visual_designer' ? 120000 : 0;
  const effortExtra = context.effort === 'medium' ? 30000 : context.effort === 'high' || context.effort === 'xhigh' ? 90000 : 0;
  return Math.min(MAX_CALL_TIMEOUT_MS, 180000 + roleExtra +
    Math.floor(context.payloadCharacters / 20000) * 30000 + context.imageCount * 30000 + effortExtra);
};

export function allocateCallTimeout(context: CallTimeoutContext, options: DispatchOptions, override?: number): number {
  if (options.deadlineAt !== undefined && !Number.isSafeInteger(options.deadlineAt)) {
    throw new Error('Run deadline must be a finite integer epoch timestamp');
  }
  if (context.remainingRunMs !== undefined && !Number.isSafeInteger(context.remainingRunMs)) {
    throw new Error('Remaining run duration must be a finite integer');
  }
  if (context.remainingRunMs !== undefined && context.remainingRunMs <= 0) {
    throw new Error('Presentation run deadline exceeded before model call');
  }
  const selected = override ?? (options.allocateTimeout ?? defaultTimeoutAllocator)(context);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_CALL_TIMEOUT_MS) {
    throw new Error(`Allocated model timeout must be an integer from 1 to ${MAX_CALL_TIMEOUT_MS} milliseconds`);
  }
  return Math.min(selected, context.remainingRunMs ?? MAX_CALL_TIMEOUT_MS);
}
