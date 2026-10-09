import type { Role } from './schema.js';

export type RecoverableFailure = 'timeout' | 'transient' | 'invalid_output';
export class CallFailure extends Error {
  readonly rejectedOutput?: string;
  constructor(readonly kind: RecoverableFailure, message: string, options?: ErrorOptions & { rejectedOutput?: string }) {
    super(message, options);
    this.name = 'CallFailure';
    this.rejectedOutput = options?.rejectedOutput?.slice(0, 12000);
  }
}
export interface RecoveryContext {
  readonly role: Role;
  readonly attempt: number;
  readonly kind: RecoverableFailure;
  readonly diagnostic: string;
  readonly previousTimeoutMs: number;
  readonly remainingCalls: number;
}
export interface RecoveryDecision {
  readonly action: 'retry' | 'stop';
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly delayMs?: number;
}
export interface RecoveryPolicy {
  readonly maxAttempts?: number;
  /** Only called for explicitly recoverable failures, never approval/security errors. */
  readonly decide?: (context: RecoveryContext) => RecoveryDecision;
}

/** Classify transport failures only at the provider boundary, never arbitrary errors. */
export function transportFailure(error: unknown): Error {
  if (!error || typeof error !== 'object') return new Error(String(error));
  const value = error as { status?: unknown; code?: unknown };
  if ([401, 403].includes(Number(value.status))) return error instanceof Error ? error : new Error('Provider authorization failure');
  if ([429, 500, 502, 503, 504].includes(Number(value.status)) ||
      ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(String(value.code))) {
    return new CallFailure('transient', 'Temporary provider transport failure', { cause: error });
  }
  return error instanceof Error ? error : new Error('Unclassified provider failure', { cause: error });
}
