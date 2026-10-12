import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;

export interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
  /** Queue a canned status for the next N calls to a path (used for retry tests). */
  failNext: (path: string, times: number, status: number, headers?: Record<string, string>) => void;
}

/**
 * A real HTTP server on 127.0.0.1. Contract tests drive the provider clients
 * against it over actual sockets, so request shaping, SSE parsing, retries and
 * error mapping are exercised for real - nothing here is a stub of our own code.
 */
export async function startMockServer(routes: Record<string, Handler>): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const failures = new Map<string, { times: number; status: number; headers: Record<string, string> }>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      const url = req.url ?? '/';
      const path = url.split('?')[0]!;
      requests.push({ method: req.method ?? 'GET', url, headers: req.headers, body });

      const queued = failures.get(path);
      if (queued && queued.times > 0) {
        queued.times -= 1;
        for (const [k, v] of Object.entries(queued.headers)) res.setHeader(k, v);
        res.statusCode = queued.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: `injected ${queued.status}` } }));
        return;
      }

      const handler = routes[path];
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: `no mock route for ${path}` } }));
        return;
      }
      try {
        const out = handler(req, res, body);
        if (out instanceof Promise) out.catch((e) => { res.statusCode = 500; res.end(String(e)); });
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    failNext: (path, times, status, headers = {}) => failures.set(path, { times, status, headers }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Write an SSE payload chunk by chunk, the way a real provider does. */
export async function writeSse(res: ServerResponse, chunks: (string | object)[]): Promise<void> {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  for (const c of chunks) {
    const data = typeof c === 'string' ? c : JSON.stringify(c);
    res.write(`data: ${data}\n\n`);
    await new Promise((r) => setTimeout(r, 5));
  }
  res.end();
}
