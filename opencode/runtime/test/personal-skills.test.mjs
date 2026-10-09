// Migration contract for user-owned skills: complete trees, executable
// helpers, relocation, both host stages, repeat installation and rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadProfile } from '../lib/inputs.mjs';
import { stage, STOCK_INHERITED_SKILLS } from '../lib/stage.mjs';
import { activate, rollback, verifyCandidateAgainstManifest } from '../lib/activate.mjs';
import { sha256File } from '../lib/hash.mjs';

const runtime = join(import.meta.dirname, '..');
const names = ['executing-plans', 'writing-plans', 'grilling-companion', 'guided-grilling'];
const helpers = ['plan-workspace', 'review-package', 'task-brief', 'task-done', 'task-start'];
function inventory(root, prefix = '') {
  return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return Object.entries(inventory(root, rel + '/'));
    return [[rel, { sha256: sha256File(join(root, rel)), mode: statSync(join(root, rel)).mode & 0o777 }]];
  }));
}

for (const flavor of ['v1', 'v2']) {
  test(`${flavor}: all generated skills, personal compositions and plan helpers survive staged relocation, install, reinstall and rollback`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'oprofile-plan-skills-'));
    try {
      const pinned = loadProfile(join(runtime, 'profile.json'));
      const omo = join(temp, 'omo');
      for (const entry of ['index/dist/index.js', 'server/dist/server/index.js']) {
        mkdirSync(join(omo, entry, '..'), { recursive: true });
        writeFileSync(join(omo, entry), 'export default {};\n');
      }
      for (const name of STOCK_INHERITED_SKILLS) {
        const dir = join(omo, 'server/src/skills', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
      }
      const vg = join(temp, 'vg');
      mkdirSync(vg);
      writeFileSync(join(vg, 'index.js'), 'export default {};\n');
      writeFileSync(join(vg, 'v2-plugin.mjs'), 'export default {};\n');
      const bcp = join(temp, 'bcp.ts');
      writeFileSync(bcp, 'export default {};\n');
      const result = stage({ ...pinned, flavor,
        host: { flavor, version: flavor === 'v1' ? '1.18.33' : '2.0.20', executable: 'test://host' },
        outDir: join(temp, 'staging'), explicit: {
          [flavor === 'v1' ? 'omoPluginV1' : 'omoPlugin']: omo,
          [flavor === 'v1' ? 'vibeguardV1' : 'vibeguardV2']: vg, bcpPlugin: bcp,
        } });
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
          else assert.equal(existsSync(skill), false, `${name}: v2 does not shadow the artifact`);
        }
        for (const name of names) assert.deepEqual(inventory(join(root, 'skills', name)), expected[name], `${name}: complete bytes and modes`);
        for (const helper of helpers) assert.equal(statSync(join(root, 'skills/executing-plans/scripts', helper)).mode & 0o777, 0o755);
      };
      checkTrees(candidate);
      for (const helper of helpers) {
        const path = `skills/executing-plans/scripts/${helper}`;
        assert.equal(result.manifest.files.find((file) => file.path === path).mode, '0755');
        execFileSync('bash', ['-n', join(candidate, path)]);
      }
      const live = join(temp, 'installed');
      mkdirSync(live);
      activate({ candidateDir: candidate, liveRoot: live });
      checkTrees(live);
      const firstAuthority = readFileSync(join(live, '.oprofile/active.json'));
      const again = activate({ candidateDir: candidate, liveRoot: live });
      assert.ok(again.files.every((file) => file.sha256Before === file.sha256After));
      checkTrees(live);

      // Direct execution exercises the shebang, permission bits and sibling
      // plan-workspace lookup after installation into an unrelated directory.
      const project = join(temp, 'project with spaces');
      mkdirSync(project);
      execFileSync('git', ['init', '--quiet', project]);
      const plan = join(project, 'migration.md');
      writeFileSync(plan, '# Migration\n\n### Task 1: Preserve skills\n\nKeep every companion.\n\n### Task 2: Later\n\nNot part of task 1.\n');
      execFileSync(join(live, 'skills/executing-plans/scripts/task-brief'), [plan, '1'], { cwd: project });
      const brief = readFileSync(join(project, '.plans/migration/task-1-brief.md'), 'utf8');
      assert.match(brief, /Keep every companion/);
      assert.doesNotMatch(brief, /Task 2/);
      const rolled = rollback({ liveRoot: live });
      assert.deepEqual(rolled.blocked, []);
      checkTrees(live); // undoing a repeat install restores the first install
      // The bounded owner procedure retains the preceding authority so a
      // second rollback can restore the original pre-install filesystem.
      writeFileSync(join(live, '.oprofile/active.json'), firstAuthority);
      assert.deepEqual(rollback({ liveRoot: live }).blocked, []);
      for (const name of names) for (const rel of Object.keys(expected[name])) assert.ok(!existsSync(join(live, 'skills', name, rel)));
      checkTrees(candidate);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
