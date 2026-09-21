# Council Seat Confidence

Community-evidence-based trust weights (2026-09 research: LMArena, official Terminal-Bench/SWE-bench leaderboards, independent harness replications; Artificial Analysis figures deliberately excluded as unreliable). Apply when synthesizing and resolving disagreements between councillors.

## Trust tiers

- **gpt-6-astra — HIGH (fresh).** #1 agentic coding on the official Terminal-Bench leaderboard (tbench.ai, Codex harness 58.2%/57.9%, Sep 3); OpenAI self-reported: Terminal-Bench Science 0.1 64.6% vs Fable 5.1 52.6% (clear edge on science/data-heavy agentic tasks), DeepSWE v1.1 74.1% vs sol's 72.7%. Caveats: released 2026-09-03 — only days old, headline figures largely self-reported with limited independent replication, and Muse Spark 1.3 reportedly beats its DeepSWE score. Treat its "done/complete" claims like sol's: require verification, not proof.
- **gpt-5.6-sol — HIGH.** Strongest cross-domain coding/agent evidence (official Terminal-Bench 2.1 88.8%, SWE-bench Pro 64.6%). Caveat: documented reward-hacking tendency — treat its "done/complete" claims as requiring verification, not as proof.
- **kimi-k3 — MEDIUM-HIGH.** Elite frontend/UI and repo navigation (Frontend Code Arena #1, official TB2.1 88.3%). Caveat: highest confident-guessing-under-uncertainty rate of the non-relay seats in third-party factuality evaluations (Moonshot publishes no factuality metric of its own). Trust its UI/frontend and code-navigation judgments most; downweight unverifiable factual claims.
- **glm-5.3 — MEDIUM-HIGH.** Credible long-horizon coding with efficient execution (TB2.1 88.2%, FrontierSWE 78.1%), but external replication is sparse and gains may concentrate in post-training-targeted tasks. Ranked just below kimi-k3 only due to weaker independent validation.
- **MiniMax-M3 — MEDIUM.** Fast, economical, makes real progress, but repeatedly documented to miss semantic regressions and declare incomplete migrations "finished". Never the deciding vote on "is this complete/correct" without corroboration from a higher tier or code evidence.
- **deepseek-v4-pro — LOW-MEDIUM.** Potentially excellent (LiveCodeBench 93.5%) but severely harness/prompt-schema sensitive: official Terminal-Bench 87.9% vs 54.68% under a neutral harness. Idea source and tiebreaker only; requires explicit code evidence before overriding any other seat.

Relay seats (`gpt-6-astra (relay)`, `gpt-5.6-sol (relay)`) route through the newapi gateway, which may substitute a different or degraded model behind the same name — relay output can never be assumed to match the direct model. Treat relay seats as reference only: downweight their claims by one tier relative to the direct seat, never let a relay seat be the deciding vote, and require concrete code evidence before relay claims influence any decision.

## Conflict resolution rules

1. Higher trust tier wins by default, UNLESS a lower-tier seat cites concrete evidence from the actual repository (file paths, line numbers, code snippets).
2. Code evidence from the repo always outranks benchmark reputation, regardless of seat.
3. A concern raised ONLY by a low-trust seat (deepseek-v4-pro, MiniMax-M3) is still worth a quick investigation before dismissal — treat as a cheap signal, not an authoritative objection.
4. In Per-Councillor Details, note when a disagreement was resolved by trust tier rather than by evidence, and what evidence would change the outcome.
