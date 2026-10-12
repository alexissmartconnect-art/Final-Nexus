import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AuthService, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, toPublicUser } from '../services/auth.service.js';
import { NexusError } from '@nexus/shared';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(k)) reply.header(k, v);
    }
  });
}

export function registerRateLimit(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onRequest', async (req) => {
    const key = `${req.ip}|${req.routeOptions?.url ?? req.url}`;
    ctx.apiLimiter.consume(key);
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; sessionId: string; user: ReturnType<typeof toPublicUser> };
  }
}

export function createAuthGuards(app: FastifyInstance, ctx: AppContext): AuthService {
  const auth = new AuthService(ctx);

  /** Attach the session when present; never throws. */
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const resolved = auth.resolve(token);
    if (resolved) req.auth = { userId: resolved.user.id, sessionId: resolved.sessionId, user: resolved.user };
  });

  return auth;
}

export function requireAuth(req: FastifyRequest): NonNullable<FastifyRequest['auth']> {
  if (!req.auth) throw new NexusError('unauthorized', 'Authentication required');
  return req.auth;
}

export function requireAdmin(req: FastifyRequest): NonNullable<FastifyRequest['auth']> {
  const a = requireAuth(req);
  if (a.user.role !== 'admin') throw new NexusError('forbidden', 'Administrator role required');
  return a;
}

/** State-changing requests must carry a valid double-submit CSRF token. */
export function requireCsrf(ctx: AppContext, req: FastifyRequest): void {
  const auth = requireAuth(req);
  const csrfCookie = req.cookies?.[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];
  const authSvc = new AuthService(ctx);
  if (!authSvc.verifyCsrf(auth.sessionId, csrfCookie, typeof header === 'string' ? header : undefined)) {
    ctx.audit.log({ userId: auth.userId, action: 'security.csrf', outcome: 'denied', ip: req.ip });
    throw new NexusError('forbidden', 'Invalid or missing CSRF token');
  }
}

export function cookieOptions(config: { secureCookies: boolean }, name: string, httpOnly: boolean) {
  void name;
  return {
    path: '/',
    httpOnly,
    secure: config.secureCookies,
    sameSite: 'lax' as const,
  };
}

export function setSessionCookies(reply: FastifyReply, ctx: AppContext, view: { token: string; csrfToken: string; expiresAt: number }): void {
  const opts = cookieOptions(ctx.config, SESSION_COOKIE, true);
  void reply.setCookie(SESSION_COOKIE, view.token, { ...opts, expires: new Date(view.expiresAt) });
  // CSRF cookie is readable by the client on purpose: it is the "submit" half of double-submit.
  void reply.setCookie(CSRF_COOKIE, view.csrfToken, { ...opts, httpOnly: false, expires: new Date(view.expiresAt) });
}

export function clearSessionCookies(reply: FastifyReply, ctx: AppContext): void {
  const opts = cookieOptions(ctx.config, SESSION_COOKIE, true);
  void reply.clearCookie(SESSION_COOKIE, { path: opts.path });
  void reply.clearCookie(CSRF_COOKIE, { path: opts.path });
}
