// personal-profile runtime — staged prompt filtering (Council upstream policy).
//
// Decision e000070 (user, 2026-10-01): Council returns to upstream behavior.
// The candidate must NOT carry the private Council prompt replacements, and
// the orchestrator's private Council scheduling requirements are removed from
// the STAGED COPY only — the sources under dotfiles stay byte-identical and
// nothing outside runtime/** is modified by this lane.
//
// Excluded from the candidate entirely:
//   - council.md / council_append.md — private Council prompt replacements;
//     upstream OMO 3.0.1 ships its own Council guidance and must stand
//     unmodified in staged artifacts.
//   - any *.bak-promptopt            — prompt-optimization backups, never
//     release material.
//
// Transformed in the staged copy only (anchor-verified; refuses on drift so a
// changed source is re-checked by a human instead of silently mis-staged):
//   - orchestrator_append.md: remove the Council adviser bullet and the
//     Council scheduling sentence; every other requirement (source-first,
//     independent review, budgets) is preserved exactly.
//   - orchestrator.md (v2 flavor only): the native task-resume instruction is
//     narrowed to v2 vocabulary — "pass its task_id explicitly" becomes
//     "pass its sessionID explicitly". BCP session_id identifiers and
//     manifest/metadata task_id fields are NEVER renamed anywhere.

export const EXCLUDED_PROMPT_FILES = new Set(["council.md", "council_append.md"]);
export const EXCLUDED_PROMPT_SUFFIX = ".bak-promptopt";

export function isExcludedPromptFile(relPath) {
  const base = relPath.split("/").pop();
  return EXCLUDED_PROMPT_FILES.has(base) || base.endsWith(EXCLUDED_PROMPT_SUFFIX);
}

// Exact anchors from the pinned orchestrator_append source. Pinning means the
// anchor either matches the pinned bytes or the input has drifted and staging
// already refused — these throws are the defense-in-depth backstop.
const COUNCIL_BULLET =
  "- Tool-restricted Council advisers return attributed findings and limits. Preserve attribution and input versions in your synthesis; distinguish restricted raw replies from accessible author records.\n";
const COUNCIL_SCHEDULE =
  " Council uses OMO's main-session dispatch to configured councillor seats followed by synthesis; do not select a single seat as an ordinary reviewer.";

export function pruneCouncil(text) {
  if (!text.includes(COUNCIL_BULLET)) {
    throw new Error("council prune: Council adviser bullet anchor not found — prompt source drifted; re-check the composition before staging");
  }
  if (!text.includes(COUNCIL_SCHEDULE)) {
    throw new Error("council prune: Council scheduling sentence anchor not found — prompt source drifted; re-check the composition before staging");
  }
  return text.replace(COUNCIL_BULLET, "").replace(COUNCIL_SCHEDULE, "");
}

const RESUME_V1 = "pass its task_id explicitly";
const RESUME_V2 = "pass its sessionID explicitly";

export function translateV2Resume(text) {
  if (!text.includes(RESUME_V1)) {
    throw new Error("v2 resume translate: native task-resume anchor not found — prompt source drifted; re-check the composition before staging");
  }
  return text.replace(RESUME_V1, RESUME_V2);
}

/**
 * Returns the transformation to apply to one staged prompt file, or null to
 * copy the file byte-identically. `flavor` is "v1" | "v2".
 */
export function transformPromptFile(relPath, flavor) {
  const base = relPath.split("/").pop();
  if (base === "orchestrator_append.md") {
    return { kind: "council-prune", apply: pruneCouncil };
  }
  if (base === "orchestrator.md" && flavor === "v2") {
    return { kind: "v2-sessionID-resume", apply: translateV2Resume };
  }
  return null;
}
