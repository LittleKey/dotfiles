---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write a self-contained implementation plan from the requirements and confirmed context the Orchestrator supplies. The plan must let an engineer with zero context on this task carry it out: goal, scope, requirements, relevant code, the concrete changes for each task, dependencies between tasks, and how each deliverable is verified. The plan describes implementation — it does not perform it. DRY. YAGNI.

**Save plans to:** the target path the Orchestrator supplies for this task. Use `docs/plans/YYYY-MM-DD-<feature-name>.md` only when the Orchestrator explicitly authorizes that default; otherwise return `NEEDS_CONTEXT`. User preferences for plan location override the authorized default.

## Scope Check

If the supplied requirements cover multiple independent subsystems, propose breaking this into separate plans — one per independent deliverable — to the Orchestrator, and only when each plan would produce working, verifiable software on its own. The Orchestrator decides the split; do not split on your own initiative.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. Do not propose splitting a file merely because it is large; propose a split only when a concrete change requires it or the boundaries are unclear.
- Label design choices accordingly: what the supplied requirements or existing code already fixes is stated as confirmed; what you choose while authoring the plan is a proposal for the Orchestrator to confirm.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own verification cycle and stands or falls on its own. When drawing task boundaries: fold setup, configuration, scaffolding, and documentation steps into the task whose deliverable needs them; split only where one task could fail verification while its neighbor passes. Each task ends with an independently verifiable deliverable.

## Step Granularity

**Each step is one concrete, checkable action, sized to its deliverable — not a fixed time budget:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step

The test-first cycle above is illustrative, not mandatory. Adapt the cycle to the deliverable's real verification (a doc change might be "edit section" + "link check"; a config change "edit file" + "reload and probe"). Every task still ends in concrete, checkable verification.

## Plan Document Header

**Default header template for new plans.** When revising or extending an existing plan, preserve its supplied structure instead of re-templating.

```markdown
# [Feature Name] Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Requirements:** [path(s) to the supplied requirements, spec, or source
docs this plan implements — the plan argues from them, so they travel
with it; whoever implements reads both. If no document was supplied,
cite the dispatch and its confirmed context.]

## Global Constraints

[Project-wide requirements from the supplied requirements or spec —
version floors, dependency limits, naming and copy rules, platform
requirements — one line each, with exact values copied verbatim. Every
task's requirements implicitly include this section.]

## Review Focus

[The material risks or failure modes the requirements imply but no
task's verification exercises — one line each, naming the input,
condition, or interaction and the behavior a reasonable person would
expect, most likely first. Requirements say what the software must do,
not everything it will meet, and their silence on an input is not
permission for that input to break the program. Write the list here,
once, with the requirements in front of you. Then, for each line, link
it to the task and verification that covers it.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks or existing code —
  exact signatures; for existing code, reference by path and symbol]
- Produces (proposed): [what later tasks rely on — exact function
  names, parameter and return types, so each task is self-contained
  and signatures stay consistent across tasks]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS
````

The test-first pattern and filenames above are illustrative: keep the
template's Files, Interfaces, and step style as the default structure for
new plans, but commands, expected outcomes, and example code must match
the target project's actual tooling and conventions. Steps must always
show the actual content — code blocks for code steps, exact commands and
expected outcomes for verification steps — for whatever the deliverable
requires.

## No Placeholders

Every step must contain the precise content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without what the tests must verify)
- "Similar to Task N" without the exact differences (name what is shared and what changes)
- Steps that describe what to do without the details needed to check the result

Pin down exact behavior, inputs, outputs, symbols, file paths, and acceptance criteria for every step. Include code where it removes ambiguity; for existing types, functions, or definitions, a precise reference by path and symbol is enough — do not restate code that already exists. If a step depends on a required decision that was not supplied and cannot be derived from confirmed context, stop and return `NEEDS_CONTEXT` rather than inventing one.

## Self-Review

After writing the complete plan, reread it with fresh eyes and check it against the supplied requirements. This is a checklist you run yourself.

**1. Requirements coverage:** Skim each requirement in the supplied requirements. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each risk or failure mode the requirements imply, is there a task whose verification exercises it? The uncovered ones most likely to bite a person go in the Review Focus section, and each line there is linked to the task and verification that covers it. An empty section means you checked and found none, not that you skipped the check.

If you find issues, fix them, save, then reread the saved document and rerun the affected checks against the file as saved. If you find a requirement with no task, add the task. This self-review is a quality pass on your own work; it does not replace Oracle review of the returned artifact and evidence.

## Artifact Delivery

After saving and self-reviewing the plan, return the artifact through the existing writer result/evidence contract: the saved plan path, a concise outcome summary, the material changes with locations, verification actually performed, and any review evidence that contract requires. Do not dispatch reviewers, do not select or announce an execution method, and do not begin implementing the plan — the Orchestrator owns assignment, scope, decisions, review routing, quality gates, and execution.
