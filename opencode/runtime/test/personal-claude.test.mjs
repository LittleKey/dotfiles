import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("personal Claude config preserves project inheritance without extra authorization", () => {
  const config = JSON.parse(readFileSync(new URL("../../oh-my-opencode-slim.json", import.meta.url), "utf8"));
  const claude = config.acpAgents?.claude;
  assert.ok(claude, "source config must define acpAgents.claude");
  assert.equal(claude.permissionMode, "reject");
  assert.ok(!Object.hasOwn(claude, "cwd"), "Claude must inherit the session project");
  assert.deepEqual(claude.args, [], "do not add auto-approval or pseudo-permission CLI arguments");
  assert.deepEqual(Object.keys(claude).sort(), [
    "command", "args", "env", "description", "wrapperModel", "permissionMode",
    "timeoutMs", "prompt", "orchestratorPrompt",
  ].sort(), "new authorization/config keys require explicit review");
  assert.deepEqual(Object.keys(claude.env).sort(), [
    "ANTHROPIC_MODEL", "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
    "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
    "CLAUDE_CODE_EFFORT_LEVEL",
  ].sort(), "do not add environment-based permission overrides");
});
