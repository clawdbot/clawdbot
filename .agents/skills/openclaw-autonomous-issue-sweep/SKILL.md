---
name: openclaw-autonomous-issue-sweep
description: "Orchestrate 64 autonomous OpenClaw issue workers newest-to-oldest with isolated issue worktrees and resource-bounded parallelism; investigate bugs, simplify or refactor, review, land verified fixes, close already-fixed issues, and add meaningful evidence."
---

# OpenClaw Autonomous Issue Sweep

Run an end-to-end maintainer campaign, not a candidate shortlist. The parent
conversation is the orchestrator: delegate discovery, investigation, coding,
testing, review, GitHub mutations, PR preparation, landing, and cleanup to
subagents. Keep parent-thread updates to concise progress and clickable URLs.

## Authority and campaign shape

- Spawn exactly **64 first-class subagents** unless the user requests another
  count or available capacity makes that impossible; disclose the actual count.
- Use full-history forks so every subagent inherits the orchestrator's model
  and **xhigh reasoning effort**. Never print, record, or disclose model
  identifiers; redact subprocess banners and diagnostics before reporting.
- Begin every full-history child assignment with its explicit role and agent
  identity, require inherited **xhigh reasoning effort**, and forbid
  `create_goal`, visualizations, `spawn_agent`, or nested agents. Children
  return evidence to the orchestrator; never downgrade their model or effort.
- Treat a request to run this workflow as authority to create lightweight,
  issue-scoped isolated Git worktrees and `codex/issue-<id>` branches, review,
  fix, refactor, commit, push, create/update PRs, land eligible changes,
  comment, and close issues individually. Do not ask for separate worktree or
  routine-operation confirmation again.
- Never treat sweep authority as permission to publish releases, bump protocol
  or SQLite schema versions, weaken security, break shipped compatibility,
  change another owner's protected product surface, or execute untrusted code
  with local credentials.
- Have subagents read the complete root `AGENTS.md`, relevant scoped guides,
  `VISION.md`, and companion skills before acting. Use `$gitcrawl`, Octopool,
  `$openclaw-pr-maintainer`, `$openclaw-testing`, `$crabbox`, and `$autoreview`
  where each owns the workflow.
- Keep the parent out of operational work. It may spawn, assign, receive
  results, serialize shared resources, monitor host/pool health, prewarm and
  allocate needed remote leases, issue follow-up tasks, and report; it must
  not inspect issues, edit code, run tests, mutate GitHub, or land PRs.

## Coordinate 64 workers safely

1. Assign one subagent to maintain the live open-issue queue in descending
   `createdAt` order, one to coordinate landing/proof capacity, and no more
   than **3** to live issue closures or other GitHub mutations. Assign the
   remaining slots to issue investigations; idle coordinators also investigate.
2. Claim issues from the newest unclaimed end only; replenish workers as they
   finish. Parallel completions may arrive out of order, but never knowingly
   start an older unclaimed issue ahead of a newer available issue.
3. Deduplicate by canonical root cause, not merely by issue number. Let one
   owner fix a shared defect and link related issues/PRs to that outcome.
4. Freeze the reviewed source SHA for each wave. Serialize only shared Git/ref
   mutations: fetches, branch/ref changes, `git worktree add`/remove, PR
   preparation and merges, and main-targeted pushes. Give each mutation a brief
   coordinator-owned exclusive slot; do not hold it across coding, proof,
   reviews, remote waits, or other independent issue work.
5. Give every independent root-cause fix its own isolated, issue-scoped
   lightweight worktree and `codex/issue-<id>` branch. Create it from the
   frozen SHA, for example:

   ```bash
   git worktree add -b "codex/issue-$issue_id" \
     "$campaign_worktrees/issue-$issue_id" "$frozen_main_sha"
   ```

   Reuse a repo-native isolated PR worktree when repairing an existing PR;
   duplicate issues sharing one root cause share its single owner/worktree.
   Share Git objects; do not clone the repository or install dependencies per
   worktree merely for isolation. Never edit, switch, reset, or otherwise
   mutate the shared checkout while sibling workers are active. Once isolated
   worktrees exist, independent issue owners edit, inspect, and verify in
   parallel within their own checkout.

6. Keep all **64** inherited high-effort agents available, but distinguish idle
   agents from active local tool users. Start with bounded waves of **4–8**
   concurrently active code/test workers and continuously reduce or expand that
   limit according to usable CPU/load, memory/swap pressure, checkout and temp
   free disk, process count, operator-gateway health, and remote-pool capacity.
   Reserve capacity for the operator; count heavyweight proof proportionally,
   stop admitting new commands under sustained pressure, and resume in small
   waves after recovery. Never kill unrelated operator processes.
7. Serialize merges and each Testbox lease, not independent worktree edits. A
   lease has one owner and one active command; never reclaim, sync, or change
   its head during a run.
8. Respect GitHub rate limits, active assignees, repository ownership, and
   existing contributor work. Do not auto-assign broad-discovery candidates.
9. Replace finished workers while the queue remains. Record actual active,
   parked, completed, failed, fixed, landed, verified-closed, queued-for-close,
   commented, and skipped counts. Persist that campaign checkpoint for resumed
   workers; never report launched, parked, or finished workers as still running.

## Conserve GitHub capacity and host resources

- Prefer local `$gitcrawl` archives and source history for queue discovery,
  issue/PR search, duplicate clusters, comments, and previously merged work.
  Check archive freshness; do not broadly sync, enrich, or re-embed merely to
  start a sweep.
- Prefer `octopool gh ...` or narrowly bounded `octopool request` for
  necessary live GitHub reads and mutations. Check `octopool health` and
  `octopool stats` periodically; let repo-native PR wrappers retain their
  required GitHub transport and authenticated identity.
- Use plain `gh` only when Octopool cannot support the operation or the
  canonical maintainer wrapper requires it. Request minimal fields, reuse
  results across workers, batch compatible reads, avoid unbounded pagination,
  and never use `gh run watch` or frequent unchanged CI polls.
- Require a fresh live state check only before consequential mutations, final
  merge decisions, or a stale/contradictory cached result. Rate-limit and
  deduplicate worker requests instead of having 64 agents independently fetch
  the same issue, PR, author profile, or CI rollup.
- Keep disk, CPU/load, memory pressure, active lease IDs, provider trust class,
  issue-worktree ownership, active local tool count, frozen heads, and pool
  capacity in the orchestration ledger. Dynamically cap concurrent code/test
  workers instead of serializing every independent fix. Pause or interrupt only
  campaign-owned work under host pressure, preserve each issue's claim and
  isolated checkout, then resume from that recorded state when capacity returns.
  Offload heavy proof before resource pressure threatens the host.
- Worktree checkout and dependency use must respect free-disk headroom. Reuse
  shared Git objects and existing trusted dependency installs where safe; route
  dependency-missing or heavyweight proof to the selected remote box instead
  of multiplying local installs across issue checkouts.
- The parent may prewarm a trusted Crabbox/Testbox lease when a concrete heavy
  proof is imminent, then hand its verified lease ID and checkout ownership to
  one subagent at a time. Avoid speculative fleets, respect path-scoped lease
  ownership, and stop campaign-owned leases before handoff or closeout.
- Keep untrusted contributor proof on a separate sanitized direct-AWS lease;
  never transfer a credential-hydrated trusted lease to untrusted work.

## Search for existing work on every credible issue

Always investigate existing PRs before implementing a fix:

1. Read the live issue body, all material comments, labels, assignments,
   timeline/cross-references, repro details, affected versions, and ClawSweeper
   findings.
2. Search `$gitcrawl` for the issue number, title, error text, affected
   subsystem, relevant symbols, duplicate symptoms, open PRs, merged PRs, and
   recently closed work.
3. Verify candidates against Octopool-backed live GitHub search, directly
   linked PRs, current PR heads, `origin/main`, and commit history. Search
   exact issue references and symptom/root-cause terms; do not stop at the
   first plausible PR.
4. Read competing implementations deeply enough to decide whether an existing
   PR already fixes the real defect, merely masks one symptom, has gone stale,
   or reveals a cleaner owner-boundary refactor.
5. Preserve contributor commits, attribution, issue reporter credit, and useful
   ideas whenever repairing or replacing existing work.

Choose outcomes in this order:

1. **Fixed on main:** prove the original failure is resolved; close with the
   exact merged PR, commit, current source/test, or release proof.
2. **Existing PR is the best fix:** improve it as needed, verify the exact
   final head, and land it through the repo-native maintainer workflow.
3. **Existing PR is useful but incomplete:** finish it or create a cleaner
   replacement that preserves human attribution and links the original.
4. **No suitable PR:** implement the best high-confidence root-cause repair or
   a justified simplifying refactor; create, verify, and land a focused PR.
5. **Bug cannot be fixed, but simplification is real:** independently land a
   proven behavior-neutral refactor when it meaningfully removes complexity
   without pretending the original issue was fixed.
6. **Cannot fix or close:** comment only if investigation uncovered concrete,
   material evidence missing from the issue and ClawSweeper's existing review.

## Prove the bug and choose the best design

- Trace the actual user path from entry point through caller, canonical owner,
  callee, sibling implementations, transport/lifecycle boundaries, tests,
  current `main`, shipped contracts, and direct dependency source or docs.
- Personally inspect sibling `../codex` source before any Codex integration
  verdict or change, as required by the root guide; another agent's report is
  not sufficient for the agent making that decision.
- Require a failing regression, reproducible command, real logs, live product
  behavior, dependency contract, or exact source-level proof. Never repair an
  issue on title, speculation, ClawSweeper output, or a plausible diff alone.
- Prefer the correct owner-boundary refactor over a narrow guard, workaround,
  new fallback, duplicate policy, extra configuration, or compatibility shim.
  A larger refactor is appropriate when it fixes the whole bug class more
  clearly and its behavior/ownership risk remains understood and bounded.
- While reading, look for dead branches, unused helpers, duplicate paths,
  stale abstractions, obsolete tests, and complexity that can be deleted as
  part of the same coherent change.
- Measure `git diff --numstat`; aim to reduce **production LOC**, excluding
  tests. Production growth is acceptable only when clearly justified by fewer
  concepts, better ownership, essential product behavior, or stronger safety.
- Allow small missing product affordances, such as an obviously expected CLI
  command, when adjacent behavior and docs establish the contract. Reject
  substantial new features, speculative redesign, new paid services,
  unsupported integrations, or unrelated drive-by changes.
- Do not edit `CHANGELOG.md`; capture user impact, issue/PR references, and
  human credit in the PR body or commit message.

## Hard issue-closure gate

An issue stays open unless every step below passes. Similar wording, adjacent
tests, merged PR dates, contributor suggestions, and confident review summaries
are not closure proof.

1. Write down the reporter's exact **primary symptom**, desired user-visible
   outcome, every separately affected surface, reported version/build SHA, and
   all proposed alternatives. An optional mitigation or diagnostic suggestion
   does not replace the reported primary outcome.
2. Personally trace both shipped and current behavior end to end: entry point,
   canonical owner, caller, callee, dependency contract, sibling surfaces, and
   existing tests. Reproduce the exact reported failure on the affected build
   and prove the same user action succeeds on current `main`. Use a runnable
   product or boundary-level regression; a nearby unit test, revised error text,
   or an unexecuted source inspection is insufficient.
3. Prove Git ancestry rather than inferring it from dates:

   ```bash
   git merge-base --is-ancestor "$fix_sha" "$current_main_sha"
   git merge-base --is-ancestor "$fix_sha" "$reported_build_or_tag_sha"
   git tag --contains "$fix_sha"
   ```

   The fix must be an ancestor of current `main`. Compare it against **each**
   affected exact build/tag, account for diverged release branches, and identify
   the first containing release when known. A merge before a release date does
   not prove inclusion in that release. If the fix was already in an affected
   build, assume the report still reproduces until a later causal fix is proved.

4. Classify the candidate honestly: root-cause repair, mitigation, diagnostic
   improvement, unsupported contract, workaround, or product decision. Never
   close because a suggested fallback landed if the primary action still fails,
   any reported surface remains broken, an owner hold exists, or documented
   behavior requires an unresolved maintainer/security/product decision.
5. Require a **different, independent subagent with inherited xhigh reasoning**
   to challenge the investigator's closure packet. The challenger personally
   verifies the primary outcome, every affected surface, runtime owner and
   contract, release ancestry, and before/after proof. The investigator cannot
   self-approve; only a separate authorized closure coordinator may grant the
   mutation after both reviewers agree. Any disagreement means **leave open**.
6. Immediately recheck live GitHub state, labels/owner holds, current `main`,
   and exact proof. Do not close on stale state, an incomplete source map, an
   indirect main-only test, changed wording without changed behavior, or any
   unresolved facet. In **one sentence**, the closure comment must state the
   exact fixed behavior, fix SHA/PR, first containing version when known, and
   before/after evidence.
7. If a closure is challenged or an incorrectly closed issue is reopened,
   **pause all closure mutations**. Audit earlier closures, correct the public
   record, reopen proven mistakes, and resume only after explicit root
   authorization. Continue safe investigation and verified code-fix work.

Required evidence map:

```text
Primary symptom -> expected outcome -> every reported surface -> affected build/tag
Entry -> caller -> canonical owner -> callee -> dependency -> sibling -> boundary proof
Fix SHA -> current-main ancestry -> each affected-build ancestry -> containing release
Affected-build failure -> current-main success -> independent challenge -> coordinator grant
```

Reject example: a remote command fails because its explicit working directory
does not exist on the target host. A merged change that only replaces a vague
spawn error with an accurate invalid-directory diagnostic is useful, but the
command still fails. If the primary expected outcome is successful execution,
leave the issue open; changing that explicit-directory contract may need an
owner decision.

## Verify behavior and obtain two independent reviews

For every non-trivial production change:

1. Add focused regression coverage for the original bug and affected sibling
   paths. Delete tests protecting removed obsolete implementation details.
2. Choose proof with `$openclaw-testing`. Live-test the real user/provider/
   channel/CLI/package/UI path whenever feasible. Route heavy, packaging,
   Docker, E2E, or broad checks through `$crabbox`; report an unavailable live
   prerequisite accurately instead of calling a mock live proof.
3. Classify source trust before executing anything. Never run contributor/fork
   scripts, hooks, config, tests, installs, or wrappers locally or on a
   credential-hydrated host; follow the sanitized untrusted-source workflow.
4. Run `$autoreview` on the complete final change until no accepted actionable
   findings remain. Re-run it after any production, test, or reviewed-head
   change. Treat review findings as hypotheses and verify each against source.
   Prose-only skill files and other non-production internal notes do not need
   autoreview; validate their structure and formatting instead.
5. Separately self-invoke an independent Codex reviewer. First verify the
   installed interface with `codex exec --help`, then run a bounded read-only,
   ephemeral review from a trusted checkout, for example:

   ```bash
   codex exec --json --sandbox read-only --ephemeral \
     -C "$trusted_checkout" --output-last-message "$review_result" \
     "Independently inspect the frozen candidate diff and its owner, callers,
      siblings, tests, current main, user behavior, and dependency contracts.
      Report only concrete correctness, architecture, simplification, or
      verification gaps. Do not modify files or expose secrets." \
     >/dev/null 2>/dev/null
   ```

   Point the reviewer at the exact immutable diff/head. Do not substitute the
   `$autoreview` Codex engine for this separate pass. Never run that reviewer
   from an untrusted project-controlled checkout. Read only the final review
   result; do not emit raw model banners. Verify actionable findings, make
   justified fixes, rerun proof, and refresh both independent reviews.

6. Read the latest ClawSweeper comment and address each applicable `Rank-up
moves:` item with real evidence or an explicit reason for skipping it.

## Publish, land, and clean up

- Prefer an existing writable contributor PR. If its head is unsuitable or
  cannot be updated safely, open a focused replacement, explain the
  relationship, and preserve attribution.
- Before opening replacement PRs, verify author association, active-PR counts,
  repository permission, branch policy, current auto-response exemptions, and
  override labels; never assume a privileged-role exemption. Reuse or land
  existing reviewed work before creating a burst of competing PRs.
- Use the actual PR template and state the user impact, canonical root cause,
  rejected alternatives, production LOC delta, exact head SHA, focused/live
  proof, autoreview result, independent Codex result, CI state, and credit.
- Read `$agent-transcript` for agent-created PRs, but do not include logs
  without the user's explicit transcript approval. During a fully autonomous
  sweep, omit transcripts rather than interrupting the user for consent.
- Open new PRs as drafts, wait for a non-null mergeability result, mark them
  ready, and verify CI attached to the exact pushed head before landing.
- Autonomously land only a reproduced, high-confidence, bounded-risk repair
  or behavior-neutral simplification with clean independent reviews and green
  exact-head required proof. Change size alone is not the risk criterion.
- For main-targeted PRs use only the repo-native `scripts/pr` flow: initialize
  review, create/validate review artifacts, run
  `OPENCLAW_TESTBOX=1 scripts/pr prepare-run <number>`, then
  `scripts/pr merge-run <number>`. Verify the canonical merge SHA afterward.
- Keep owner/security/auth/config/public-SDK/protocol/persistent-state/product
  decisions outside autonomous landing when the relevant guide requires owner
  judgment. Continue with the next issue instead of blocking the whole sweep.
- Close a fixed issue only after the complete **Hard issue-closure gate**,
  independent challenger sign-off, coordinator grant, and fresh live recheck.
  Cite the exact causal PR/commit and first containing release when known.
- Never close merely because a repro is difficult, the report is inconvenient,
  the behavior might be intentional, or the PR is stale. Product-decision and
  won't-implement closures require maintainer judgment.
- If no fix is possible, comment only when supplying new reproducible steps,
  an exact failing owner/line, verified dependency behavior, previously
  unidentified duplicate/fixing PR, a concrete workaround, or another
  meaningful fact absent from prior discussion and ClawSweeper.
- Recheck live state immediately before every mutation; avoid redundant,
  speculative, noisy, or duplicate comments. Handle closures individually and
  follow repository limits on bulk operations.
- After verifying the canonical landed SHA and preserving contributor credit,
  remove only that campaign-owned isolated worktree during a brief serialized
  Git mutation slot. Delete its campaign-owned branch only when no unlanded
  work depends on it; never prune unrelated worktrees, refs, or user files.

## Parent-thread reporting

Send concise progress plus URLs only. Prefer updates such as:

```text
64 agents active · 41 investigated · 3 landed · 5 already-fixed issues closed
Landed: https://github.com/openclaw/openclaw/pull/123
Closed: https://github.com/openclaw/openclaw/issues/456
```

Do not narrate routine reads, pending hypotheses, unchanged CI, or candidate
URLs that are not actually ready. Count only verified merged PRs, confirmed
closures, and comments that were really posted. Continue until the user stops
the sweep, the requested boundary is reached, or the live issue queue is
genuinely exhausted.
