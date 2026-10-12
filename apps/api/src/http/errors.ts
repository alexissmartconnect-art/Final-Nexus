import type { FastifyBaseLogger, FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isNexusError, NexusError } from '@nexus/shared';
import { ZodError } from 'zod';
import { redactSecrets } from '@nexus/security';
import type { AppContext } from '../context.js';

export function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: ZodError } }, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    throw new NexusError('validation', 'Invalid request payload', {
      details: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return res.data;
}

export function registerErrorHandler(app: FastifyInstance, ctx: AppContext): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const log = app.log as FastifyBaseLogger;
    let status = 500;
    let code = 'internal';
    let message = 'Internal server error';
    let details: unknown;

    if (isNexusError(err)) {
      status = err.status; code = err.code; message = err.message; details = err.details;
    } else if (err instanceof ZodError) {
      status = 422; code = 'validation'; message = 'Invalid request payload';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
      status = err.statusCode; code = 'bad_request'; message = err.message;
    }

    // Never echo internals or secrets back to the client, never log secrets.
    const safeMessage = redactSecrets(message).text;
    if (status >= 500) {
      log.error({ err: redactSecrets(String(err.stack ?? err.message)).text, reqId: req.id }, 'request failed');
    }
    ctx.audit.log({
      action: `http.${code}`,
      outcome: status >= 500 ? 'error' : status === 401 || status === 403 ? 'denied' : 'ok',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      detail: { method: req.method, url: req.url, status, code },
    });
    void reply.status(status).send({ error: { code, message: safeMessage, details } });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
  });
}
