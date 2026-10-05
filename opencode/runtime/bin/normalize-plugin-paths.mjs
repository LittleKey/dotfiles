// Explicit maintenance, not host reload. Back up private bytes and retain the
// existing installation authority and original rollback baseline.
import { readFileSync, mkdirSync, statSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { normalizePluginPaths } from '../lib/plugin-paths.mjs';
import { atomicWriteFileSync } from '../lib/atomic.mjs';

const { values } = parseArgs({ options: {
  root: { type: 'string' }, apply: { type: 'boolean', default: false },
  'handover-state': { type: 'string' },
} });
if (!values.root) throw Error('Explicit --root <installed-config-root> required');
const root = resolve(values.root);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = obj => Buffer.from(JSON.stringify(obj, null, 2) + '\n');
const snapshots = new Map();
function read(path) {
  if (lstatSync(path).isSymbolicLink()) throw Error(`Refusing symlink: ${path}`);
  const bytes = readFileSync(path), mode = statSync(path).mode & 0o777;
  snapshots.set(path, { bytes, mode });
  return JSON.parse(bytes);
}
const configPath = join(root, 'opencode.json');
const current = read(configPath);
const result = normalizePluginPaths(current, root);
if (!result.converted.length && !result.removed.length) {
  console.log(JSON.stringify({ changed: false }));
} else {
  const oldHash = hash(snapshots.get(configPath).bytes), newBytes = json(result.config), newHash = hash(newBytes);
  const authorityPath = join(root, '.oprofile/active.json');
  const manifestPath = join(root, '.oprofile/profile-manifest.json');
  const authority = read(authorityPath), manifest = read(manifestPath);
  const active = authority.files.find(f => f.path === 'opencode.json');
  const pinned = manifest.files.find(f => f.path === 'opencode.json');
  if (!active || !pinned || active.sha256After !== oldHash || (pinned.sha256 ?? pinned.sourceSha256) !== oldHash)
    throw Error('Installed config differs from its authority; reconcile before maintenance');
  active.sha256After = newHash;
  pinned.sha256 = newHash;
  const note = { at: new Date().toISOString(), path: 'opencode.json',
    kind: 'plugin-path-normalization', before: oldHash, after: newHash };
  (authority.maintenance ??= []).push(note);
  (manifest.maintenance ??= []).push(note);
  const writes = new Map([[configPath, newBytes], [authorityPath, json(authority)], [manifestPath, json(manifest)]]);
  if (values['handover-state']) {
    const path = resolve(values['handover-state']), state = read(path);
    const extra = state.extras?.find(f => f.path === manifestPath);
    if (!extra || extra.sha256 !== hash(snapshots.get(manifestPath).bytes) || extra.mode !== snapshots.get(manifestPath).mode)
      throw Error('Handover manifest checkpoint differs; refusing to weaken rollback guard');
    extra.sha256 = hash(writes.get(manifestPath));
    (state.maintenance ??= []).push(note);
    writes.set(path, json(state));
  }
  const report = { changed: true, apply: values.apply, converted: result.converted, removed: result.removed };
  if (values.apply) {
    const backup = join(root, '.oprofile/backup', `plugin-paths-${Date.now()}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    let i = 0;
    const saved = [];
    for (const [path, snapshot] of snapshots) {
      if (hash(readFileSync(path)) !== hash(snapshot.bytes) || (statSync(path).mode & 0o777) !== snapshot.mode)
        throw Error(`File changed during preflight: ${path}`);
      const file = `${i++}.json`;
      atomicWriteFileSync(join(backup, file), snapshot.bytes, 0o600);
      saved.push({ path, file, sha256: hash(snapshot.bytes), mode: snapshot.mode });
    }
    atomicWriteFileSync(join(backup, 'BACKUP.json'), json({ files: saved }), 0o600);
    const applied = [];
    try {
      for (const [path, bytes] of writes) {
        atomicWriteFileSync(path, bytes, snapshots.get(path).mode);
        applied.push(path);
      }
    } catch (error) {
      for (const path of applied.reverse()) {
        const snapshot = snapshots.get(path);
        atomicWriteFileSync(path, snapshot.bytes, snapshot.mode);
      }
      throw error;
    }
    report.backup = backup;
  }
  console.log(JSON.stringify(report, null, 2));
}
