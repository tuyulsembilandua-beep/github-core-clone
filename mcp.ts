// mcp.ts — Model Context Protocol over streamable HTTP (plain JSON responses).
// Supports both the modern server/discover handshake and the legacy
// initialize + notifications/initialized flow, tools/list (byte-identical
// across calls) and tools/call for the six required forge tools.
import { VIEWER_LOGIN, parseCommit, filesFromTree, diffFiles, treeFromFiles, buildCommit, storeObject } from './store.ts';
import { repoShape, issueShape, pullShape, prConflict } from './rest.ts';
import type { Ctx } from './rest.ts';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function getRepoOrNull(ctx: Ctx, owner: unknown, repo: unknown) {
  if (owner !== VIEWER_LOGIN || typeof repo !== 'string') return null;
  return ctx.store.repos.get(repo) ?? null;
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = name.toLowerCase().replace(/[-_]/g, '');
  switch (norm) {
    case 'createrepo': {
      if (typeof args.name !== 'string' || args.name.length === 0) return toolError('Missing required argument: name');
      if (ctx.store.repos.has(args.name)) return toolError(`Repository already exists: ${args.name}`);
      const repo = ctx.store.createRepo(
        args.name,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoShape(ctx, repo));
    }
    case 'getrepo': {
      if (typeof args.owner !== 'string' || typeof args.repo !== 'string') return toolError('Missing required arguments: owner, repo');
      const repo = getRepoOrNull(ctx, args.owner, args.repo);
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      return toolResult(repoShape(ctx, repo));
    }
    case 'createissue': {
      if (typeof args.owner !== 'string' || typeof args.repo !== 'string' || typeof args.title !== 'string') {
        return toolError('Missing required arguments: owner, repo, title');
      }
      const repo = getRepoOrNull(ctx, args.owner, args.repo);
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const seq = ctx.store.tick();
      const issue = {
        id: ctx.store.nextIssueId++,
        number: repo.nextNumber++,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as never[],
        seq,
      };
      repo.issues.push(issue);
      return toolResult(issueShape(ctx, repo, issue));
    }
    case 'listissues': {
      if (typeof args.owner !== 'string' || typeof args.repo !== 'string') return toolError('Missing required arguments: owner, repo');
      const repo = getRepoOrNull(ctx, args.owner, args.repo);
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      const issues = list.map((i) => issueShape(ctx, repo, i));
      return toolResult({ issues });
    }
    case 'createpullrequest': {
      if (typeof args.owner !== 'string' || typeof args.repo !== 'string' || typeof args.title !== 'string' ||
        typeof args.head !== 'string' || typeof args.base !== 'string') {
        return toolError('Missing required arguments: owner, repo, title, head, base');
      }
      const repo = getRepoOrNull(ctx, args.owner, args.repo);
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const headTip = repo.refs.get(`refs/heads/${args.head}`);
      const baseTip = repo.refs.get(`refs/heads/${args.base}`);
      if (!headTip || !baseTip) return toolError('Head or base branch does not exist');
      const seq = ctx.store.tick();
      const pull = {
        id: ctx.store.nextPullId++,
        number: repo.nextNumber++,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: args.head,
        baseRef: args.base,
        headSha: headTip,
        baseSha: baseTip,
        seq,
      };
      repo.pulls.push(pull);
      return toolResult(pullShape(ctx, repo, pull));
    }
    case 'mergepullrequest': {
      if (typeof args.owner !== 'string' || typeof args.repo !== 'string' || args.pull_number === undefined) {
        return toolError('Missing required arguments: owner, repo, pull_number');
      }
      const repo = getRepoOrNull(ctx, args.owner, args.repo);
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return toolError(`Pull request not found: ${args.pull_number}`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      if (prConflict(repo, pull)) return toolError('Merge conflict');
      // Squash merge: base tree with the PR's file changes applied.
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const prBaseFiles = filesFromTree(repo, parseCommit(repo.objects.get(pull.baseSha)!.data).tree);
      const headFiles = filesFromTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
      const curBaseFiles = filesFromTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
      const merged = new Map<string, Buffer | string>(curBaseFiles);
      for (const c of diffFiles(repo, prBaseFiles, headFiles)) {
        if (c.status === 'removed') merged.delete(c.path);
        else merged.set(c.path, headFiles.get(c.path)!);
      }
      const treeOid = treeFromFiles(repo, merged);
      const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}`;
      const mergeOid = storeObject(repo, 'commit', buildCommit(treeOid, [baseTip], message));
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = mergeOid;
      pull.mergedAt = ctx.store.stamp(ctx.store.tick());
      return toolResult({ merged: true, number: pull.number, sha: mergeOid, state: 'closed' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export function handleMcp(ctx: Ctx, bodyText: string): { status: number; body: unknown; empty?: boolean } {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(bodyText) as JsonRpcRequest;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;

  if (req.method === 'notifications/initialized') {
    return { status: 202, body: null, empty: true };
  }
  if (isNotification) {
    return { status: 202, body: null, empty: true };
  }

  switch (req.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: '2026-07-28',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
      };
    }
    case 'initialize': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    case 'tools/list': {
      // Byte-identical across calls: serialize the same constant array.
      return { status: 200, body: rpcResult(id, { tools: JSON.parse(TOOLS_JSON) as ToolDef[] }) };
    }
    case 'tools/call': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.some((t) => t.name === name);
      if (!known) {
        return { status: 200, body: rpcError(id, -32601, `Method not found: ${name}`) };
      }
      const result = callTool(ctx, name, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${req.method}`) };
  }
}
