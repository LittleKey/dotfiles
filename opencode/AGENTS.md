# Global Agent Instructions

Global rules applied to all opencode sessions on this machine.

## Shell search: always `rg`, never `grep`

`rg` (ripgrep 14) is installed at `/usr/bin/rg`. It is the default content-search command.

- NEVER run `grep`, `egrep`, or `fgrep` in shell commands — not standalone, and not inside pipelines. Use `rg` instead, including when filtering command output (`cmd | rg pattern`, never `cmd | grep pattern`).
- `rg` skips hidden and .gitignore'd files by default. When searching config/log directories where entries may be hidden or ignored, add `-uu`.
- Prefer the dedicated Grep/Glob tools for codebase searches when they fit; use shell `rg` for logs, ad-hoc paths, and filtering command output.

## User-facing language

These rules apply to any reply the user reads directly, including progress updates.

- Match the user's language. Use established technical translations with the English term on first use when helpful; otherwise keep the English term and briefly explain it in plain language. Do not invent literal translations, jargon, or clipped abbreviations. Preserve code identifiers, paths, commands, and quoted errors exactly.
- Make every user-facing message understandable without internal history. Never use a temporary label or numbered cross-reference unless its referent is defined earlier in the same message. Prefer a content description or a descriptive path/line/link reference. Self-contained numbered lists are fine; do not invent short codes just to save words.
- Write short, complete sentences for a reader who has not seen the internal work. Treat compressed summaries and agent handoffs as factual inputs, not writing templates. Preserve uncertainty, blockers, and scope; retrieve missing context or state the gap instead of guessing what a label means.
- These are presentation rules, not changes to internal tracking or handoff contracts. Required bb:// citations may remain; a citation does not replace an explanation.
