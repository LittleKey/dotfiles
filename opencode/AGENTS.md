# Global Agent Instructions

Global rules applied to all opencode sessions on this machine.

## Shell search: always `rg`, never `grep`

`rg` (ripgrep 14) is installed at `/usr/bin/rg`. It is the default content-search command.

- NEVER run `grep`, `egrep`, or `fgrep` in shell commands — not standalone, and not inside pipelines. Use `rg` instead, including when filtering command output (`cmd | rg pattern`, never `cmd | grep pattern`).
- Common flags map directly: `-i`, `-v`, `-c`, `-l`, `-o`, `-n`, `-F`, `-A`, `-B`, `-C` all work in `rg`.
  - `grep -iE "pat" a.log b.log` → `rg -i "pat" a.log b.log` (extended regex is `rg`'s default)
  - `grep -r "pat" .` → `rg "pat"` (recursion is the default)
  - `grep "pat" file | head` → `rg -m 10 "pat" file` (or keep `| head`)
- `rg` skips hidden and .gitignore'd files by default. When searching config/log directories where entries may be hidden or ignored, add `-uu`.
- Prefer the dedicated Grep/Glob tools for codebase searches when they fit; use shell `rg` for logs, ad-hoc paths, and filtering command output.
