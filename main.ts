// main.ts — entrypoint: boot the forge, register with the trial environment,
// answer the health probe, and wait for the done signal.
// The environment hands us two values:
//   MAKEFUN_ENV_URL     the trial environment's base URL
//   MAKEFUN_SHOP_TOKEN  the token every client request carries
//
// Lifecycle (as the kit's wire settles it): bind an ephemeral port, POST the
// port to $MAKEFUN_ENV_URL/register, then poll GET $MAKEFUN_ENV_URL/done until
// {"done": true} and exit 0. The server binds all interfaces (no host): the
// env dials the entry from its own container, so 127.0.0.1 would not answer.
import { createServer } from 'node:http';
import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer;
// 409 means a first register already won, which is not this process's to
// fix. A network error or another status is retried: the env may still be
// starting.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: keep polling.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createServer(createApp());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  console.log(`forge listening on port ${address.port}`);

  if (!envUrl) {
    // No trial environment (local dev): just serve forever.
    console.log('MAKEFUN_ENV_URL is not set; serving without registration.');
    return;
  }

  await register(address.port);
  console.log('registered with the trial environment');

  await waitForDone();
  console.log('done; shutting down');
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
