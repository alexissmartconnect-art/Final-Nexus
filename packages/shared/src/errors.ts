export type NexusErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'validation' | 'rate_limited' | 'budget_exceeded' | 'provider_error'
  | 'provider_unavailable' | 'runner_unavailable' | 'build_failed' | 'test_failed'
  | 'unsupported' | 'unsafe_path' | 'unsafe_command' | 'ssrf_blocked'
  | 'injection_blocked' | 'internal';

export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: NexusErrorCode, message: string, opts: { status?: number; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'NexusError';
    this.code = code;
    this.status = opts.status ?? statusFor(code);
    this.details = opts.details;
  }
}

function statusFor(code: NexusErrorCode): number {
  switch (code) {
    case 'bad_request': return 400;
    case 'validation': return 422;
    case 'unauthorized': return 401;
    case 'forbidden': return 403;
    case 'not_found': return 404;
    case 'conflict': return 409;
    case 'rate_limited': return 429;
    case 'budget_exceeded': return 402;
    case 'unsupported': return 501;
    case 'provider_unavailable':
    case 'runner_unavailable': return 503;
    case 'provider_error': return 502;
    default: return 500;
  }
}

export function isNexusError(e: unknown): e is NexusError {
  return e instanceof NexusError;
}
