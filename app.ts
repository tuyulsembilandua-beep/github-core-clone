// app.ts — HTTP server for the forge: routing, auth, JSON plumbing.
// Routes:
//   GET  /healthz                          (no auth)
//   POST /mcp                              (MCP JSON-RPC)
//   POST /api/graphql                      (GraphQL v4)
//   /api/v3/*                              (REST v3)
//   /<owner>/<repo>.git/info/refs         (git smart HTTP advertisement)
//   /<owner>/<repo>.git/git-upload-pack    (git fetch / ls-refs, v2 + v0)
//   /<owner>/<repo>.git/git-receive-pack   (git push, v0)
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import type { Ctx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseUploadPack, advertiseReceivePack, handleLsRefs, parseV2FetchArgs,
  handleV2Fetch, handleV0Fetch, handleReceivePack, parsePktLines,
} from './gitproto.ts';

export function createApp(): (req: IncomingMessage, res: ServerResponse) => void {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let reqCounter = 0;

  const nextReqId = (): string => {
    reqCounter += 1;
    return `req-${reqCounter}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void => {
    const payload = body === null ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': nextReqId(),
      ...extraHeaders,
    };
    if (status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  const sendRaw = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, {
      'Content-Type': contentType,
      'X-GitHub-Request-Id': nextReqId(),
      'Content-Length': body.length,
    });
    res.end(body);
  };

  const unauthorized = (res: ServerResponse): void => {
    sendJson(res, 401, { message: 'Requires authentication' });
  };

  // Token check: when MAKEFUN_SHOP_TOKEN is set, the Bearer must match it.
  // When unset (local dev), any non-empty Bearer is accepted; no Bearer -> 401.
  const authorized = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || auth.slice(7).length === 0) return false;
    if (token !== '') return auth.slice(7) === token;
    return true;
  };

  const readBody = (req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const origin = `${url.protocol}//${url.host}`;

        // Health probe: no auth.
        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': nextReqId() });
            res.end(JSON.stringify({ message: 'Method Not Allowed' }));
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) { unauthorized(res); return; }
          const bodyText = (await readBody(req)).toString('utf8');
          const ctx: Ctx = { store, origin, reqId: nextReqId };
          const out = handleMcp(ctx, bodyText);
          if (out.empty) {
            res.writeHead(out.status, { 'X-GitHub-Request-Id': nextReqId() });
            res.end();
            return;
          }
          sendJson(res, out.status, out.body);
          return;
        }

        // GraphQL.
        if (path === '/api/graphql') {
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          if (!authorized(req)) { unauthorized(res); return; }
          const bodyText = (await readBody(req)).toString('utf8');
          const ctx: Ctx = { store, origin, reqId: nextReqId };
          const out = handleGraphQL(ctx, bodyText);
          sendJson(res, out.status, out.body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) { unauthorized(res); return; }
          const ctx: Ctx = { store, origin, reqId: nextReqId };
          let body: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Request body is not valid JSON' });
                return;
              }
            }
          }
          const cleanPath = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
          const out = handleRest(ctx, method, cleanPath, url.searchParams, url, body);
          if (out.status === 204) {
            sendJson(res, 204, null, out.headers);
            return;
          }
          sendJson(res, out.status, out.body, out.headers);
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
        if (gitMatch) {
          const owner = gitMatch[1];
          const repoName = gitMatch[2];
          const action = gitMatch[3];
          if (!authorized(req)) { unauthorized(res); return; }
          if (owner !== VIEWER_LOGIN) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const repo = store.repos.get(repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (action === 'info/refs') {
            if (method !== 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
            const service = url.searchParams.get('service') ?? '';
            if (service === 'git-upload-pack') {
              const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
              sendRaw(res, 200, advertiseUploadPack(repo, v2), 'application/x-git-upload-pack-advertisement');
              return;
            }
            if (service === 'git-receive-pack') {
              sendRaw(res, 200, advertiseReceivePack(repo), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendJson(res, 400, { message: 'unknown service' });
            return;
          }
          if (action === 'git-upload-pack') {
            if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
            const body = await readBody(req);
            const parsed = parsePktLines(body);
            if (parsed.error) {
              sendJson(res, 400, { message: `bad pkt-line stream: ${parsed.error}` });
              return;
            }
            const first = parsed.lines[0]?.replace(/\n$/, '') ?? '';
            const command = parsed.lines.find((l) => l.startsWith('command='))?.replace(/\n$/, '').slice(8);
            if (first === 'version 2' || command === 'ls-refs' || command === 'fetch') {
              if (command === 'ls-refs') {
                const args = parsed.lines.slice(1).map((l) => l.replace(/\n$/, ''));
                sendRaw(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
                return;
              }
              if (command === 'fetch') {
                const args = parsed.lines.slice(1).map((l) => l.replace(/\n$/, ''));
                const fetchReq = parseV2FetchArgs(args);
                sendRaw(res, 200, handleV2Fetch(repo, fetchReq), 'application/x-git-upload-pack-result');
                return;
              }
              sendJson(res, 400, { message: 'unknown v2 command' });
              return;
            }
            // v0 fetch: want/have lines.
            sendRaw(res, 200, handleV0Fetch(repo, parsed.lines), 'application/x-git-upload-pack-result');
            return;
          }
          if (action === 'git-receive-pack') {
            if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
            const body = await readBody(req);
            const out = handleReceivePack(repo, body);
            if (out.status !== 200) {
              sendJson(res, out.status, { message: out.body.toString('utf8') });
              return;
            }
            sendRaw(res, 200, out.body, 'application/x-git-receive-pack-result');
            return;
          }
        }

        // Unknown route.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        // Never crash the server on a bad request.
        try {
          sendJson(res, 500, { message: `Internal error: ${(e as Error).message}` });
        } catch { /* socket already closed */ }
      }
    })();
  };
}

export function startServer(port: number): ReturnType<typeof createServer> {
  const server = createServer(createApp());
  // No host: bind all interfaces, as the trial env dials from its container.
  server.listen(port);
  return server;
}
