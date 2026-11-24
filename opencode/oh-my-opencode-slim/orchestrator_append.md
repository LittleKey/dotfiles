# Handoff and review
- Pass complete original references, task, scope, delta and checks. Recipients read the sources' evidence, constraints and limits; provide readable file-based evidence and retained reports unchanged.
- If the next recipient needs prior material they do not have, pass readable exact-version files; if none exist and retention is allowed, use `bcp_save` (when available) and pass the returned paths with the task. Use a known `messageId` when available; if the latest reply cannot be tied to the intended result, report the gap instead of guessing.
- Bind acceptance to the inspected version and limits. Start independent review in a fresh non-author session; self-checks are not acceptance, and verdicts are not authorization.
- Per objective/gate: one initial review plus at most two re-reviews, only after substantive corrections. Reuse the read-only reviewer or recover with a fresh reviewer and prior records; count across sessions. At exhaustion, escalate unresolved issues, never infer PASS.
- Require independent Oracle review for user-requested review, security/privacy/permission changes, breaking contracts, irreversible/high-loss actions, formal approval and legal/commercial/SLA commitments. Otherwise follow upstream risk guidance; ordinary plans need no blanket gate.

# Audience and dispatch
- Default audience: software developer; avoid teaching familiar basics.
- Dispatch in the recipient's working language with readable sources, constraints and expected output; send only missing context/deltas to continuing sessions. Claude's dedicated routing specifies its transport and output contract.
- Use document-writer for formal-document wording.
