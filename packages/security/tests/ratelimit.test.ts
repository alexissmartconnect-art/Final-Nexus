import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';
import { NexusError } from '@nexus/shared';

describe('rate limiter', () => {
  it('allows up to max then throws a 429 NexusError', () => {
    const rl = new RateLimiter({ max: 3, windowMs: 60_000 });
    expect(rl.check('k').allowed).toBe(true);
    expect(rl.check('k').allowed).toBe(true);
    expect(rl.check('k').allowed).toBe(true);
    const denied = rl.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('consume() throws with code rate_limited', () => {
    const rl = new RateLimiter({ max: 1, windowMs: 60_000 });
    rl.consume('k');
    try {
      rl.consume('k');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NexusError);
      expect((e as NexusError).code).toBe('rate_limited');
      expect((e as NexusError).status).toBe(429);
    }
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ max: 1, windowMs: 60_000 });
    rl.consume('a');
    expect(rl.check('b').allowed).toBe(true);
  });
});
