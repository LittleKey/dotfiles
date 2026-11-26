# Handoff and review
- Pass complete original references, task, scope, delta and checks. Recipients read the sources' evidence, constraints and limits; provide readable file-based evidence and retained reports unchanged.
- If the next recipient needs prior material they do not have, pass readable exact-version files; if none exist and retention is allowed, use `bcp_save` (when available) and pass the returned paths with the task. Use a known `messageId` when available; if the latest reply cannot be tied to the intended result, report the gap instead of guessing.
- Bind acceptance to the inspected version and limits. Start independent review in a fresh non-author session; self-checks are not acceptance, and verdicts are not authorization.
- Per objective/gate: one initial review plus at most two re-reviews, only after substantive corrections. Reuse the read-only reviewer or recover with a fresh reviewer and prior records; count across sessions. At exhaustion, escalate unresolved issues, never infer PASS.
- Require independent Oracle review for user-requested review, security/privacy/permission changes, breaking contracts, irreversible/high-loss actions, formal approval and legal/commercial/SLA commitments. Otherwise follow upstream risk guidance; ordinary plans need no blanket gate.

# Audience and dispatch

- For the current conversation only, default to a software-developer reader and avoid teaching familiar basics unless context says otherwise. Do not carry this default into artifacts for other readers.
- Dispatch in the recipient's working language with readable sources, constraints and expected output; send only missing context/deltas to continuing sessions. Claude's dedicated routing specifies its transport and output contract.
- Use document-writer for substantial reader-facing synthesis, audience adaptation, requested explanation/wording work and formal documents. Handle simple answers, status updates, clarifications and internal plans/state directly; do not make every reply pass through a writer.
- For writer work, supply MODE, PROFILE, reader and reading purpose, known background or explicit unknowns, output constraints, sources, protected meaning and authorization limits. Resolve reader/purpose from clear context or ask when unclear; label low-risk presentation assumptions, never invent reader traits. Keep the audience brief in task/handoff metadata, not the business body.
- Reuse a suitable author for revisions with current evidence and audience changes; use a fresh non-author session for independent review. COMMUNICATION is reply-only; maintained-document creation/body edits, replacement body and formal acceptance require FORMAL. An omitted profile means FORMAL; neither profile waives review, disclosure or publication gates.

# Search tools

- In shell commands, always use `rg` instead of `grep`/`grep -r` for file-content or recursive searches (common flags map directly: -i/-v/-n; recursion is rg's default behavior).
- Prefer the built-in `grep` tool when making tool calls (it is ripgrep itself); this rule only constrains shell commands.
- `rg` exits with code 1 on no match: add `|| true` or an explicit check inside `&&` chains or `set -e` scripts to avoid breaking the chain.
- Prefer `rg` when filtering piped output too (e.g. `cmd | rg foo`); plain GNU grep is acceptable but not recommended in pure pipe scenarios.
