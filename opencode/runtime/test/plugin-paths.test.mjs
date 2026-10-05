import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizePluginPaths } from '../lib/plugin-paths.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('installed entries become cwd-independent; only options-free auto entry is removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin paths '));
  try {
    mkdirSync(join(root, 'plugins/omo'), { recursive: true });
    writeFileSync(join(root, 'plugins/omo/index.js'), 'export default {}');
    writeFileSync(join(root, 'plugins/blackboard.ts'), 'export default {}');
    const config = { provider: { preserved: { options: { apiKey: 'synthetic-only' } } },
      plugin: ['./plugins/omo/index.js', './plugins/blackboard.ts', 'npm-plugin@1', ['./plugins/blackboard.ts', { option: true }]] };
    const result = normalizePluginPaths(config, root);
    assert.deepEqual(result.config.plugin, [join(root, 'plugins/omo/index.js'),
      'npm-plugin@1', [join(root, 'plugins/blackboard.ts'), { option: true }]]);
    assert.deepEqual(normalizePluginPaths({ plugin: [pathToFileURL(join(root, 'plugins/omo/index.js')).href] }, root).config.plugin,
      [join(root, 'plugins/omo/index.js')]);
    assert.equal(result.config.provider, config.provider);
    assert.deepEqual(result.removed, ['./plugins/blackboard.ts']);
    assert.equal(config.plugin.length, 4);
    const twice = normalizePluginPaths(result.config, root);
    assert.deepEqual(twice.config, result.config);
    assert.equal(twice.converted.length + twice.removed.length, 0);
    assert.throws(() => normalizePluginPaths({ plugin: ['./missing.js'] }, root), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('maintenance preserves private bytes, updates both authorities and rollback checkpoint, then is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-plugin-maintenance-'));
  const sha = b => createHash('sha256').update(b).digest('hex');
  const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    mkdirSync(join(root, 'plugins/omo'), { recursive: true });
    mkdirSync(join(root, '.oprofile'), { recursive: true });
    writeFileSync(join(root, 'plugins/omo/index.js'), 'export default {}');
    writeFileSync(join(root, 'plugins/blackboard.ts'), 'export default {}');
    const cfg = join(root, 'opencode.json'), authority = join(root, '.oprofile/active.json');
    const manifest = join(root, '.oprofile/profile-manifest.json'), handover = join(root, 'APPLIED.json');
    const original = { provider: { options: { apiKey: 'synthetic-only' } }, plugin: ['./plugins/omo/index.js', './plugins/blackboard.ts'] };
    write(cfg, original);
    const before = readFileSync(cfg), digest = sha(before);
    write(authority, { files: [{ path: 'opencode.json', sha256After: digest, backup: 'original-backup' }] });
    write(manifest, { files: [{ path: 'opencode.json', sha256: digest }] });
    write(handover, { extras: [{ path: manifest, mode: 0o600, sha256: sha(readFileSync(manifest)) }] });
    const cli = fileURLToPath(new URL('../bin/normalize-plugin-paths.mjs', import.meta.url));
    const args = [cli, '--root', root, '--handover-state', handover];
    const dry = JSON.parse(execFileSync(process.execPath, args));
    assert.equal(dry.apply, false);
    assert.deepEqual(readFileSync(cfg), before);
    const applied = JSON.parse(execFileSync(process.execPath, [...args, '--apply']));
    const bytes = readFileSync(cfg);
    assert.deepEqual(JSON.parse(bytes).provider, original.provider);
    assert.equal(JSON.parse(bytes).plugin.length, 1);
    assert.equal(statSync(cfg).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(authority)).files[0].sha256After, sha(bytes));
    assert.equal(JSON.parse(readFileSync(authority)).files[0].backup, 'original-backup');
    assert.equal(JSON.parse(readFileSync(manifest)).files[0].sha256, sha(bytes));
    assert.equal(JSON.parse(readFileSync(handover)).extras[0].sha256, sha(readFileSync(manifest)));
    assert.deepEqual(readFileSync(join(applied.backup, '0.json')), before);
    assert.equal(statSync(join(applied.backup, '0.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, [...args, '--apply'])), { changed: false });
    // Edited configurations are not silently adopted into the authority.
    write(cfg, { ...original, extra: true });
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /authority/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
