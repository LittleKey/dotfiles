// personal-profile runtime — document-writer installer bridge.
//
// The personal lane and the generic document-writer installer can own the
// SAME agent surface (document-writer, lark-operator). This bridge detects the
// known ownership conflicts and reports them for a bounded, owner-approved
// generic-installer fix. It NEVER resolves a conflict by dropping either side
// and NEVER rewrites identifier vocabulary: BCP session_id values and
// metadata task_id identifiers pass through untouched — only the
// host delegation tool name is reported per flavor (v1 `task`, v2 `subagent`).
//
// Conflict catalogue (implementation brief §4):
// - MODEL-OWNERSHIP: dw overlay ships inheritModelFrom:"session" while the
//   personal OMO config pins an explicit model+variant for the same agent.
//   Combined output would carry both keys; the effective model is ambiguous.
//   Recommendation (bounded generic fix, needs owner approval): dw should
//   omit inheritModelFrom for agents the target config pins explicitly.
// - MODE-MISMATCH: dw renders lark-operator with mode:subagent hardcoded;
//   the personal agent requires mode:all (verified retention fixture).
//   Recommendation: make dw's rendered mode configurable per role.
// - PROMPT-AUTHORITY: dw owns .opencode/agent(s)/<role>.md with its own
//   prompt bodies while the personal OMO stack defines orchestratorPrompt and
//   the oh-my-opencode-slim prompt directory. Combined precedence with the
//   OMO plugin is NOT established (dw render.mjs states the same limit).
//   Report-only: no side is dropped.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DELEGATION_VOCAB = { v1: "task", v2: "subagent" };

function frontmatterField(md, field) {
  if (!md.startsWith("---")) return null;
  const parts = md.split("---", 3);
  if (parts.length < 3) return null;
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(parts[1]);
  return m ? m[1].trim() : null;
}

export function checkDw({ targetDir, flavor, personalOmoConfigPath }) {
  const conflicts = [];
  const manifestPath = join(targetDir, ".opencode", "document-writer-install.json");
  const dwManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  if (dwManifest) {
    conflicts.push({
      id: "DW-INSTALL-PRESENT",
      severity: "info",
      detail: `document-writer installation present: ${manifestPath} (schemaVersion ${dwManifest.schemaVersion ?? "?"})`,
      recommendation: "inspect combined ownership below; nothing is auto-changed",
    });
  }

  // personal model pins from the OMO config (verbatim personal values)
  let personalPins = {};
  if (personalOmoConfigPath && existsSync(personalOmoConfigPath)) {
    const omo = JSON.parse(readFileSync(personalOmoConfigPath, "utf8"));
    for (const id of ["document-writer", "lark-operator"]) {
      const a = omo.agents?.[id];
      if (a?.model) personalPins[id] = { model: a.model, variant: a.variant ?? null };
    }
  }

  const agentDirName = flavor === "v2" ? "agents" : "agent";
  const agentDir = join(targetDir, ".opencode", agentDirName);
  const renderedFiles = existsSync(agentDir) ? agentFiles(agentDir) : [];

  for (const [id, pin] of Object.entries(personalPins)) {
    if (dwManifest) {
      conflicts.push({
        id: "MODEL-OWNERSHIP",
        severity: "conflict",
        detail: `dw overlay declares inheritModelFrom:"session" for '${id}' (dw package oh-my-opencode-slim.json) while the personal config pins model ${JSON.stringify(pin.model)}${pin.variant ? ` variant ${JSON.stringify(pin.variant)}` : ""}; a merge would carry both keys and the effective model is ambiguous`,
        recommendation: "bounded generic-installer fix (owner approval required): omit inheritModelFrom when the target config pins an explicit model; the personal lane must not drop either side",
      });
    }
  }

  const larkFile = renderedFiles.find((f) => f.name === "lark-operator.md");
  if (larkFile) {
    const md = readFileSync(larkFile.path, "utf8");
    const mode = frontmatterField(md, "mode");
    if (mode && mode !== "all") {
      conflicts.push({
        id: "MODE-MISMATCH",
        severity: "conflict",
        detail: `dw-rendered ${agentDirName}/lark-operator.md has mode:${mode}; the personal agent requires mode:all (native-v2 retention fixture)`,
        recommendation: "bounded generic-installer fix (owner approval required): make rendered mode configurable per role",
      });
    }
    conflicts.push({
      id: "PROMPT-AUTHORITY",
      severity: "unresolved-acceptance",
      detail: `dw owns ${agentDirName}/lark-operator.md prompt body while the personal OMO stack provides prompt-dir bodies and orchestratorPrompt; combined precedence with the OMO plugin is not established`,
      recommendation: "owner decision; the personal lane stages its bodies in the candidate config root and does not touch project .opencode files",
    });
  }

  return {
    schemaVersion: 1,
    lane: "personal-profile",
    kind: "dw-bridge-report",
    flavor,
    delegationVocabulary: {
      host: DELEGATION_VOCAB[flavor] ?? null,
      note: "report-only; the bridge never rewrites BCP session_id or metadata task_id identifiers",
    },
    personalModelPins: personalPins,
    renderedAgentFiles: renderedFiles.map((f) => f.relPath),
    conflicts,
    pass: conflicts.every((c) => c.severity === "info"),
  };
}

function agentFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push({ name: entry.name, path: join(dir, entry.name), relPath: `.opencode/${dir.split("/").pop()}/${entry.name}` });
    }
  }
  return out;
}
