# Claude advisor project reads

Keep `oh-my-opencode-slim.json` → `acpAgents.claude` at `permissionMode: "reject"`
with no `cwd`: the guarded `acp_run` inherits each current session project,
including its `.opencode` evidence. This adds no authorization and does not
guarantee access against explicit denies, sensitive-file protections, or
symlinks outside the project.

Do not add auto-approval, fake `allowedTools`/`add-dir` CLI arguments, or external
cache directory allowlists. Project-external access needs separate authorization
and is not configured here. `reject` concerns new ACP permission requests, not
wrapper permissions; already allowed shell/edit operations remain allowed, so
a read-only task is not a read-only sandbox.

See the [source guard documentation](../../omo-coworkers/plugins/claude-advisor/README.md)
in the sibling OMO checkout for details and the focused regression command.
These are source-only conventions: no installation or actual Claude settings
change is needed.
