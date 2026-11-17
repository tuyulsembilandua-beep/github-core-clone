// store.ts — in-memory data model for the forge, plus pure git object helpers.
// Determinism: no wall-clock time, no randomness. Every created resource gets a
// timestamp derived from a monotonic sequence counter over a fixed epoch, so two
// runs driven with the same requests produce identical responses.
import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
// Fixed epoch for every timestamp the forge emits (2025-01-01T00:00:00Z).
export const EPOCH_MS = 1735689600000;
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const GIT_AUTHOR = 'ada iversen <adaiversen@example.invalid> 1735689600 +0000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  seq = 0;
  nextRepoId = 5000;
  nextIssueId = 100000;
  nextPullId = 200000;
  nextCommentId = 1000000;

  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  // Deterministic ISO timestamp for sequence n.
  stamp(n: number): string {
    return new Date(EPOCH_MS + n * 1000).toISOString();
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map([
        ['bug', { name: 'bug', color: 'd73a4a' }],
        ['enhancement', { name: 'enhancement', color: 'a2eeef' }],
        ['documentation', { name: 'documentation', color: '0075ca' }],
        ['question', { name: 'question', color: 'd876e3' }],
        ['good first issue', { name: 'good first issue', color: '7057ff' }],
        ['help wanted', { name: 'help wanted', color: '008672' }],
      ]),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }
}

// ---------------------------------------------------------------------------
// Git object helpers (pure functions over a repo's object map)
// ---------------------------------------------------------------------------

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

// Git tree sort order: entries sorted by name, directories as if named "name/".
export function compareTreeNames(a: string, b: string, aIsDir: boolean, bIsDir: boolean): number {
  const an = aIsDir ? a + '/' : a;
  const bn = bIsDir ? b + '/' : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(x.name, y.name, x.mode === '40000', y.mode === '40000'));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function buildCommit(tree: string, parents: string[], message: string): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${GIT_AUTHOR}\ncommitter ${GIT_AUTHOR}\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

export function buildTag(target: string, tagName: string, message: string): Buffer {
  const s = `object ${target}\ntype commit\ntag ${tagName}\ntagger ${GIT_AUTHOR}\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

// Build a tree object for a flat file map (path -> blob oid), storing all
// intermediate trees in the repo. Returns the root tree oid.
export function treeFromFiles(repo: Repo, files: Map<string, Buffer | string>): string {
  // files: path -> blob oid (string) or raw content (Buffer)
  const blobOid = (v: Buffer | string): string =>
    typeof v === 'string' ? v : storeObject(repo, 'blob', v);
  const byDir = new Map<string, Map<string, { mode: string; oid: string }>>();
  for (const [path, v] of files) {
    const parts = path.split('/');
    const name = parts[parts.length - 1];
    const dir = parts.slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    byDir.get(dir)!.set(name, { mode: '100644', oid: blobOid(v) });
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [];
    const direct = byDir.get(dir);
    if (direct) {
      for (const [name, f] of direct) entries.push({ mode: f.mode, name, oid: f.oid });
    }
    // subdirectories of dir
    const prefix = dir === '' ? '' : dir + '/';
    const subdirs = new Set<string>();
    for (const d of byDir.keys()) {
      if (d.startsWith(prefix) && d !== dir) {
        const rest = d.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) subdirs.add(first);
      }
    }
    for (const sub of subdirs) {
      const subDir = prefix + sub;
      entries.push({ mode: '40000', name: sub, oid: buildDir(subDir) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return buildDir('');
}

// Flat file map (path -> blob oid) for the tree at treeOid.
export function filesFromTree(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string) => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, e.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

export function blobBytes(repo: Repo, oid: string): Buffer | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return null;
  return obj.data;
}

// Is `anc` an ancestor of (or equal to) `desc`? Walks commit parents.
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// All commits reachable from `tip`, newest first (BFS by generation).
export function commitHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

export function countLines(buf: Buffer | null): string[] {
  if (!buf || buf.length === 0) return [];
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Diff two file maps (path -> blob oid). Line counts are naive set diffs.
export function diffFiles(repo: Repo, oldFiles: Map<string, string>, newFiles: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = oldFiles.get(path);
    const newOid = newFiles.get(path);
    if (oldOid === newOid) continue;
    const oldLines = countLines(oldOid ? blobBytes(repo, oldOid) : null);
    const newLines = countLines(newOid ? blobBytes(repo, newOid) : null);
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    let deletions = 0;
    for (const l of newLines) if (!oldSet.has(l)) additions += 1;
    for (const l of oldLines) if (!newSet.has(l)) deletions += 1;
    changes.push({
      path,
      status: !oldOid ? 'added' : !newOid ? 'removed' : 'modified',
      additions: !oldOid ? newLines.length : additions,
      deletions: !newOid ? oldLines.length : deletions,
    });
  }
  return changes;
}
