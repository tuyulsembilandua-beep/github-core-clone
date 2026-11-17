// rest.ts — GitHub REST v3 API handlers. All responses are JSON with a
// non-empty X-GitHub-Request-Id. Errors carry a string `message`.
import { createHash } from 'node:crypto';
import {
  Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL,
  ZERO_OID, storeObject, buildCommit, buildTree, parseCommit, parseTree,
  treeFromFiles, filesFromTree, blobBytes, commitHistory, diffFiles, isAncestor,
} from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

export interface Ctx {
  store: Store;
  origin: string; // e.g. http://127.0.0.1:PORT
  reqId: () => string;
}

export interface Resp {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Resp {
  return { status, body, headers };
}

function err(status: number, message: string): Resp {
  return { status, body: { message } };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export function repoShape(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.origin}/${VIEWER_LOGIN}/${repo.name}`,
    url: `${ctx.origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    created_at: ctx.store.stamp(repo.seq),
    updated_at: ctx.store.stamp(repo.seq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueShape(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l ? l.color : 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    html_url: `${ctx.origin}/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    comments_url: `${ctx.origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}/comments`,
    created_at: ctx.store.stamp(issue.seq),
    updated_at: ctx.store.stamp(issue.seq),
    comments: issue.comments.length,
  };
}

export function pullShape(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    html_url: `${ctx.origin}/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    created_at: ctx.store.stamp(pull.seq),
    updated_at: ctx.store.stamp(pull.seq),
  };
}

export function userShape(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    html_url: `https://github.com/${VIEWER_LOGIN}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.repos.get(name) ?? null;
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, items: T[], url: URL, query: URLSearchParams): Resp {
  const { page, perPage } = parsePagination(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.ceil(total / perPage);
  if (page < totalPages) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers['Link'] = `<${next.toString()}>; rel="next"`;
  }
  return json(200, slice, headers);
}

// Resolve a ref name (branch, full ref, or sha) to a commit oid.
function resolveRef(repo: Repo, ref?: string | null): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      return m ? m[1] : null;
    }
  }
  return null;
}

// Commit a new file state onto a branch. `files` maps path -> content Buffer.
// Returns the new commit oid.
export function commitFiles(
  ctx: Ctx, repo: Repo, branch: string, files: Map<string, Buffer>, message: string,
): string {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  let fileMap = new Map<string, string>();
  const parents: string[] = [];
  if (tip) {
    const info = parseCommit(repo.objects.get(tip)!.data);
    fileMap = filesFromTree(repo, info.tree);
    parents.push(tip);
  } else if (repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
    // New branch forks the default branch.
    const dtip = repo.refs.get(`refs/heads/${repo.defaultBranch}`)!;
    const info = parseCommit(repo.objects.get(dtip)!.data);
    fileMap = filesFromTree(repo, info.tree);
    parents.push(dtip);
  }
  const newMap = new Map<string, Buffer | string>(fileMap);
  for (const [path, content] of files) {
    if (content === null) newMap.delete(path);
    else newMap.set(path, content);
  }
  const treeOid = treeFromFiles(repo, newMap as Map<string, Buffer | string>);
  const commitOid = storeObject(repo, 'commit', buildCommit(treeOid, parents, message));
  repo.refs.set(refName, commitOid);
  return commitOid;
}

// PR conflict check: a file the PR changes (vs its base) was also changed on
// the base branch since PR creation.
export function prConflict(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return false;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const prBaseFiles = filesFromTree(repo, parseCommit(repo.objects.get(pull.baseSha)!.data).tree);
  const headFiles = filesFromTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const curBaseFiles = filesFromTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const changed = diffFiles(repo, prBaseFiles, headFiles);
  for (const c of changed) {
    const prBase = prBaseFiles.get(c.path);
    const cur = curBaseFiles.get(c.path);
    const head = headFiles.get(c.path);
    if (cur !== prBase && cur !== head) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(ctx: Ctx, method: string, path: string, query: URLSearchParams, url: URL, body: unknown): Resp {
  const segs = path.split('/').filter((s) => s.length > 0);
  // path is under /api/v3
  const rest = segs.slice(2); // after 'api','v3'

  // GET /api/v3/ and /api/v3
  if (rest.length === 0) {
    if (method === 'GET') {
      return json(200, {
        current_user_url: `${ctx.origin}/api/v3/user`,
        rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }

  // /api/v3/user...
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') return json(200, userShape());
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = [...ctx.store.repos.values()].sort((a, b) => a.id - b.id);
        return paginate(ctx, repos.map((r) => repoShape(ctx, r)), url, query);
      }
      if (method === 'POST') {
        const b = body as Record<string, unknown> | null;
        if (!b || typeof b.name !== 'string' || b.name.length === 0) return err(422, 'name is required');
        if (ctx.store.repos.has(b.name)) return err(422, 'already exists');
        const repo = ctx.store.createRepo(b.name, typeof b.description === 'string' ? b.description : '', b.private === true);
        return json(201, repoShape(ctx, repo));
      }
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = getRepo(ctx, owner, name);
    if (!repo) return err(404, 'Not Found');
    const sub = rest.slice(3);

    // Repo itself
    if (sub.length === 0) {
      if (method === 'GET') return json(200, repoShape(ctx, repo));
      if (method === 'PATCH') {
        const b = body as Record<string, unknown> | null;
        if (b && typeof b.description === 'string') repo.description = b.description;
        return json(200, repoShape(ctx, repo));
      }
      if (method === 'DELETE') {
        ctx.store.repos.delete(name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // git/refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'POST' && sub.length === 2) {
        const b = body as Record<string, unknown> | null;
        if (!b || typeof b.ref !== 'string' || typeof b.sha !== 'string') return err(422, 'ref and sha are required');
        if (!repo.objects.has(b.sha)) return err(422, 'object does not exist');
        repo.refs.set(b.ref, b.sha);
        return json(201, { ref: b.ref, object: { sha: b.sha } });
      }
      if (method === 'GET' && sub.length >= 3) {
        const refName = 'refs/' + sub.slice(2).join('/');
        const oid = repo.refs.get(refName);
        if (!oid) return err(404, 'Not Found');
        return json(200, { ref: refName, object: { sha: oid } });
      }
      return err(404, 'Not Found');
    }

    // branches
    if (sub[0] === 'branches') {
      if (method === 'GET' && sub.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)! } }));
        return json(200, list);
      }
      if (method === 'GET' && sub.length === 2) {
        const oid = repo.refs.get(`refs/heads/${sub[1]}`);
        if (!oid) return err(404, 'Not Found');
        return json(200, { name: sub[1], commit: { sha: oid } });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (sub[0] === 'commits' && method === 'GET') {
      const tip = resolveRef(repo, query.get('sha'));
      if (!tip) return err(404, 'Not Found');
      const history = commitHistory(repo, tip).map((oid) => {
        const info = parseCommit(repo.objects.get(oid)!.data);
        return {
          sha: oid,
          commit: {
            message: info.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          },
          author: { login: VIEWER_LOGIN, id: VIEWER_ID },
          committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
        };
      });
      return paginate(ctx, history, url, query);
    }

    // contents
    if (sub[0] === 'contents') {
      const filePath = sub.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (!tip) return err(404, 'Not Found');
        const files = filesFromTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const blobOid = files.get(filePath);
        if (blobOid) {
          const content = blobBytes(repo, blobOid)!;
          return json(200, {
            type: 'file', encoding: 'base64', name: filePath.split('/').pop(),
            path: filePath, sha: blobOid, size: content.length,
            content: content.toString('base64'),
          });
        }
        // directory?
        const prefix = filePath === '' ? '' : filePath + '/';
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [p, oid] of files) {
          if (filePath !== '' && !p.startsWith(prefix)) continue;
          const rest2 = filePath === '' ? p : p.slice(prefix.length);
          const first = rest2.split('/')[0];
          if (!first) continue;
          const childPath = filePath === '' ? first : `${filePath}/${first}`;
          if (rest2.includes('/')) {
            if (!children.has(childPath)) children.set(childPath, { type: 'dir', name: first, path: childPath, sha: '' });
          } else {
            children.set(childPath, { type: 'file', name: first, path: childPath, sha: oid });
          }
        }
        if (children.size > 0) {
          return json(200, [...children.values()].sort((a, b) => a.name.localeCompare(b.name)));
        }
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        const b = body as Record<string, unknown> | null;
        if (!b || typeof b.message !== 'string' || typeof b.content !== 'string') return err(422, 'message and content are required');
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const files = tip ? filesFromTree(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, string>();
        const currentOid = files.get(filePath);
        if (b.sha !== undefined && b.sha !== null) {
          if (!currentOid || currentOid !== b.sha) return err(409, 'sha does not match the current blob');
        }
        const content = Buffer.from(b.content, 'base64');
        const isCreate = !currentOid;
        const commitOid = commitFiles(ctx, repo, branch, new Map([[filePath, content]]), b.message);
        const blobOid = hashOfBlob(content);
        return json(isCreate ? 201 : 200, {
          content: { sha: blobOid, encoding: 'base64', name: filePath.split('/').pop(), path: filePath, size: content.length },
          commit: { sha: commitOid, message: b.message },
        });
      }
      if (method === 'DELETE') {
        const b = body as Record<string, unknown> | null;
        if (!b || typeof b.message !== 'string' || typeof b.sha !== 'string') return err(422, 'message and sha are required');
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return err(404, 'Not Found');
        const files = filesFromTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const currentOid = files.get(filePath);
        if (!currentOid) return err(404, 'Not Found');
        if (currentOid !== b.sha) return err(409, 'sha does not match the current blob');
        // Delete by committing a tree without the file.
        const newFiles = new Map<string, Buffer | string>(files);
        newFiles.delete(filePath);
        const treeOid = treeFromFiles(repo, newFiles);
        const commitOid = storeObject(repo, 'commit', buildCommit(treeOid, [tip], b.message));
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        return json(200, { commit: { sha: commitOid, message: b.message } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (sub[0] === 'labels') {
      if (method === 'POST') {
        const b = body as Record<string, unknown> | null;
        if (!b || typeof b.name !== 'string') return err(422, 'name is required');
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        repo.labels.set(b.name, { name: b.name, color });
        return json(201, { name: b.name, color });
      }
      if (method === 'GET') {
        return json(200, [...repo.labels.values()]);
      }
      return err(404, 'Not Found');
    }

    // issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'POST') {
          const b = body as Record<string, unknown> | null;
          if (!b || typeof b.title !== 'string' || b.title.length === 0) return err(422, 'title is required');
          const labels: string[] = Array.isArray(b.labels) ? b.labels.map(String) : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) return err(422, `label does not exist: ${l}`);
          }
          const seq = ctx.store.tick();
          const issue: Issue = {
            id: ctx.store.nextIssueId++,
            number: repo.nextNumber++,
            title: b.title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            labels,
            comments: [],
            seq,
          };
          repo.issues.push(issue);
          return json(201, issueShape(ctx, repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          }
          return paginate(ctx, list.map((i) => issueShape(ctx, repo, i)), url, query);
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(sub[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return err(404, 'Not Found');
      if (sub.length === 2) {
        if (method === 'GET') return json(200, issueShape(ctx, repo, issue));
        if (method === 'PATCH') {
          const b = body as Record<string, unknown> | null;
          if (b && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          if (b && typeof b.title === 'string') issue.title = b.title;
          if (b && typeof b.body === 'string') issue.body = b.body;
          return json(200, issueShape(ctx, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (sub[2] === 'comments') {
        if (method === 'POST') {
          const b = body as Record<string, unknown> | null;
          if (!b || typeof b.body !== 'string') return err(422, 'body is required');
          const seq = ctx.store.tick();
          const comment = { id: ctx.store.nextCommentId++, body: b.body, seq };
          issue.comments.push(comment);
          return json(201, {
            id: comment.id, body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID },
            created_at: ctx.store.stamp(seq), updated_at: ctx.store.stamp(seq),
          });
        }
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => ({
            id: c.id, body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID },
            created_at: ctx.store.stamp(c.seq), updated_at: ctx.store.stamp(c.seq),
          })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'POST') {
          const b = body as Record<string, unknown> | null;
          if (!b || typeof b.head !== 'string' || typeof b.base !== 'string' || typeof b.title !== 'string') {
            return err(422, 'head, base and title are required');
          }
          const headTip = repo.refs.get(`refs/heads/${b.head}`);
          const baseTip = repo.refs.get(`refs/heads/${b.base}`);
          if (!headTip || !baseTip) return err(422, 'head or base branch does not exist');
          const seq = ctx.store.tick();
          const pull: Pull = {
            id: ctx.store.nextPullId++,
            number: repo.nextNumber++,
            title: b.title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef: b.head,
            baseRef: b.base,
            headSha: headTip,
            baseSha: baseTip,
            seq,
          };
          repo.pulls.push(pull);
          return json(201, pullShape(ctx, repo, pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          return paginate(ctx, list.map((p) => pullShape(ctx, repo, p)), url, query);
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(sub[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return err(404, 'Not Found');
      if (sub.length === 2) {
        if (method === 'GET') return json(200, pullShape(ctx, repo, pull));
        return err(404, 'Not Found');
      }
      if (sub[2] === 'files' && method === 'GET') {
        const baseFiles = filesFromTree(repo, parseCommit(repo.objects.get(pull.baseSha)!.data).tree);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const headFiles = filesFromTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
        const changes = diffFiles(repo, baseFiles, headFiles).filter((c) => c.status !== 'removed');
        return json(200, changes.map((c) => ({
          filename: c.path, status: c.status, additions: c.additions, deletions: c.deletions, changes: c.additions + c.deletions,
        })));
      }
      if (sub[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') return err(405, 'pull request is not open');
        if (prConflict(repo, pull)) return err(405, 'merge conflict');
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const prBaseFiles = filesFromTree(repo, parseCommit(repo.objects.get(pull.baseSha)!.data).tree);
        const headFiles = filesFromTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
        const curBaseFiles = filesFromTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
        const merged = new Map<string, Buffer | string>(curBaseFiles);
        const changes = diffFiles(repo, prBaseFiles, headFiles);
        for (const c of changes) {
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
        return json(200, { merged: true, sha: mergeOid, message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function hashOfBlob(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'ascii');
  return createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}
