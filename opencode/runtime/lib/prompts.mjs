// personal-profile runtime — staged prompt filtering (Council upstream policy).
//
// Decision e000070 (user, 2026-10-01): Council returns to upstream behavior.
// The candidate must NOT carry the private Council prompt replacements, and
// the sources under dotfiles stay byte-identical — nothing outside runtime/**
// is modified by this lane.
//
// Phase-1 follow-upstream (plan upstream-defaults-20261006, 2026-10-06): the
// staged-copy transforms are RETIRED. The former Council prune of
// orchestrator_append.md and the v2 task_id→sessionID translation of
// orchestrator.md were removed: prompt content policy lives in the prompt
// sources themselves, staged copies are byte-identical, and the obsolete
// anchors no longer gate installs of missing or replaced builtin prompt
// files. Custom/native vocabulary is preserved untouched — BCP session_id
// identifiers and manifest/metadata task_id fields were never renamed by this
// lane and no blanket rewrites exist now.
//
// Excluded from the candidate entirely:
//   - council.md / council_append.md — private Council prompt replacements;
//     upstream OMO 3.0.1 ships its own Council guidance and must stand
//     unmodified in staged artifacts.
//   - any *.bak-promptopt            — prompt-optimization backups, never
//     release material.

export const EXCLUDED_PROMPT_FILES = new Set(["council.md", "council_append.md"]);
export const EXCLUDED_PROMPT_SUFFIX = ".bak-promptopt";

export function isExcludedPromptFile(relPath) {
  const base = relPath.split("/").pop();
  return EXCLUDED_PROMPT_FILES.has(base) || base.endsWith(EXCLUDED_PROMPT_SUFFIX);
}
