import type { FastifyInstance, FastifyRequest } from 'fastify';
import { changePasswordSchema, loginSchema, registerSchema } from '@nexus/shared';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { clearSessionCookies, requireAuth, requireCsrf, setSessionCookies } from '../http/security.js';
import { AuthService, CSRF_HEADER, SESSION_COOKIE } from '../services/auth.service.js';

function meta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: (req.headers['user-agent'] as string | undefined) ?? null };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = new AuthService(ctx);

  app.post('/api/auth/register', async (req, reply) => {
    ctx.loginLimiter.consume(`register|${req.ip}`);
    const input = parse(registerSchema, req.body);
    const view = auth.register(input, meta(req));
    setSessionCookies(reply, ctx, view);
    ctx.audit.log({ userId: view.user.id, action: 'auth.session_created', targetType: 'session', targetId: view.sessionId, ip: req.ip });
    return reply.status(201).send({
      user: view.user,
      csrfToken: view.csrfToken,
      expiresAt: view.expiresAt,
      firstAccount: view.user.role === 'admin',
    });
  });

  app.post('/api/auth/login', async (req, reply) => {
    ctx.loginLimiter.consume(`login|${req.ip}`);
    const input = parse(loginSchema, req.body);
    const view = auth.login(input, meta(req));
    setSessionCookies(reply, ctx, view);
    return reply.status(200).send({ user: view.user, csrfToken: view.csrfToken, expiresAt: view.expiresAt });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    auth.logout(a.sessionId, a.userId, { ip: req.ip });
    clearSessionCookies(reply, ctx);
    return reply.status(200).send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const a = requireAuth(req);
    return reply.send({
      user: a.user,
      csrfToken: req.cookies?.nexus_csrf ?? null,
      csrfHeader: CSRF_HEADER,
      sessionCookie: SESSION_COOKIE,
    });
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const input = parse(changePasswordSchema, req.body);
    auth.changePassword(a.userId, input.currentPassword, input.newPassword);
    return reply.send({ ok: true });
  });
}
