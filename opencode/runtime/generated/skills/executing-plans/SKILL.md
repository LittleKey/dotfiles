---
name: executing-plans
description: Use when you have a work plan or approved plan document and need to execute it — dispatching lanes by dependency, tracking progress, and verifying deliverables
---

# Executing Plans

## Overview

Execute a work plan as a scheduling protocol: read it critically, dispatch work by dependency rather than document order, track progress in the Orchestrator's Todo, and verify every deliverable. The plan is a living map owned by the workflow owner (typically the Orchestrator) — it may be revised as verified facts change.

## Step 1: Load and Review

1. Read the plan in full.
2. Review critically: unclear instructions, missing context, steps that contradict the code, verifications that cannot run.
3. Raise concerns before starting. If the plan changes, re-read it before continuing.
4. Mirror the plan into the existing Todo: one item per task plus a final verification item; append genuinely new tasks to the end of the running Todo and reuse existing entries, preserving their order, status, and priority — never wipe unrelated tasks, and do not maintain two continuously synchronized authority states (Todo and document checkboxes). The Todo is the execution state; a persisted plan document is a snapshot, not a second tracker. Do not mark anything `in_progress` merely because the plan was loaded: start a task only when both its dependencies are satisfied and it is next in the current scheduling order.

## Step 2: Execute Tasks

Dispatch by dependency, not by document order:

1. For each task whose dependencies are satisfied and whose position in the current scheduling order allows it, assign its owner and mark the Todo `in_progress`. Independent lanes within the same selected work item may run in parallel when their write scopes do not conflict; a later-appended separate work item waits for the current in-progress task unless that task is blocked or the user explicitly reorders.
2. Each non-trivial dispatch names the acceptance owner, the check method, and the completion condition.
3. Capture real output; never claim a verification you did not run. For red/green checkpoints, confirm the stated failure before implementing and the stated pass afterwards.
4. If a step cannot work verbatim (wrong signature, missing import, fixture mismatch), apply the minimal correction that preserves the plan's intent and record the deviation.
5. Mark the Todo item `completed` only after its acceptance check passes.

## Step 3: Finish

- After all tasks, run the plan's final verification while reusing evidence that is still valid: a check that already passed and whose inputs are unchanged since does not need a repeat run. Re-run only checks that are stale (their inputs changed), were never run, or have no recorded evidence.
- Report: files changed with locations, exact commands run and observed results, deviations with reasons, blockers, residual uncertainty.
- If the plan requires independent review or the risk warrants it, hand the artifact to a reviewer; do not self-approve.
- Integration gate: only when actual integration is about to happen — the user asked to integrate or ship the work — present the options (merge locally / push and open a PR / keep as-is / discard) and wait for an explicit choice. Do not raise the integration question when no integration is requested. Never commit, push, open a PR, or delete work without an explicit user request; commits require user authorization.
- Worktree integration and cleanup follow the `worktrees` skill (Phases 3 and 4); do not run a second worktree protocol.

## When to Stop and Ask

Diagnose before escalating. When a failure or blocker appears, first diagnose it with what the plan and codebase provide: read the actual error, inspect the affected code, and attempt a bounded correction that stays inside the plan's intent (see Step 2.4). Do not hand a raw failure to the user before that diagnosis.

Escalate to the user only for:

- a genuine permission or authorization decision (commits, pushes, PRs, external access, deletions);
- a real design or scope choice the plan cannot resolve;
- a blocker that survives diagnosis and bounded retries — verification still failing after two genuine attempts, a plan gap that prevents starting, or plan expectations that conflict with the code.

Ask for a decision on the escalated items rather than improvising them.

## Rules

- Do not skip verifications or weaken an assertion to make a checkpoint pass.
- Do not start implementation before the task is tracked in the Todo.
- Do not expand scope beyond the plan; record discovered work instead of doing it.
- The plan is not frozen: the workflow owner may revise it as verified facts change (e.g. a task proves unnecessary, an interface shifts). Re-review the plan when a revision touches a major decision; record the deviation. Do not edit a formal plan document while executing it except via the owner's revision — if another owner is producing the document, route the change to that owner.
