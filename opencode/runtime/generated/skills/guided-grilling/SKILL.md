---
name: guided-grilling
description: Run upstream grilling with the local communication companion. Use when the user requests guided-grilling or explicitly asks to combine grilling with mama-inspired communication guidance; not for ordinary questions or unrequested design interviews.
---

# Guided grilling

Compose the upstream interview workflow with the local communication guidance.
Before beginning the interview:

1. Call the Skill tool with `name: "grilling"` to load the installed upstream skill.
2. Call the Skill tool with `name: "grilling-companion"` to load the local supplement.
3. Apply both to the user's current plan, decision or idea, using the contract below.

If either skill is unavailable or permission is denied, explain the missing
dependency and stop this combined workflow. Do not substitute `grill-me`,
reconstruct an upstream skill from memory, or silently continue without the
companion. The user can explicitly choose the standalone upstream workflow.

## Composition contract

- Follow `grilling` for the design tree, prerequisites, full frontier of questions, numbered format, recommendations and rounds. Wait for answers before advancing to dependent decisions.
- Follow `grilling-companion` for understanding context, explaining choices and communicating considerately. Its recommendations remain proposals until the user decides.
- Preserve upstream completion and confirmation requirements. Do not cap the number of questions, omit unresolved branches or begin implementation early in the name of reducing effort.
- Load the installed upstream skill each time this workflow is invoked; do not embed, patch or replace its text. Loading the companion second is a composition step, not a host-enforced instruction-priority mechanism.
- If the installed upstream rules conflict with this contract, describe the conflict and ask the user how to proceed. Do not silently change either skill.

Calling `grilling` directly retains its original behavior. This entry point
does not automatically wrap `grilling` or `grill-with-docs`, and it does not
load the full `mama` persona or change global conversation behavior.
