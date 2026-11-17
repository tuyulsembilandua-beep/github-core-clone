// gitproto.ts — git smart HTTP: pkt-line codec, pack read/write, protocol v2
// and v0 advertisement / fetch / receive-pack, plus the object reachability
// logic the suite's fetch semantics need (haves, shallow boundaries, depth).
import { inflateSync, deflateSync } from 'node:zlib';
import {
  ZERO_OID,
  sha1, hashObject, storeObject, parseTree, parseCommit,
  filesFromTree,
} from './store.ts';
import type { Repo, GitObject, ObjectType } from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(s: string): Buffer {
  const payload = Buffer.from(s, 'utf8');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktParse {
  lines: string[];
  rest: Buffer;
  error?: string;
}

// Parse pkt-lines from the start of buf until a flush packet. Returns the
// data lines and the bytes after the flush.
export function parsePktLines(buf: Buffer): PktParse {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return { lines, rest: buf.subarray(off), error: `bad pkt-line length ${JSON.stringify(lenHex)}` };
    const len = parseInt(lenHex, 16);
    if (len === 0) return { lines, rest: buf.subarray(off + 4) };
    if (len === 1) { off += 4; continue; } // delim packet
    if (len < 4 || off + len > buf.length) return { lines, rest: buf.subarray(off), error: 'truncated pkt-line' };
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, rest: buf.subarray(off), error: 'no flush packet' };
}

export function encodePktLines(lines: string[]): Buffer {
  return Buffer.concat(lines.map(pktLine));
}

// ---------------------------------------------------------------------------
// Pack read / write
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

function readOfsVarint(buf: Buffer, off: number): { value: number; next: number } {
  let byte = buf[off];
  let value = byte & 0x7f;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i];
    value = ((value + 1) << 7) | (byte & 0x7f);
    i += 1;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const srcSize = readVarint(delta, off); off = srcSize.next;
  const dstSize = readVarint(delta, off); off = dstSize.next;
  if (srcSize.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) { cpOff |= delta[off++] << (8 * b); }
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) { cpSize |= delta[off++] << (8 * b); }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize.value) throw new Error('delta result size mismatch');
  return result;
}

// Parse a pack. `lookup` resolves ref-delta bases already in the store.
// Returns the objects found, keyed by oid.
export function readPack(buf: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n++) {
    const entryOff = off;
    const first = buf[off];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (buf[off - 1] & 0x80) {
      size |= (buf[off] & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    let baseObj: GitObject | undefined;
    if (typeCode === 6) {
      const ofs = readOfsVarint(buf, off);
      off = ofs.next;
      baseObj = byOffset.get(entryOff - ofs.value);
      if (!baseObj) throw new Error('ofs-delta base not found');
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      baseObj = objects.get(baseOid) ?? lookup(baseOid);
      if (!baseObj) throw new Error('ref-delta base not found');
    }
    const inflated = inflateSync(buf.subarray(off));
    // inflateSync consumes the whole remaining buffer; find the true length
    // by re-inflating with a bounded approach: use the known object size.
    const data = inflated.subarray(0, size);
    // Compute how many input bytes the deflate stream used.
    off = findDeflateEnd(buf, off);
    let obj: GitObject;
    if (typeCode === 6 || typeCode === 7) {
      const resolved = applyDelta(baseObj!.data, data);
      obj = { type: baseObj!.type, data: resolved };
    } else {
      obj = { type: CODE_TYPE[typeCode], data };
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entryOff, obj);
  }
  return objects;
}

// Find where a raw-deflate stream starting at `start` ends, by trial inflation.
function findDeflateEnd(buf: Buffer, start: number): number {
  // Binary search the smallest end that inflates without error and yields a
  // complete stream (inflateSync throws on truncation).
  let lo = start + 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

function writeVarintHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(writeVarintHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = sha1(body);
  return Buffer.concat([body, Buffer.from(trailer, 'hex')]);
}

// ---------------------------------------------------------------------------
// Object reachability (fetch selection)
// ---------------------------------------------------------------------------

export interface ReachResult {
  objects: Map<string, GitObject>;
  commits: Map<string, number>; // commit oid -> depth from a want (1 = want)
}

// Collect objects reachable from `roots`. `depth` limits commit generations
// (1 = roots only). `boundaries` are commits whose parents are never crossed
// (their own tree/blobs are still included).
export function reachable(repo: Repo, roots: string[], depth?: number, boundaries?: Set<string>): ReachResult {
  const objects = new Map<string, GitObject>();
  const commits = new Map<string, number>();
  const addTree = (treeOid: string) => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      const obj = repo.objects.get(oid);
      if (!obj || objects.has(oid)) continue;
      objects.set(oid, obj);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };
  const addCommitAndTree = (oid: string) => {
    const obj = repo.objects.get(oid);
    if (!obj || objects.has(oid)) return;
    objects.set(oid, obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      addTree(info.tree);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})$/m);
      if (m) addObject(m[1], 1);
    }
  };
  const addObject = (oid: string, depthFromWant: number) => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      if (commits.has(oid)) return;
      commits.set(oid, depthFromWant);
      addCommitAndTree(oid);
      if (boundaries && boundaries.has(oid)) return;
      if (depth !== undefined && depthFromWant >= depth) return;
      for (const p of parseCommit(obj.data).parents) addObject(p, depthFromWant + 1);
    } else if (obj.type === 'tag') {
      addCommitAndTree(oid);
    } else {
      objects.set(oid, obj);
    }
  };
  for (const root of roots) addObject(root, 1);
  return { objects, commits };
}

// ---------------------------------------------------------------------------
// Advertisement helpers
// ---------------------------------------------------------------------------

export function refLines(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) entry.peeled = m[1];
    }
    out.push(entry);
  }
  return out;
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

const UPLOAD_V0_CAPS = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// info/refs for git-upload-pack. `v2` when the client sent Git-Protocol: version=2.
export function advertiseUploadPack(repo: Repo, v2: boolean): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(FLUSH);
  if (v2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
  } else {
    parts.push(pktLine(`${refs[0].oid} HEAD\0${UPLOAD_V0_CAPS}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function advertiseReceivePack(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-receive-pack\n'));
  parts.push(FLUSH);
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    parts.push(pktLine(`${refs[0].oid} HEAD\0${RECEIVE_CAPS}\n`));
    for (const r of refs) parts.push(pktLine(`${r.oid} ${r.name}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v2: ls-refs
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const refs = refLines(repo);
  const head = headRefName(repo);
  const headOid = repo.refs.get(head);
  if (refs.length === 0) {
    if (unborn && (!prefixes.length || prefixes.some((p) => head.startsWith(p) || 'HEAD'.startsWith(p)))) {
      lines.push(`unborn HEAD symref-target:${head}\n`);
    }
  } else {
    const match = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (symrefs && headOid && match('HEAD')) {
      lines.push(`${headOid} HEAD symref-target:${head}\n`);
    }
    for (const r of refs) {
      if (!match(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      lines.push(line + '\n');
    }
  }
  return Buffer.concat([...lines.map(pktLine), FLUSH]);
}

// ---------------------------------------------------------------------------
// Protocol v2: fetch
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

export function parseV2FetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    const l = line.replace(/\n$/, '');
    if (l.startsWith('want ')) req.wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) req.shallow.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) req.depth = parseInt(l.slice(7).trim(), 10);
  }
  return req;
}

export function handleV2Fetch(repo: Repo, req: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(FLUSH);

  const oldShallow = new Set(req.shallow);
  const wantRes = reachable(repo, req.wants, req.depth, undefined);
  const heldRes = req.haves.length > 0
    ? reachable(repo, req.haves, undefined, oldShallow)
    : { objects: new Map<string, GitObject>(), commits: new Map<string, number>() };

  const toSend = new Map<string, GitObject>();
  for (const [oid, obj] of wantRes.objects) {
    if (!heldRes.objects.has(oid)) toSend.set(oid, obj);
  }

  // Shallow boundary bookkeeping.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (req.depth !== undefined) {
    for (const [oid, d] of wantRes.commits) {
      if (d === req.depth) {
        const info = parseCommit(repo.objects.get(oid)!.data);
        if (info.parents.length > 0) shallowOut.push(oid);
      }
    }
    for (const old of oldShallow) {
      if (wantRes.commits.has(old)) {
        const d = wantRes.commits.get(old)!;
        if (d < req.depth) unshallowOut.push(old);
      }
    }
  } else if (req.shallow.length > 0) {
    // No new depth: old boundaries that are still boundaries stay shallow.
    for (const old of oldShallow) {
      if (wantRes.commits.has(old)) shallowOut.push(old);
    }
  }
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const o of shallowOut) parts.push(pktLine(`shallow ${o}\n`));
    for (const o of unshallowOut) parts.push(pktLine(`unshallow ${o}\n`));
    parts.push(FLUSH);
  }

  parts.push(pktLine('packfile\n'));
  const pack = writePack([...toSend.values()]);
  // Sideband band 1, chunks small enough for pkt-line limits.
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const len = payload.length + 4;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v0: fetch (same pack builder, v0 framing)
// ---------------------------------------------------------------------------

export function handleV0Fetch(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let inHaves = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'done') break;
    if (line === '') { inHaves = true; continue; }
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-')) { /* deepen-since / deepen-not: unsupported, ignore */ }
  }
  void inHaves;
  const req: FetchRequest = { wants, haves, shallow, depth };
  const v2 = handleV2Fetch(repo, req);
  // Re-frame: v0 expects plain NAK/shallow lines then sideband pack packets.
  // Reuse the pack from the v2 response by rebuilding directly:
  const oldShallow = new Set(shallow);
  const wantRes = reachable(repo, wants, depth, undefined);
  const heldRes = haves.length > 0 ? reachable(repo, haves, undefined, oldShallow) : { objects: new Map<string, GitObject>(), commits: new Map<string, number>() };
  const toSend = new Map<string, GitObject>();
  for (const [oid, obj] of wantRes.objects) if (!heldRes.objects.has(oid)) toSend.set(oid, obj);
  const parts: Buffer[] = [pktLine('NAK\n')];
  if (depth !== undefined) {
    for (const [oid, d] of wantRes.commits) {
      if (d === depth) {
        const info = parseCommit(repo.objects.get(oid)!.data);
        if (info.parents.length > 0) parts.push(pktLine(`shallow ${oid}\n`));
      }
    }
    for (const old of oldShallow) {
      if (wantRes.commits.has(old) && wantRes.commits.get(old)! < depth) parts.push(pktLine(`unshallow ${old}\n`));
    }
  }
  const pack = writePack([...toSend.values()]);
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const len = payload.length + 4;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  parts.push(FLUSH);
  void v2;
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const parsed = parsePktLines(body);
  if (parsed.error) return { status: 400, body: Buffer.from('bad pkt-line stream', 'utf8') };
  const commands: PushCommand[] = [];
  for (const raw of parsed.lines) {
    const line = raw.replace(/\n$/, '');
    if (!line) continue;
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length < 3) return { status: 400, body: Buffer.from('bad command line', 'utf8') };
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const packBytes = parsed.rest;
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objs) repo.objects.set(oid, obj);
    } catch (e) {
      return { status: 400, body: Buffer.from(`bad pack: ${(e as Error).message}`, 'utf8') };
    }
  }
  const results: PushResult[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!current) {
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      continue;
    }
    if (cmd.oldOid === cmd.newOid) {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (isAncestorFast(repo, cmd.oldOid, cmd.newOid)) {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  const lines: string[] = ['unpack ok\n'];
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const payload = encodePktLines(lines);
  // Wrap in sideband band 1.
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < payload.length; off += CHUNK) {
    const chunk = payload.subarray(off, Math.min(off + CHUNK, payload.length));
    const band = Buffer.concat([Buffer.from([1]), chunk]);
    const len = band.length + 4;
    out.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), band]));
  }
  out.push(FLUSH);
  return { status: 200, body: Buffer.concat(out) };
}

function isAncestorFast(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

export { filesFromTree, storeObject };
