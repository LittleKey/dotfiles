// Migration contract for user-owned skills: complete trees, executable
// helpers, relocation, both host stages, repeat installation and rollback.
// The executing-plans and writing-plans personal skills were removed
// 2026-10-11; the relocation/install/rollback contract now runs against the
// remaining personal skills, and executable-helper coverage is preserved via
// a synthetic skill fixture instead of the removed plan helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync, rmSync, chmodSync, copyFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadProfile } from '../lib/inputs.mjs';
import { stage, STOCK_INHERITED_SKILLS } from '../lib/stage.mjs';
import { activate, rollback, verifyCandidateAgainstManifest } from '../lib/activate.mjs';
import { sha256File } from '../lib/hash.mjs';

const runtime = join(import.meta.dirname, '..');
// Remaining personal skills that are byte-identical between the maintained
// sources (opencode/skills) and the pinned generated tree.
const names = ['grilling-companion', 'guided-grilling', 'handoff'];
// Deliberately removed personal skills: they must never appear in any stage.
const REMOVED_SKILLS = ['executing-plans', 'writing-plans', 'eli5'];
// A remaining personal skill whose script carries an executable bit — real
// (non-synthetic) exec-mode preservation evidence.
const REAL_EXECUTABLE = 'skills/humanizer/scripts/validate-package.py';
function inventory(root, prefix = '') {
  return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return Object.entries(inventory(root, rel + '/'));
    return [[rel, { sha256: sha256File(join(root, rel)), mode: statSync(join(root, rel)).mode & 0o777 }]];
  }));
}

/** Host/plugin/bcp fixtures for stage(); returns the explicit-components object. */
function buildExplicit(temp, flavor) {
  const omo = join(temp, 'omo');
  for (const entry of ['dist/index.js', 'dist/server/index.js']) {
    mkdirSync(join(omo, entry, '..'), { recursive: true });
    writeFileSync(join(omo, entry), 'export default {};\n');
  }
  for (const name of STOCK_INHERITED_SKILLS) {
    const dir = join(omo, 'src/skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
  }
  writeFileSync(join(omo, 'src/skills/clonedeps/codemap.md'), 'fake codemap resource\n');
  const vg = join(temp, 'vg');
  mkdirSync(vg);
  writeFileSync(join(vg, 'index.js'), 'export default {};\n');
  const siblings = {};
  for (const name of ['claude-advisor-fixture', 'supervisor-fixture']) {
    const dir = join(temp, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.v1.mjs'), 'export default {};\n');
    writeFileSync(join(dir, 'index.js'), 'export default {};\n');
    siblings[name === 'claude-advisor-fixture' ? 'claudeAdvisor' : 'supervisor'] = dir;
  }
  const bcp = join(temp, 'bcp.ts');
  writeFileSync(bcp, 'export default {};\n');
  return {
    [flavor === 'v1' ? 'omoPluginV1' : 'omoPlugin']: omo,
    [flavor === 'v1' ? 'vibeguardV1' : 'vibeguardV2']: vg, bcpPlugin: bcp,
    ...siblings,
  };
}

function stagePinned(temp, flavor) {
  const pinned = loadProfile(join(runtime, 'profile.json'));
  const result = stage({ ...pinned, flavor,
    host: { flavor, version: flavor === 'v1' ? '1.18.33' : '2.0.20', executable: 'test://host' },
    outDir: join(temp, `staging-${flavor}`), explicit: buildExplicit(temp, flavor) });
  return { pinned, result };
}

for (const flavor of ['v1', 'v2']) {
  test(`${flavor}: all generated skills, personal compositions and remaining personal trees survive staged relocation, install, reinstall and rollback`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'oprofile-personal-skills-'));
    try {
      const { pinned, result } = stagePinned(temp, flavor);
      const candidate = join(temp, 'relocated');
      renameSync(result.candidateDir, candidate);
      assert.deepEqual(verifyCandidateAgainstManifest(candidate, result.manifest), []);
      const expected = Object.fromEntries(names.map((name) => [name, inventory(join(runtime, '../skills', name))]));
      const personal = inventory(pinned.profile.inputs.skillsDir.source);
      assert.deepEqual(Object.fromEntries(Object.entries(personal).map(([rel, file]) => [rel, file.sha256])), pinned.profile.inputs.skillsDir.files);
      const checkTrees = (root) => {
        for (const [rel, file] of Object.entries(personal)) {
          assert.equal(sha256File(join(root, 'skills', rel)), file.sha256, `${rel}: retained personal bytes`);
          assert.equal(statSync(join(root, 'skills', rel)).mode & 0o777, file.mode, `${rel}: retained personal mode`);
        }
        for (const name of STOCK_INHERITED_SKILLS) {
          const skill = join(root, 'skills', name, 'SKILL.md');
          if (flavor === 'v1') assert.equal(readFileSync(skill, 'utf8'), `# ${name}\n`, `${name}: original artifact bytes`);
          else assert.equal(readFileSync(skill, 'utf8'), `# ${name}\n`, `${name}: vendored artifact bytes via the skills/ link farm (v2.1.0 lists skills from config-dir files only — A7 smoke)`);
        }
        for (const name of names) assert.deepEqual(inventory(join(root, 'skills', name)), expected[name], `${name}: complete bytes and modes`);
        for (const removed of REMOVED_SKILLS) assert.equal(existsSync(join(root, 'skills', removed)), false, `${removed}: removed skill is never staged`);
        assert.equal(statSync(join(root, REAL_EXECUTABLE)).mode & 0o777, 0o755, 'remaining personal executable mode retained');
      };
      checkTrees(candidate);
      const helperRec = result.manifest.files.find((file) => file.path === REAL_EXECUTABLE);
      assert.equal(helperRec.mode, '0755', 'manifest records the remaining personal executable mode');
      const live = join(temp, 'installed');
      mkdirSync(live);
      activate({ candidateDir: candidate, liveRoot: live });
      checkTrees(live);
      const firstAuthority = readFileSync(join(live, '.oprofile/active.json'));
      const again = activate({ candidateDir: candidate, liveRoot: live });
      assert.ok(again.files.every((file) => file.sha256Before === file.sha256After));
      checkTrees(live);

      const rolled = rollback({ liveRoot: live });
      assert.deepEqual(rolled.blocked, []);
      checkTrees(live); // undoing a repeat install restores the first install
      // The bounded owner procedure retains the preceding authority so a
      // second rollback can restore the original pre-install filesystem.
      writeFileSync(join(live, '.oprofile/active.json'), firstAuthority);
      assert.deepEqual(rollback({ liveRoot: live }).blocked, []);
      for (const name of names) for (const rel of Object.keys(expected[name])) assert.ok(!existsSync(join(live, 'skills', name, rel)));
      for (const removed of REMOVED_SKILLS) assert.ok(!existsSync(join(live, 'skills', removed)), `${removed}: absent from the pre-install filesystem too`);
      checkTrees(candidate);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

for (const flavor of ['v1', 'v2']) {
  test(`${flavor}: removed personal skills are never staged; exactly the remaining expected personal skills persist`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'oprofile-removal-proof-'));
    try {
      const { pinned, result } = stagePinned(temp, flavor);
      const skillsRoot = join(result.candidateDir, 'skills');
      const tops = readdirSync(skillsRoot).sort();
      const expectedPersonalTops = [...new Set(Object.keys(pinned.profile.inputs.skillsDir.files).map((rel) => rel.split('/')[0]))].sort();
      assert.equal(expectedPersonalTops.length, 11, 'profile pins exactly 11 remaining personal skills');
      for (const removed of REMOVED_SKILLS) {
        assert.ok(!tops.includes(removed), `${removed}: not among staged skills/ entries`);
        assert.equal(result.manifest.files.some((f) => f.path.startsWith(`skills/${removed}/`)), false, `${removed}: no manifest record`);
        assert.equal(existsSync(join(skillsRoot, removed, 'SKILL.md')), false, `${removed}: not discoverable`);
      }
      for (const name of expectedPersonalTops) {
        assert.ok(existsSync(join(skillsRoot, name, 'SKILL.md')), `${name}: remaining personal skill persists in the stage`);
      }
      if (flavor === 'v2') {
        // v2 also vendors the artifact's stock skills as links (A7 smoke:
        // v2.1.0 lists skills from config-dir files only), so v2 differs
        // from v1 only in the omoPlugin staging dir name — same farm.
        for (const stock of STOCK_INHERITED_SKILLS) assert.ok(tops.includes(stock), `v2 link farm exposes ${stock}`);
        const personalTops = tops.filter((top) => !STOCK_INHERITED_SKILLS.includes(top) && top !== 'clonedeps').sort();
        assert.deepEqual(personalTops, expectedPersonalTops, 'v2 personal entries are exactly the pinned skills (stock links aside)');
      } else {
        // v1 additionally projects the artifact's stock skills as links.
        for (const stock of STOCK_INHERITED_SKILLS) assert.ok(tops.includes(stock), `v1 link farm exposes ${stock}`);
        const personalTops = tops.filter((top) => !STOCK_INHERITED_SKILLS.includes(top) && top !== 'clonedeps').sort();
        assert.deepEqual(personalTops, expectedPersonalTops, 'v1 personal entries are exactly the pinned skills (stock links aside)');
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

for (const flavor of ['v1', 'v2']) {
  test(`${flavor}: executable-helper mechanism survives staging via a synthetic personal skill (mode, manifest, shebang, sibling lookup)`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'oprofile-exec-fixture-'));
    try {
      // Synthetic personal skillsDir: the pinned personal bytes PLUS one
      // synthetic skill whose script exercises shebang, permission bits and
      // sibling-file lookup — the coverage the removed plan helpers carried.
      const synth = join(temp, 'skills-src');
      cpSync(join(runtime, 'generated/skills'), synth, { recursive: true });
      const demo = join(synth, 'demo-helper-skill');
      mkdirSync(join(demo, 'scripts'), { recursive: true });
      writeFileSync(join(demo, 'SKILL.md'), '---\nname: demo-helper-skill\ndescription: synthetic executable-helper fixture\n---\nbody\n');
      writeFileSync(join(demo, 'scripts/template.md'), '# Demo brief\n\nSynthetic sibling-lookup payload.\n');
      writeFileSync(join(demo, 'scripts/demo-helper'), '#!/usr/bin/env bash\nset -euo pipefail\nhere="$(cd "$(dirname "$0")" && pwd)"\ncat "$here/template.md" > "$1"\n');
      chmodSync(join(demo, 'scripts/demo-helper'), 0o755);
      const files = Object.fromEntries(Object.entries(inventory(synth)).map(([rel, file]) => [rel, file.sha256]));
      const pinned = loadProfile(join(runtime, 'profile.json'));
      pinned.profile.inputs.skillsDir = { kind: 'dir', source: synth, files };
      const result = stage({ ...pinned, flavor,
        host: { flavor, version: flavor === 'v1' ? '1.18.33' : '2.0.20', executable: 'test://host' },
        outDir: join(temp, 'staging'), explicit: buildExplicit(temp, flavor) });
      const candidate = join(temp, 'candidate');
      renameSync(result.candidateDir, candidate);
      assert.deepEqual(verifyCandidateAgainstManifest(candidate, result.manifest), []);
      const helperRel = 'skills/demo-helper-skill/scripts/demo-helper';
      assert.equal(statSync(join(candidate, helperRel)).mode & 0o777, 0o755, 'synthetic helper stages executable');
      assert.equal(result.manifest.files.find((file) => file.path === helperRel).mode, '0755', 'manifest records the executable mode');
      execFileSync('bash', ['-n', join(candidate, helperRel)]);

      const live = join(temp, 'installed');
      mkdirSync(live);
      activate({ candidateDir: candidate, liveRoot: live });
      assert.equal(statSync(join(live, helperRel)).mode & 0o777, 0o755, 'activation installs the executable bit');
      // Direct execution exercises the shebang, permission bits and sibling
      // file lookup after installation into an unrelated directory.
      const project = join(temp, 'project with spaces');
      mkdirSync(project);
      const outfile = join(project, 'brief.md');
      execFileSync(join(live, helperRel), [outfile], { cwd: project });
      assert.equal(readFileSync(outfile, 'utf8'), readFileSync(join(live, 'skills/demo-helper-skill/scripts/template.md'), 'utf8'), 'helper resolved its sibling template from the live root');
      // Rollback removes the synthetic skill's created files as part of the
      // pre-install filesystem (rollback removes files, not directories).
      assert.deepEqual(rollback({ liveRoot: live }).blocked, []);
      for (const rel of ['SKILL.md', 'scripts/demo-helper', 'scripts/template.md']) {
        assert.ok(!existsSync(join(live, 'skills', 'demo-helper-skill', rel)), `rollback removes the synthetic skill file ${rel}`);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
