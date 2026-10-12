import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { AppContext } from './context.js';
import { registerErrorHandler } from './http/errors.js';
import { createAuthGuards, registerRateLimit, registerSecurityHeaders } from './http/security.js';
import { authRoutes } from './routes/auth.routes.js';
import { metaRoutes } from './routes/meta.routes.js';
import { credentialRoutes } from './routes/credentials.routes.js';

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * Build the Fastify control-plane application.
 * Exported separately from `server.ts` so tests can drive real route handling
 * through `app.inject()` without opening a port.
 */
export async function buildApp(ctx: AppContext, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? ctx.config.env !== 'test',
    trustProxy: false,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: ctx.config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  registerSecurityHeaders(app);
  registerRateLimit(app, ctx);
  registerErrorHandler(app, ctx);
  createAuthGuards(app, ctx);

  await app.register(async (instance) => {
    await authRoutes(instance, ctx);
    await metaRoutes(instance, ctx);
    await credentialRoutes(instance, ctx);
  });

  return app;
}
