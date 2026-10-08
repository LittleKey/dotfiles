---
name: writing-plans
description: Use when you are the workflow owner (typically the Orchestrator) and need to structure a multi-step task into a work plan — a work graph of tasks, dependencies, owners, deliverables, and acceptance criteria — before executing it
---

# Writing Plans

## Overview

Turn requirements and confirmed context into a work graph owned and maintained by the Orchestrator. The plan describes the work; execution follows separately. DRY. YAGNI.

**Default output: a short work graph, not a long document.** For most tasks the whole plan fits in the Orchestrator's Todo/working notes:

- **Goal** — one sentence.
- **Scope** — what is in, what is explicitly out.
- **Tasks** — each task is the smallest unit that carries its own verification cycle and stands or falls on its own.
- **Dependencies** — what each task consumes from earlier tasks or existing code; what it produces for later tasks (exact interfaces/signatures so tasks stay self-contained).
- **Owners** — which agent/lane executes each task.
- **Deliverables** — what each task produces.
- **Acceptance** — how each deliverable is verified (the concrete check, not a vague "test it").

Persist a plan to a file (`docs/plans/...` or the path the Orchestrator chooses) **only** when a durable handoff is genuinely required — e.g. handing off to a long-running process, or the task is large enough that context alone cannot hold it. Simple tasks do not trigger the full template. Persisting to a file does not change the plan's nature: it remains internal execution state, not a document deliverable. Document routing: internal plans belong to the Orchestrator (workflow owner); formal plan documents written for human readers belong to the writer (`document-writer`) — hand the writer the internal plan as source material rather than authoring the reader-facing document yourself. Exception: tiny mechanical edits to an existing formal document (typo, formatting, status flip) may be made directly without the writer. For long-running tasks, prefer the existing `.slim/deepwork/` state mechanism; file location or directory name never determines whether a plan is internal state or a formal deliverable.

## Task decomposition

- Design units with clear boundaries and well-defined interfaces; each file/unit has one clear responsibility.
- Fold setup, configuration, scaffolding, and documentation steps into the task whose deliverable needs them; split only where one task could fail verification while its neighbor passes.
- In existing codebases, follow established patterns. Label what the requirements already fix as confirmed; label your own choices as proposals to confirm.

## Step granularity

Each step is one concrete, checkable action sized to its deliverable, not a fixed time budget — e.g. "write the failing test / run it to make sure it fails / implement the minimal code / run the tests and make sure they pass". Adapt the cycle to the deliverable's real verification (a config change might be "edit file" + "reload and probe"). Every task ends in concrete, checkable verification.

## Detail level

Pin down behavior, interfaces, constraints, and acceptance criteria precisely. Include code **only where it removes ambiguity** — key algorithms, tricky logic, exact signatures a later task depends on. Do not force-write every line of implementation up front; for existing functions a precise reference by path and symbol is enough. Commands and expected outcomes in verification steps must match the target project's actual tooling.

## No placeholders

These are plan failures — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without what the tests must verify)
- "Similar to Task N" without the exact differences
- Steps that describe what to do without the details needed to check the result

If a step depends on a required decision that was not supplied and cannot be derived from confirmed context, stop and surface the gap rather than inventing one.

## Self-check

Before executing, run this checklist on your own plan:

1. **Coverage:** can you point each requirement to a task that implements it? List gaps.
2. **Placeholder scan:** any red flag from "No placeholders" above.
3. **Consistency:** do interfaces/signatures later tasks use match what earlier tasks defined? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.
4. **Verification:** does every task end in a concrete check, and does every material risk have a task whose verification exercises it?

Fix issues found. If the plan is large, re-read it as saved and rerun the affected checks against the file.

## Execution

The Orchestrator drives the plan through dependency-based dispatch, Todo tracking, and updates based on verified facts (see `executing-plans`). High-risk design decisions may receive an independent Oracle review.
