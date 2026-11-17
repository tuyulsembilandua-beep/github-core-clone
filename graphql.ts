// graphql.ts — a small GraphQL executor for the documents the suite sends:
// viewer, repository(+issue/issues/pullRequest/pullRequests), node, __type,
// and the createIssue / closeIssue / createPullRequest / mergePullRequest /
// addComment mutations. Unknown fields return a GraphQL-level error (HTTP 200)
// whose message names the field. Batching (array of operations) is supported.
import {
  Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME,
  parseCommit, filesFromTree, diffFiles, storeObject, buildCommit, treeFromFiles,
} from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import type { Ctx } from './rest.ts';
import { prConflict } from './rest.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[] | null;
  fragments: Fragment[];
}

interface Fragment {
  typeCondition: string | null;
  selections: Selection[];
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.pos += 1; continue; }
      if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private eat(ch: string): boolean {
    this.skipWs();
    if (this.src[this.pos] === ch) { this.pos += 1; return true; }
    return false;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) throw new Error(`expected ${ch} at ${this.pos}`);
  }

  private readName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) this.pos += 1;
    if (this.pos === start) throw new Error(`expected name at ${this.pos}`);
    return this.src.slice(start, this.pos);
  }

  private readString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new Error(`expected string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.src[this.pos++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else out += e;
      } else out += c;
    }
    throw new Error('unterminated string');
  }

  private readValue(): Value {
    this.skipWs();
    const c = this.src[this.pos];
    if (c === '"') return { kind: 'string', value: this.readString() };
    if (c === '$') { this.pos += 1; return { kind: 'variable', name: this.readName() }; }
    if (c === '[') {
      this.pos += 1;
      const items: Value[] = [];
      while (!this.eat(']')) items.push(this.readValue());
      return { kind: 'list', items };
    }
    if (c === '{') {
      this.pos += 1;
      const fields: Record<string, Value> = {};
      while (!this.eat('}')) {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
      }
      return { kind: 'object', fields };
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const start = this.pos;
      if (this.src[this.pos] === '-') this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos])) this.pos += 1;
      let isFloat = false;
      if (this.src[this.pos] === '.') {
        isFloat = true;
        this.pos += 1;
        while (/[0-9]/.test(this.src[this.pos])) this.pos += 1;
      }
      const n = Number(this.src.slice(start, this.pos));
      return isFloat ? { kind: 'float', value: n } : { kind: 'int', value: n };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private readArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (!this.eat('(')) return args;
    while (!this.eat(')')) {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
    return args;
  }

  private readSelections(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.eat('}')) {
      if (this.peek() === '.' && this.src.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipWs();
        if (this.src.startsWith('on ', this.pos)) {
          this.pos += 3;
          const typeName = this.readName();
          const sels = this.readSelections();
          out.push({ alias: null, name: '__fragment', args: {}, selections: sels, fragments: [{ typeCondition: typeName, selections: sels }] });
        } else {
          // Named fragment spread — not used by the suite; skip its selections.
          this.readName();
          if (this.peek() === '{') this.readSelections();
        }
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.eat(':')) {
        alias = first;
        name = this.readName();
      }
      const args = this.readArgs();
      let selections: Selection[] | null = null;
      if (this.peek() === '{') selections = this.readSelections();
      out.push({ alias, name, args, selections, fragments: [] });
    }
    return out;
  }

  parse(): Operation {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.src.startsWith('query', this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + 5] ?? ' ')) {
      this.pos += 5;
      this.skipWs();
      if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
    } else if (this.src.startsWith('mutation', this.pos)) {
      kind = 'mutation';
      this.pos += 8;
      this.skipWs();
      if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
    }
    // Variable definitions ($x: Type = default) — skip them.
    if (this.eat('(')) {
      let depth = 1;
      while (depth > 0 && this.pos < this.src.length) {
        const c = this.src[this.pos++];
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
      }
    }
    const selections = this.readSelections();
    return { kind, name, variables: {}, selections };
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  ctx: Ctx;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': return variables[v.name];
    case 'string': return v.value;
    case 'int': case 'float': return v.value;
    case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

function argsOf(sel: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) out[k] = resolveValue(v, variables);
  return out;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const idx = s.indexOf(':');
    if (idx < 0) return null;
    return { kind: s.slice(0, idx), key: s.slice(idx + 1) };
  } catch {
    return null;
  }
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexFromCursor(cursor: string | undefined | null): number {
  if (!cursor) return -1;
  try {
    const s = Buffer.from(cursor, 'base64').toString('utf8');
    if (s.startsWith('cursor:')) return parseInt(s.slice(7), 10);
  } catch { /* ignore */ }
  return -1;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};

function fieldError(ec: ExecCtx, typeName: string, field: string): void {
  ec.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

// Resolve a selection set against a value of a known type.
function resolveSelections(
  ec: ExecCtx, typeName: string, value: Record<string, unknown> | null, sels: Selection[],
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.name === '__fragment') {
      // Inline fragment: apply if the type matches (or no condition).
      for (const frag of sel.fragments) {
        if (!frag.typeCondition || frag.typeCondition === typeName) {
          const sub = resolveSelections(ec, typeName, value, frag.selections);
          if (sub) Object.assign(out, sub);
        }
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const resolved = resolveField(ec, typeName, value, sel);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

// Returns undefined when the field is unknown (error recorded) or when the
// field is __typename.
function resolveField(
  ec: ExecCtx, typeName: string, value: Record<string, unknown>, sel: Selection,
): unknown {
  const args = argsOf(sel, ec.variables);
  const name = sel.name;
  if (name === '__typename') return typeName;

  // --- Query root ---
  if (typeName === 'Query') {
    if (name === 'viewer') {
      const v = { login: VIEWER_LOGIN, id: globalId('User', String(VIEWER_ID)), name: VIEWER_NAME, email: 'adaiversen@example.invalid' };
      return sel.selections ? resolveSelections(ec, 'User', v, sel.selections) : v;
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ec.store.repos.get(repoName);
      if (!repo) return null;
      return sel.selections ? resolveSelections(ec, 'Repository', repoValue(ec, repo), sel.selections) : repoValue(ec, repo);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = [...ec.store.repos.values()].find((r) => String(r.id) === decoded.key);
        if (!repo) return null;
        return sel.selections ? resolveSelections(ec, 'Repository', repoValue(ec, repo), sel.selections) : repoValue(ec, repo);
      }
      if (decoded.kind === 'Issue') {
        const [repoId, num] = decoded.key.split(':');
        const repo = [...ec.store.repos.values()].find((r) => String(r.id) === repoId);
        const issue = repo?.issues.find((i) => i.number === Number(num));
        if (!issue || !repo) return null;
        return sel.selections ? resolveSelections(ec, 'Issue', issueValue(ec, repo, issue), sel.selections) : issueValue(ec, repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const [repoId, num] = decoded.key.split(':');
        const repo = [...ec.store.repos.values()].find((r) => String(r.id) === repoId);
        const pull = repo?.pulls.find((p) => p.number === Number(num));
        if (!pull || !repo) return null;
        return sel.selections ? resolveSelections(ec, 'PullRequest', pullValue(ec, repo, pull), sel.selections) : pullValue(ec, repo, pull);
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = String(args.name ?? '');
      if (typeNameArg === 'SearchType') {
        const v: Record<string, unknown> = { name: 'SearchType', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'].map((n) => ({ name: n })) };
        return sel.selections ? resolveSelections(ec, '__Type', v, sel.selections) : v;
      }
      const fields = TYPE_FIELDS[typeNameArg];
      if (!fields) return null;
      const v: Record<string, unknown> = {
        name: typeNameArg,
        fields: fields.map((f) => ({ name: f })),
        enumValues: null,
      };
      return sel.selections ? resolveSelections(ec, '__Type', v, sel.selections) : v;
    }
    if (name === '__schema') {
      return sel.selections ? resolveSelections(ec, '__Schema', { types: [] }, sel.selections) : {};
    }
    fieldError(ec, 'Query', name);
    return undefined;
  }

  // --- Mutation root ---
  if (typeName === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(ec, args, sel);
    if (name === 'closeIssue') return mutateCloseIssue(ec, args, sel);
    if (name === 'createPullRequest') return mutateCreatePullRequest(ec, args, sel);
    if (name === 'mergePullRequest') return mutateMergePullRequest(ec, args, sel);
    if (name === 'addComment') return mutateAddComment(ec, args, sel);
    fieldError(ec, 'Mutation', name);
    return undefined;
  }

  // --- __Type ---
  if (typeName === '__Type') {
    if (name === 'fields') {
      const fields = (value.fields as { name: string }[] | null) ?? [];
      const includeDeprecated = args.includeDeprecated === true;
      void includeDeprecated;
      return fields.map((f) => (sel.selections ? resolveSelections(ec, '__Field', f as unknown as Record<string, unknown>, sel.selections) : f));
    }
    if (name === 'enumValues') {
      const vals = (value.enumValues as { name: string }[] | null) ?? [];
      return vals.map((v) => (sel.selections ? resolveSelections(ec, '__EnumValue', v as unknown as Record<string, unknown>, sel.selections) : v));
    }
    if (name === 'name') return value.name;
    fieldError(ec, '__Type', name);
    return undefined;
  }

  // --- __Field / __EnumValue ---
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return value.name;
    fieldError(ec, typeName, name);
    return undefined;
  }

  // --- User ---
  if (typeName === 'User') {
    if (['login', 'name', 'email', 'id'].includes(name)) return value[name];
    fieldError(ec, 'User', name);
    return undefined;
  }

  // --- Repository ---
  if (typeName === 'Repository') {
    const repo = value.__repo as Repo;
    switch (name) {
      case 'id': return value.id;
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${VIEWER_LOGIN}/${repo.name}`;
      case 'description': return repo.description;
      case 'owner': {
        const v = { login: VIEWER_LOGIN, id: globalId('User', String(VIEWER_ID)), name: VIEWER_NAME };
        return sel.selections ? resolveSelections(ec, 'User', v, sel.selections) : v;
      }
      case 'defaultBranchRef': {
        const v = { name: repo.defaultBranch };
        return sel.selections ? resolveSelections(ec, 'Ref', v, sel.selections) : v;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'createdAt': case 'updatedAt': return ec.store.stamp(repo.seq);
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        if (!issue) return null;
        return sel.selections ? resolveSelections(ec, 'Issue', issueValue(ec, repo, issue), sel.selections) : issueValue(ec, repo, issue);
      }
      case 'issues': return issuesConnection(ec, repo, args, sel);
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        if (!pull) return null;
        return sel.selections ? resolveSelections(ec, 'PullRequest', pullValue(ec, repo, pull), sel.selections) : pullValue(ec, repo, pull);
      }
      case 'pullRequests': return pullsConnection(ec, repo, args, sel);
      default:
        fieldError(ec, 'Repository', name);
        return undefined;
    }
  }

  // --- Issue ---
  if (typeName === 'Issue') {
    const issue = value.__issue as Issue;
    switch (name) {
      case 'id': return value.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt': case 'updatedAt': return ec.store.stamp(issue.seq);
      default:
        fieldError(ec, 'Issue', name);
        return undefined;
    }
  }

  // --- PullRequest ---
  if (typeName === 'PullRequest') {
    const pull = value.__pull as Pull;
    const repo = value.__repo as Repo;
    switch (name) {
      case 'id': return value.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'mergeable': return prConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'createdAt': case 'updatedAt': return ec.store.stamp(pull.seq);
      case 'files': {
        const baseFiles = filesFromTree(repo, parseCommit(repo.objects.get(pull.baseSha)!.data).tree);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const headFiles = filesFromTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
        const changes = diffFiles(repo, baseFiles, headFiles).filter((c) => c.status !== 'removed');
        const first = typeof args.first === 'number' ? args.first : changes.length;
        // Raw node values only: the connection branch resolves `nodes` with
        // the node's own sub-selections.
        const nodes = changes.slice(0, first).map((c) => ({ path: c.path }) as Record<string, unknown>);
        const v: Record<string, unknown> = { nodes, totalCount: changes.length };
        return sel.selections ? resolveSelections(ec, 'PullRequestChangedFileConnection', v, sel.selections) : v;
      }
      default:
        fieldError(ec, 'PullRequest', name);
        return undefined;
    }
  }

  // --- Connections ---
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const nodes = (value.nodes as Record<string, unknown>[]) ?? [];
      const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((n) => (sel.selections ? resolveSelections(ec, itemType, n, sel.selections) : n));
    }
    if (name === 'totalCount') return value.totalCount ?? ((value.nodes as unknown[])?.length ?? 0);
    if (name === 'pageInfo') {
      const v = value.pageInfo as Record<string, unknown>;
      return sel.selections ? resolveSelections(ec, 'PageInfo', v, sel.selections) : v;
    }
    fieldError(ec, typeName, name);
    return undefined;
  }

  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return value.hasNextPage;
    if (name === 'endCursor') return value.endCursor;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return value.startCursor ?? null;
    fieldError(ec, 'PageInfo', name);
    return undefined;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (name === 'path') return value.path;
    fieldError(ec, typeName, name);
    return undefined;
  }

  if (typeName === 'IssueComment') {
    if (name === 'id') return value.id;
    if (name === 'body') return value.body;
    fieldError(ec, typeName, name);
    return undefined;
  }

  if (typeName === 'CommentEdge') {
    if (name === 'node') {
      const node = value.node as Record<string, unknown>;
      return sel.selections ? resolveSelections(ec, 'IssueComment', node, sel.selections) : node;
    }
    fieldError(ec, typeName, name);
    return undefined;
  }

  if (typeName === 'Ref') {
    if (name === 'name') return value.name;
    fieldError(ec, 'Ref', name);
    return undefined;
  }

  fieldError(ec, typeName, name);
  return undefined;
}

// ---------------------------------------------------------------------------
// Value builders
// ---------------------------------------------------------------------------

function repoValue(ec: ExecCtx, repo: Repo): Record<string, unknown> {
  return {
    __repo: repo,
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${VIEWER_LOGIN}/${repo.name}`,
  };
}

function issueValue(ec: ExecCtx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function pullValue(ec: ExecCtx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __repo: repo,
    __pull: pull,
    id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
  };
}

function issuesConnection(ec: ExecCtx, repo: Repo, args: Record<string, unknown>, sel: Selection): unknown {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && String(orderBy.field ?? '') === 'CREATED_AT') {
    const dir = String(orderBy.direction ?? 'DESC');
    list.sort((a, b) => dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq);
  } else {
    list.sort((a, b) => b.seq - a.seq);
  }
  const after = indexFromCursor(typeof args.after === 'string' ? args.after : null);
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  const v: Record<string, unknown> = {
    nodes: page.map((i) => issueValue(ec, repo, i)),
    totalCount: list.length,
    pageInfo: {
      hasNextPage: start + page.length < list.length,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
      startCursor: page.length > 0 ? cursorFor(start) : null,
    },
  };
  return sel.selections ? resolveSelections(ec, 'IssueConnection', v, sel.selections) : v;
}

function pullsConnection(ec: ExecCtx, repo: Repo, args: Record<string, unknown>, sel: Selection): unknown {
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => want.has(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list.sort((a, b) => b.seq - a.seq);
  const after = indexFromCursor(typeof args.after === 'string' ? args.after : null);
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  const v: Record<string, unknown> = {
    nodes: page.map((p) => pullValue(ec, repo, p)),
    totalCount: list.length,
    pageInfo: {
      hasNextPage: start + page.length < list.length,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
      startCursor: page.length > 0 ? cursorFor(start) : null,
    },
  };
  return sel.selections ? resolveSelections(ec, 'PullRequestConnection', v, sel.selections) : v;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function findRepoByGlobalId(ec: ExecCtx, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  return [...ec.store.repos.values()].find((r) => String(r.id) === decoded.key) ?? null;
}

function findIssueByGlobalId(ec: ExecCtx, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const [repoId, num] = decoded.key.split(':');
  const repo = [...ec.store.repos.values()].find((r) => String(r.id) === repoId);
  const issue = repo?.issues.find((i) => i.number === Number(num));
  if (!repo || !issue) return null;
  return { repo, issue };
}

function findPullByGlobalId(ec: ExecCtx, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const [repoId, num] = decoded.key.split(':');
  const repo = [...ec.store.repos.values()].find((r) => String(r.id) === repoId);
  const pull = repo?.pulls.find((p) => p.number === Number(num));
  if (!repo || !pull) return null;
  return { repo, pull };
}

function payload(ec: ExecCtx, sel: Selection, inner: Record<string, unknown>): unknown {
  if (!sel.selections) return inner;
  return resolveSelections(ec, 'MutationPayload', inner, sel.selections);
}

function mutateCreateIssue(ec: ExecCtx, args: Record<string, unknown>, sel: Selection): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = findRepoByGlobalId(ec, String(input.repositoryId ?? ''));
  if (!repo) {
    ec.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const seq = ec.store.tick();
  const issue: Issue = {
    id: ec.store.nextIssueId++,
    number: repo.nextNumber++,
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    seq,
  };
  repo.issues.push(issue);
  const inner: Record<string, unknown> = {
    issue: issueValue(ec, repo, issue),
  };
  return payloadWithIssue(ec, sel, inner);
}

function payloadWithIssue(ec: ExecCtx, sel: Selection, inner: Record<string, unknown>): unknown {
  if (!sel.selections) return inner;
  const out: Record<string, unknown> = {};
  for (const s of sel.selections) {
    if (s.name === 'issue' && inner.issue) {
      const iv = inner.issue as Record<string, unknown>;
      out[s.alias ?? 'issue'] = s.selections ? resolveSelections(ec, 'Issue', iv, s.selections) : iv;
    } else {
      out[s.alias ?? s.name] = inner[s.name] ?? null;
    }
  }
  return out;
}

function mutateCloseIssue(ec: ExecCtx, args: Record<string, unknown>, sel: Selection): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = findIssueByGlobalId(ec, String(input.issueId ?? ''));
  if (!found) {
    ec.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  found.issue.state = 'closed';
  return payloadWithIssue(ec, sel, { issue: issueValue(ec, found.repo, found.issue) });
}

function mutateCreatePullRequest(ec: ExecCtx, args: Record<string, unknown>, sel: Selection): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = findRepoByGlobalId(ec, String(input.repositoryId ?? ''));
  if (!repo) {
    ec.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) {
    ec.errors.push({ message: 'Head or base ref does not exist.' });
    return null;
  }
  const seq = ec.store.tick();
  const pull: Pull = {
    id: ec.store.nextPullId++,
    number: repo.nextNumber++,
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    seq,
  };
  repo.pulls.push(pull);
  if (!sel.selections) return { pullRequest: pullValue(ec, repo, pull) };
  const out: Record<string, unknown> = {};
  for (const s of sel.selections) {
    if (s.name === 'pullRequest') {
      const pv = pullValue(ec, repo, pull);
      out[s.alias ?? 'pullRequest'] = s.selections ? resolveSelections(ec, 'PullRequest', pv, s.selections) : pv;
    } else {
      out[s.alias ?? s.name] = null;
    }
  }
  return out;
}

function mutateMergePullRequest(ec: ExecCtx, args: Record<string, unknown>, sel: Selection): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = findPullByGlobalId(ec, String(input.pullRequestId ?? ''));
  if (!found) {
    ec.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return null;
  }
  const { repo, pull } = found;
  if (pull.state !== 'open') {
    ec.errors.push({ message: 'Pull request is not open.' });
    return null;
  }
  if (prConflict(repo, pull)) {
    ec.errors.push({ message: 'Merge conflict.' });
    return null;
  }
  // Squash merge via the same logic as REST.
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
  pull.mergedAt = ec.store.stamp(ec.store.tick());
  if (!sel.selections) return { pullRequest: pullValue(ec, repo, pull) };
  const out: Record<string, unknown> = {};
  for (const s of sel.selections) {
    if (s.name === 'pullRequest') {
      const pv = pullValue(ec, repo, pull);
      out[s.alias ?? 'pullRequest'] = s.selections ? resolveSelections(ec, 'PullRequest', pv, s.selections) : pv;
    } else {
      out[s.alias ?? s.name] = null;
    }
  }
  return out;
}

function mutateAddComment(ec: ExecCtx, args: Record<string, unknown>, sel: Selection): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const subjectId = String(input.subjectId ?? '');
  const body = String(input.body ?? '');
  const foundIssue = findIssueByGlobalId(ec, subjectId);
  if (foundIssue) {
    const seq = ec.store.tick();
    const comment = { id: ec.store.nextCommentId++, body, seq };
    foundIssue.issue.comments.push(comment);
    const node: Record<string, unknown> = {
      id: globalId('IssueComment', `${foundIssue.repo.id}:${foundIssue.issue.number}:${comment.id}`),
      body,
    };
    const edge: Record<string, unknown> = { node };
    if (!sel.selections) return { commentEdge: edge };
    const out: Record<string, unknown> = {};
    for (const s of sel.selections) {
      if (s.name === 'commentEdge') {
        out[s.alias ?? 'commentEdge'] = s.selections ? resolveSelections(ec, 'CommentEdge', edge, s.selections) : edge;
      } else {
        out[s.alias ?? s.name] = null;
      }
    }
    return out;
  }
  ec.errors.push({ message: 'Could not resolve to a subject with the global id.' });
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function handleGraphQL(ctx: Ctx, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { message: 'Request body is not valid JSON' } };
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const op of ops) {
    const o = op as Record<string, unknown>;
    const query = typeof o.query === 'string' ? o.query : '';
    const variables = (o.variables ?? {}) as Record<string, unknown>;
    if (!query) {
      results.push({ errors: [{ message: 'No query provided.' }] });
      continue;
    }
    let operation: Operation;
    try {
      operation = new Parser(query).parse();
    } catch (e) {
      results.push({ errors: [{ message: `Syntax error: ${(e as Error).message}` }] });
      continue;
    }
    const ec: ExecCtx = { store: ctx.store, ctx, variables, errors: [] };
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = resolveSelections(ec, rootType, {}, operation.selections) ?? {};
    const result: Record<string, unknown> = { data };
    if (ec.errors.length > 0) result.errors = ec.errors;
    results.push(result);
  }
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}
