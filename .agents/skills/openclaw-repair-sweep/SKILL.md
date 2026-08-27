---
name: openclaw-repair-sweep
description: "Orchestrate worker fleets over OpenClaw issues and PRs: prove root causes, prefer clean refactors over quick patches, land verified repairs, and close items proven fixed or no longer useful."
---

# OpenClaw Repair Sweep

One skill for every autonomous issue/PR repair run, from a pasted five-item
list to a full-queue campaign. The invoking conversation is always the
orchestrator; workers in isolated worktrees — subagents or Codex CLI — do all
hands-on work. Scope, scale, and deliverable are inputs with defaults, not
separate skills.

## Inputs and defaults

- `scope`: `refs` (explicit pasted issue/PR list), `discovery` (bounded search
  for the best qualified batch), or `queue` (entire open-issue queue, newest to
  oldest). A bare invocation defaults to `discovery`; pasted refs imply `refs`;
  "the whole queue" or "keep going until empty" implies `queue`.
- `batch_size`: discovery target; default `5`, cap `20`. Do not pad a batch
  when the bounded search yields fewer qualified items. Ignored for `queue`.
- `workers`: fleet size. Defaults: `refs` one owner per item/cluster capped at
  `8`; `discovery` `8`; `queue` `64`. An explicit request ("use 10 workers",
  "64 workers") overrides the default; disclose the actual count when capacity
  forces fewer.
- `focus`: optional subsystem/surface/label filter that narrows discovery or
  the queue ("focus on gateway", "Telegram only").
- Authority: invoking this skill authorizes workers to investigate, fix,
  refactor, commit, push, create/update PRs, land eligible changes, comment,
  and close proven items within scope — including issue-scoped worktrees —
  without further routine confirmation. `review`, `triage`, or `list` wording
  keeps the run read-only; a `fix only` request permits local changes and proof
  but no publication. Sweep authority is never permission to publish releases,
  bump protocol or SQLite schema versions, weaken security, break shipped
  compatibility, change another owner's protected product surface, or execute
  untrusted code with local credentials.

Workers read the complete root `AGENTS.md`, relevant scoped guides, and
`VISION.md` before acting. Companions where each owns the workflow:
`$gitcrawl` discovery/clusters, `$openclaw-pr-maintainer` live GitHub mutation
rules, `$github-author-context` for contributor trust, `$openclaw-testing`
proof choice, `$autoreview` pre-publish review, `$crabbox` heavy/remote proof.

## Orchestration contract

- The parent is control plane only: decompose work, assign explicit
  issue/PR/file/checkout ownership, spawn bounded workers and independent
  verifiers, serialize shared mutations, track exact heads/evidence/
  authorization, and report worker-verified outcomes. It never inspects
  issues, reads source, edits, tests, mutates GitHub, or lands. When a worker
  stalls or fails, reassign the bounded work — the parent never takes it over.
- Workers are hands-on execution owners: discovery, source/dependency
  inspection, repros, edits/refactors, tests/proof/CI, GitHub reads/writes,
  comments, closures, commits, pushes, and authorized landing. A worker making
  a Codex-backed verdict personally inspects sibling `../codex` first and
  cites files/lines; another agent's report never substitutes.
- Spawn workers as full-history forks so each inherits the orchestrator's
  model and xhigh reasoning effort; never downgrade either, and never print or
  record model identifiers — redact subprocess banners before reporting.
- One bounded worker owns each item or root-cause cluster; duplicates sharing
  a root cause share that owner. Deduplicate by canonical root cause, not
  issue number. Separate independent workers challenge closures and
  nontrivial landing proof; an investigator cannot self-approve.
- When one defect class repeats across items (blank-credential handling,
  encoding slicing, unbounded caches, timeout bounds), assign the class to a
  single owner who picks one canonical helper and sweeps all sibling call
  sites — never parallel workers landing near-identical local patches.
- Every independent fix gets its own issue-scoped lightweight worktree and
  `codex/issue-<id>` branch created from a frozen SHA; reuse the repo-native
  isolated PR worktree when repairing an existing PR. Share Git objects — do
  not clone or install dependencies per worktree merely for isolation. Never
  edit, switch, or mutate the shared checkout while sibling workers are
  active; never stage, stash, discard, or overwrite unrelated dirty changes.
- Serialize only shared Git/ref mutations — fetches, branch/worktree ops, PR
  preparation, merges, main-targeted pushes — in brief coordinator-owned
  exclusive slots. Do not hold a slot across coding, proof, or remote waits.
  A Testbox lease has one owner and one active command.
- Bound concurrently _active_ code/test workers by real host capacity: start
  with waves of 4–8 and expand or shrink on CPU/load, memory, disk headroom,
  and remote-pool health. Reserve capacity for the operator; never kill
  unrelated processes. Keep the full fleet assigned — idle coordinators
  investigate. Offload heavy proof remotely before pressure threatens the
  host; pause only campaign-owned work, preserve claims, resume from the
  recorded checkpoint.
- Classify source trust before execution. Untrusted contributor code, tests,
  or wrappers never run locally or on a credential-hydrated host; use the
  sanitized remote-proof path. Run capable heavy trusted proof on the current
  dedicated Linux worker; otherwise use the selected remote box.
- Before replacing a failed or interrupted worker, preserve its claimed items,
  patches, checkout ownership, and evidence; hand them to exactly one
  replacement without duplicating or discarding unfinished work.
- Record actual active, completed, failed, fixed, landed, verified-closed,
  commented, and skipped counts; persist the checkpoint for resumed runs.

## GitHub capacity

- Prefer local `$gitcrawl` archives for queue discovery, search, duplicate
  clusters, comments, and prior merged work. Check freshness; do not broadly
  resync merely to start a sweep.
- Prefer `octopool gh ...` for necessary live reads/mutations; plain `gh` only
  when Octopool or the canonical wrapper requires it. Minimal fields, batched
  reads, results reused across workers, no unbounded pagination, never
  `gh run watch` or unchanged-CI polling.
- Require a fresh live check only before consequential mutations, final merge
  decisions, or on stale/contradictory cached state. Deduplicate worker
  requests instead of letting the fleet fetch the same item independently.

## Candidate bar

Accept a repair only when all are true:

- real bug or paper cut — not feature/product/support/release/workflow work
- root cause proven in current code; dependency behavior verified against
  upstream docs/source/types when relevant
- repair shape is high confidence with understood, bounded behavior and
  ownership risk — change size alone is not the risk criterion
- no new dependency, no new config option, no backward-incompatible behavior
- no plugin SDK/public API boundary change and no security/product/owner
  decision required. For items needing such a decision, make the cheap safe
  repairs anyway, push to preserve the work, and report
  NEEDS-MAINTAINER-DECISION — with a read-only sibling-surface survey and a
  recommendation — instead of merging or silently skipping
- focused proof is feasible

Reject speculative reports without provable cause, UI/UX judgment calls, and
fixes needing unavailable credentials for mandatory live verification. Skip
with a terse reason; never pad with low-confidence fixes.

## Fix shape: refactor first

- Prefer the coherent owner-boundary refactor over a narrow guard, workaround,
  fallback, duplicate policy, or compatibility shim. Clean code beats a quick
  fix: when the minimal patch and the clean repair diverge, take the clean
  repair while its risk stays understood and bounded. Do not substitute a
  workaround when a coherent cleanup is the correct fix.
- While reading, delete connected dead branches, duplicate paths, stale
  abstractions, and obsolete tests in the same coherent change.
- Measure `git diff --numstat`; aim for net-neutral or net-negative production
  LOC with tests counted separately. Justify growth only by fewer concepts,
  better ownership, essential behavior, or stronger safety.
- Never hardcode the reported example. Add regression coverage near the
  failing surface when it fits. Small missing affordances with an established
  adjacent contract are fine; substantial new features are not.
- Never edit `CHANGELOG.md`; put user impact, issue/PR refs, and human credit
  in the PR body or commit message.
- After finishing its assigned items, each worker lands the best rent-paying
  refactor or simplification found in the areas it touched as its own focused
  PR, or states NO-FOLLOW-UP with one sentence. These passes regularly find
  real bugs; hold them to the same candidate bar, proof, and review gates.

## Outcome order per item/cluster

Always investigate existing work first: live body/comments/labels/links,
`$gitcrawl` for duplicates and prior PRs, live search, current `main` and
history. Read competing implementations deeply enough to judge them. Then:

1. **Fixed on main:** prove the original failure is resolved; close with the
   exact merged PR/commit, current source/test, or release proof.
2. **Existing PR is the best fix:** improve as needed, verify the exact final
   head, land through the repo-native maintainer workflow.
3. **Existing PR is useful but incomplete:** finish it, or create a cleaner
   replacement that preserves attribution and links the original.
4. **No suitable PR:** implement the best high-confidence root-cause repair or
   justified simplifying refactor; create, verify, and land a focused PR.
5. **Bug cannot be fixed, but simplification is real:** land a proven
   behavior-neutral refactor without pretending the issue was fixed.
6. **Cannot fix or close:** comment only when investigation produced concrete
   material evidence absent from the issue and ClawSweeper's review.

Existing-PR rules: review the code path beyond the diff before trusting it.
Exclude wide-access maintainer-authored PRs from generic discovery until 14
days after creation; only a named PR or explicit maintainer-work request
overrides. Rewrite an inadequate editable PR at the root-cause owner and keep
author credit; create a replacement only when the source branch is uneditable
or unsafe to update, and close the source only after the replacement exists.
Red CI is normal work: inspect, fix or reject, recheck green.

## Broken main

A red `main` — exact-head CI failures reproducing on unrelated PRs — is sweep
work, not an interruption, and needs no ask. Assign one worker to own the
repair: find the breaking commit, check for existing repair PRs first and
land the best one instead of duplicating a fix in flight, and prefer deleting
dead code over baselining. Every other worker rebases onto the repaired
`main` as needed and continues.

## Closure gate

An issue stays open unless every step passes. Similar wording, adjacent tests,
merge dates, and confident summaries are not closure proof.

1. Write down the reporter's exact primary symptom, expected outcome, every
   affected surface, and reported version/build SHA. A merged mitigation or
   diagnostic does not replace the primary outcome.
2. Personally trace shipped and current behavior end to end; reproduce the
   reported failure on the affected build and prove the same user action
   succeeds on current `main` with a runnable boundary-level check. A nearby
   unit test or unexecuted source inspection is insufficient.
3. Prove ancestry, never infer from dates: `git merge-base --is-ancestor` for
   the fix SHA against current `main` and each affected build/tag, plus
   `git tag --contains`. A merge before a release date does not prove
   inclusion.
4. Classify honestly: root-cause repair, mitigation, diagnostic, workaround,
   or product decision. Never close while the primary action still fails, any
   reported surface remains broken, or an owner hold exists.
5. A different independent worker challenges the closure packet and personally
   verifies outcome, surfaces, ancestry, and before/after proof; a separate
   closure coordinator grants the mutation. Disagreement means leave open.
6. Recheck live state immediately before the mutation. The closure comment
   states, in one sentence, the fixed behavior, fix SHA/PR, first containing
   version when known, and before/after evidence.
7. If a closure is challenged or reopened, pause all closure mutations, audit
   and correct the record, and resume only on explicit root authorization.

No more than 3 workers hold live closure/mutation duty at once. More than 50
close/reopen actions require separate exact-count approval. Product-decision
and won't-implement closures stay with maintainer judgment.

## Verify and review

- Choose proof with `$openclaw-testing`; live-test the real user/provider/
  channel/CLI path when feasible; route heavy, packaging, Docker, E2E, or
  broad checks through `$crabbox`. Report an unavailable live prerequisite
  accurately instead of calling a mock proof live.
- Run `$autoreview` on the complete final change until no accepted actionable
  findings remain; rerun after any production, test, or head change. Verify
  findings against source rather than accepting them blind.
- Separately self-invoke an independent Codex reviewer (`codex exec --json
--sandbox read-only --ephemeral` from a trusted checkout) against the exact
  frozen head; the `$autoreview` engine does not substitute for this pass.
  Read only the final result; never emit raw model banners.
- Read the latest ClawSweeper comment and address each applicable `Rank-up
moves:` item with evidence or an explicit skip reason.
- Verify live GitHub CI green on the exact pushed head before counting a PR
  landable or landed; never count pending, red, or conflicting PRs.

## Publish, land, clean up

- Open new PRs as drafts, wait for non-null mergeability, mark ready, and
  verify CI attached to the pushed head. Use the actual PR template: user
  impact, canonical root cause, rejected alternatives, production LOC delta,
  exact head SHA, proof, review results, CI state, and credit. Omit agent
  transcripts during autonomous runs rather than interrupting for consent.
- Land main-targeted PRs only through the repo-native `scripts/pr` flow
  (review-init, artifacts, `OPENCLAW_TESTBOX=1 scripts/pr prepare-run`,
  `merge-run`); verify the canonical merge SHA afterward.
- Verify every claimed landing by ancestry, not GitHub state:
  `git merge-base --is-ancestor <merge-sha> origin/main`. `gh pr view --json
state` can report a stale `closed` for freshly merged PRs, and a GitHub 504
  mid-merge may still have merged — verify before retrying or re-landing.
- Refresh or rebase a PR branch only for an actual conflict, failing
  exact-head check or guard, explicit request, or proven material stale-base
  risk — never merely because `main` advanced.
- After a verified landing, remove only that campaign-owned worktree and
  branch during a serialized mutation slot; never prune unrelated worktrees,
  refs, or user files.

## Reporting

Parent-thread updates are concise progress plus clickable URLs:

```text
8 agents active · 12 investigated · 3 landed · 2 already-fixed issues closed
Landed: https://github.com/openclaw/openclaw/pull/123
```

Maintain a ledger per item: outcome class, assigned worker, independent
verifier, exact head, production/test LOC delta, proof/CI state, credit, and
cleanup. Count only verified merged PRs, confirmed closures, and comments
actually posted. Final answer: accepted PR URLs (or the smaller qualified
count with the exhausted-search reason) with 2–4 sentence explainers and
proof/CI state, closed refs with proof, concrete blockers or skip reasons, and
current branch/status.
