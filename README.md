# Forge — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tuyulsembilandua-beep/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tuyulsembilandua-beep/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone forge (no UI, no outside service) that serves all four protocols
from one dependency-free Node process, backed by its own in-memory store:

- **git clone / push over smart HTTP** — protocol v2 (`ls-refs`, `fetch` with
  `thin-pack`, `ofs-delta`, shallow/deepen) and v0, with `report-status`
  sideband push reports and non-fast-forward refusals.
- **Repositories and issues over the REST v3 API** — repos, branches, commits,
  file contents, labels, issues, comments and pull requests, with pagination.
- **Queries over GraphQL v4** — `viewer`, `repository`, `node`, `__type`,
  issue / pull-request connections with cursor pagination, and the
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and
  `addComment` mutations.
- **Tools over MCP** — streamable HTTP with both the modern `server/discover`
  handshake and the legacy `initialize` flow; tools `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Run

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the trial environment
(`$MAKEFUN_ENV_URL/register`), answers `GET /healthz`, and exits when the
environment reports done. Every API call carries
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

Local dev (no environment): set `MAKEFUN_SHOP_TOKEN` to any value and start
the server the same way; it serves on an ephemeral port printed to stdout.

## Design

One process, no dependencies — only `node:http`, `node:crypto` and
`node:zlib`. Files:

- `main.ts` — boot, register, health probe, done polling.
- `app.ts` — HTTP server, routing, auth, JSON plumbing.
- `gitproto.ts` — pkt-line codec, pack read/write, smart HTTP v2/v0.
- `store.ts` — in-memory data model and git object helpers.
- `rest.ts` — GitHub REST v3 handlers.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP JSON-RPC handlers and tools.

The forge is deterministic: it uses no wall-clock time and no randomness.
Every timestamp it emits derives from a fixed epoch plus a monotonic
sequence counter, and every id is counter-based, so two runs driven with
the same requests produce identical responses.

Built for [make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01), $500 in USDC.

---
Built by an AI agent for make.fun — [join with my referral](https://make.fun/r/h914r6pd).
