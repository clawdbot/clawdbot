---
name: openclaw-pr-maintainer
description: Use immediately for any pasted OpenClaw GitHub issue or PR URL/number, and for OpenClaw issue/PR orchestration, review, triage, root-cause repair, PR rewrite, duplicate search, opener identity/who wrote it, author account age/activity, comments, labels, close, land, or maintainer evidence checks.
---

# OpenClaw PR Maintainer

Use this skill for maintainer-facing GitHub workflows and the code changes needed to finish an authorized issue/PR repair; do not invoke it for unrelated ordinary code changes.

## The lead owns the outcome; collaboration workers extend it

The original, user-facing root conversation is the authoritative lead. It may personally inspect, implement, test, operate Git/GitHub, and land, or delegate bounded independent lanes when parallelism, isolation, specialist judgment, or independent challenge creates concrete value. Repository guidance to use collaboration workers does not make delegation mandatory or turn the lead into an orchestrator-only shell. Do not create separate Codex app/project threads. A subagent assigned an execution role performs its scoped operations itself, retains personal inspection/verdict duties, and must not recursively delegate away ownership unless the root explicitly authorizes and tracks that nested lane.

- **Lead:** own the critical path and complete maintainer outcome; decompose and prioritize the request; personally perform serial, tightly coupled, or readily lead-owned work; assign disjoint independent lanes when useful; enforce authorization, owner, security, source-trust, proof, and publication gates; coordinate resources and shared-checkout safety; inspect actual repository/runtime effects; redirect, stop, replace, or correct weak work; dispatch independent verification; resolve routine decisions from existing authority and evidence; and communicate outcomes.
- **Workers:** perform bounded hands-on investigation, implementation, proof, review, or delivery assignments when delegation creates concrete value. Their output remains provisional until the lead verifies the actual effect. Require a separate independent worker only when the active workflow mandates independent verification or consequential evidence genuinely benefits from challenge.
- Bound worker count by available slots, including the parent's occupied slot, and safe host/proof capacity. Assign every worker a bounded scope and existing authorization; never infer broader permissions from delegation. Serialize shared fetch/ref/branch/checkout mutations, pushes, merges, and competing GitHub writes; never switch a shared checkout while siblings work or edit it while its Vitest run is in flight. Preserve unfinished worker state during reassignment. Existing untrusted-source isolation, remote-proof routing, owner approval, and landing requirements remain mandatory. These collaboration workers are not ClawSweeper's secretless internal review workers; ClawSweeper's deterministic GitHub App mutation and credential gates still apply.
- Each acting or verdict-bearing worker personally inspects relevant dependency contracts. For Codex-backed behavior, that worker must personally inspect and cite the exact sibling `../codex` source before its own verdict, code change, public comment, approval, merge recommendation, or proof-sufficiency claim. The parent may relay evidenced worker conclusions but must not render an independent Codex verdict from worker reports.
- Supervise workers through actual effects: shared-checkout diffs, processes, tests, runtime behavior, explicit checkpoints, terminal results, and liveness. Do not reduce supervision to repeated status reads or messages that reveal no new evidence. A slow, stalled, or unavailable worker may be redirected, replaced, or have its bounded lane taken over by the lead when shared-state and source-trust rules permit.

## Execute explicit full-authority work unattended

When the user explicitly requests unattended or autonomous execution with full authority, that instruction is standing approval for evidence-backed operations within the requested task scope. The user is unavailable: never ask routine clarification, owner, approval, worktree, publication, CI, or landing questions. The lead resolves ordinary decisions and completes the work directly or through bounded workers.

- The lead or bounded workers may investigate, repair/refactor, test, rewrite editable contributor PRs while preserving credit, create credited replacements when necessary, commit/push task-owned changes, update PRs, post proof, close items proven fixed on current `main`, diagnose/repair/rerun exact-head CI, create repo-managed PR worktrees or necessary task-owned isolated worktrees, run native review/prepare/merge, and verify terminal remote state.
- Preserve unrelated dirty work. Use an isolated task-owned/native-managed worktree or nondestructive scoped publication; never stage, commit, stash, discard, overwrite, or synchronize unrelated files.
- Continue through recoverable failures, stale guards, locks, and transient infrastructure problems with bounded safe retry and repository-approved lock recovery. Finish only after terminal verification; report a genuine missing capability, credential, or explicit safety gate without waiting for the unavailable user.
- When optional live-provider/channel proof is unavailable **and the user explicitly relaxes that proof**, a bounded deterministic owner defect may instead use failing/passing owner-boundary regression tests, direct producer/caller/sibling and dependency/source inspection, independent review, and green required CI on the exact head. Record the missing live/rank-up proof; never describe substitutes as live. Mandatory live proof for external API work, security-sensitive behavior, explicitly requested live verification, or risk that requires authenticated execution is never waived.
- Preserve source-trust isolation, contributor credit, exact-head required CI, native landing gates, and every acting worker's direct sibling `../codex` inspection. Standing authority never authorizes unrelated/destructive changes, unapproved paid or external side effects, irreversible data/security operations, SQLite schema-version or protocol bumps, dependency overrides, releases, or other actions behind an explicit safety/owner approval gate. Closing/reopening more than 50 items still requires separate explicit approval naming the exact count and scope.

## Finish proven bugs with root-cause repairs

Apply the root `AGENTS.md` Repair Doctrine to every maintainer-requested issue or PR. The goal is to fix real bugs without introducing new bugs, not merely produce a review, preserve an incoming patch, or close an item without proof.

Choose the outcome from live GitHub state, current `main`, affected source and tests, caller/owner/sibling paths, and relevant dependency contracts:

1. **Already fixed:** Prove with high confidence that current `main` already provides the same or better behavior. Identify the canonical fix commit/PR, any relevant release, and focused source, test, or reproduction evidence. When close/sweep/landing action is authorized, comment with that proof and close the issue or superseded PR. If equivalence, current-main behavior, or authority is uncertain, leave it open and state what is missing.
2. **Confirmed issue:** Reproduce or otherwise prove the defect, trace the violated invariant to its producer or lifecycle owner, and implement the architectural root-cause fix when repair is authorized. Cover the original failure and affected sibling paths with focused regression tests and realistic behavior proof. Do not settle for a downstream guard, workaround, speculative fallback, or passing test that leaves the owner broken.
3. **Confirmed bug-fix PR:** Independently prove both the defect and whether the proposed change repairs the root cause without regressions. If the PR is already the clean owner-boundary fix, verify and land it when authorized. If it is incomplete, in the wrong layer, needlessly complex, or only masks symptoms, rewrite/refactor the editable PR into the correct fix; verify the rewritten head and then land it. If the source branch cannot safely be edited, create an authorized replacement PR, preserve the original author's credit, and close the source only after the replacement exists. Never merge a speculative or merely plausible patch.

Prefer cleanup, deletion, coherent refactoring, and one canonical flow over additional branches, wrappers, fallbacks, or compatibility shims. Target net-neutral or net-negative **production** LOC; tests are counted separately and useful regression tests may grow freely. Inspect `git diff --numstat` before landing, report production and test deltas separately, and justify any unavoidable production growth with a concrete capability, ownership boundary, security invariant, or public/dependency contract.

Honor the requested action boundary: a fix request authorizes scoped investigation, local edits, and verification; an explicit ship/land/merge request or autonomous repair sweep also authorizes the scoped publication, closing, and landing needed to finish it. An explicit request to autonomously process, resolve, or fix-and-land a named maintainer issue/PR queue is an authorized autonomous repair sweep, including necessary evidence-backed comments, closures, root-cause fixes, pushes, and landing for those items. Ordinary review-only, triage-only, listing, or landable-shortlist requests are read-only: they authorize neither local source edits nor GitHub writes, including labels, assignments, public comments, closures, pushes, or landing, unless separately authorized. For authorized end-to-end landing work, a review summary or unlanded local patch is not completion: finish with a proven already-fixed close, a verified root-cause repair landed, or a specific evidence, ownership, product, safety, or authorization blocker.

## Start issue and PR triage with gitcrawl

- Use `$gitcrawl` first anytime you inspect OpenClaw issues or PRs.
- Check local `gitcrawl` data first for related threads, duplicate attempts, and already-landed fixes.
- Use `gitcrawl` for candidate discovery and clustering; use `gh`, `gh api`, and the current checkout to verify live state before commenting, labeling, closing, or landing.
- If `gitcrawl` is missing, stale, lacks the target thread, or has no embeddings for neighbor/search commands, fall back to the GitHub search workflow below.
- Do not run expensive/update commands such as `gitcrawl sync --include-comments`, future enrichment commands, or broad reclustering unless the user asked to update the local store or stale data is blocking the decision.

Common read-only path:

```bash
gitcrawl threads openclaw/openclaw --numbers <issue-or-pr-number> --include-closed --json
gitcrawl neighbors openclaw/openclaw --number <issue-or-pr-number> --limit 12 --json
gitcrawl search openclaw/openclaw --query "<scope or title keywords>" --mode hybrid --json
gitcrawl cluster-detail openclaw/openclaw --id <cluster-id> --member-limit 20 --body-chars 280 --json
```

## Inspect specific targets; claim only when authorized

When a maintainer asks Codex to review, triage, fix, or land a specific OpenClaw issue/PR, have the lead or assigned collaboration worker inspect live assignment before deep work. Assignment itself is a public GitHub write.

- Identify the requesting maintainer's GitHub login. In this environment, default Peter to `steipete`; if another maintainer is clearly the requester, use that maintainer's bare login.
- Read current assignees with live `gh issue view` / `gh pr view`; `gitcrawl` is not enough for assignment state.
- If unassigned, assign the requester only when an explicit land, fix-and-land, autonomous-resolution, or assignment request authorizes that mutation. For fix-only, review-only, triage-only, listing, or shortlist requests, report `unassigned` without assigning unless assignment is separately requested. Never auto-assign broad discovery candidates or shortlists.
- If assigned to someone else, say so clearly before analysis and include assignment age:
  - fresh: assigned within 6h; treat as actively owned unless user explicitly asks to continue or reassign
  - stale: assigned 6h+ ago; treat as ownership hint, not a hard block; continue only with that caveat
- If assigned to requester plus others, mention co-assignees and continue.
- If assignment event time is unavailable, say `assigned, time unknown`; treat as assigned, not stale.
- Never remove or replace assignees unless explicitly asked.

Assignment time proof:

```bash
gh api "repos/openclaw/openclaw/issues/<number>/timeline" --paginate \
  -H "Accept: application/vnd.github+json" \
  --jq '[.[] | select(.event=="assigned") | {assignee:.assignee.login, assigner:.assigner.login, actor:.actor.login, created_at}]'
```

Use the newest `assigned` event for each current assignee. Issue timeline events expose `created_at`; GitHub GraphQL `AssignedEvent.createdAt` is also valid when REST pagination is awkward.

Claim command for issues or PRs:

```bash
gh api -X POST "repos/openclaw/openclaw/issues/<number>/assignees" -f 'assignees[]=<login>' >/dev/null
```

## Surface opener identity

- For every reviewed, triaged, closed, or landed issue/PR, show the opener's human name when available, GitHub login, and account age.
- Get the login from `gh issue view` / `gh pr view` (`author.login`), then fetch profile metadata once with `gh api users/<login> --jq '{login,name,created_at,type}'`.
- Report opener identity as one compact line:
  `By: Jane Doe (@jane, acct 2021-04-03) | OpenClaw: 4 PRs, 2 issues, 11 commits/12mo | GitHub: 9 repos, 86 commits, 9 PRs, 3 issues, 12 reviews`
- Always show recent activity in two lanes: OpenClaw-local PRs, issues, and commits in the last 12 months; and general public GitHub activity over the same window. For linked issue-fixing PRs, include both the PR author and issue opener when they differ.
- Prefer the bundled helper for activity lookups:

```bash
.agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh <login> [other-login...]
.agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh --global <login>
```

- The helper reports repo-local activity first and can fetch public GitHub contribution totals for the same window with `--global`; run the global form by default for review/triage identity summaries.
- If the global contribution graph reports zero or looks inconsistent with visible public activity, sanity-check with `gh api users/<login>`, `gh api 'users/<login>/events/public?per_page=100'`, and recent public repo commits before calling the account inactive.
- The helper is intentionally cache-friendly for gitcrawl-backed `gh`: it rounds repo-local windows to the UTC day, rounds global contribution windows to the UTC hour, and counts PRs/issues from one paginated issues response before fetching commits separately. Prefer reusing the helper instead of hand-rolling several `gh api` loops.
- If the contribution graph is misleading or zero but public events/repos show activity, keep it one line, for example:
  `By: pickaxe (@ProspectOre, acct 2019-08-24) | OpenClaw: 5 PRs, 0 issues, 5 commits/12mo | GitHub: 5 repos, 29 recent events, 100 public own-repo commits; graph=0`
- If `name` is empty, use the login only. If profile lookup is rate-limited or unavailable, say `account age unknown` rather than omitting the opener.
- Use identity and activity as triage signal, not proof by itself: new, low-activity, or bot-like accounts can raise review caution, but code, repro, and CI evidence still decide.

## Suppress recent wide-access maintainer PRs in triage

In generic issue/PR triage, hot queues, landable shortlists, or "what is still open", exclude PRs authored by maintainers with broad repository access until 14 days after `created_at`. Prefer external contributors' PRs. An ordinary request for landing candidates does not override the age gate. Continue suppressing maintainer-authored issues by default.

Treat live repository permission as the source of truth. Before surfacing a finalist whose access is not already known, check `gh api repos/openclaw/openclaw/collaborators/<login>/permission`; suppress write, maintain, or admin access even when the login is absent from the fast-path list below. Read or triage access alone does not trigger suppression unless the login is explicitly listed.

Suppress by default when the opener/author is one of:

- `@vincentkoc`
- `@Takhoffman`
- `@gumadeiras`
- `@obviyus`
- `@shakkernerd`
- `@mbelinky`
- `@joshavant`
- `@pgondhi987`
- `@mmaps`
- `@ngutman`
- `@vignesh07`
- `@huntharo`

Also suppress lower-priority maintainer-owned noise from the broader keep/top-maintainer group unless it is directly relevant:

- `@thewilloftheshadow`
- `@onutc` / `@osolmaz`
- `@jacobtomlinson`
- `@tyler6204`
- `@velvet-shark`
- `@jalehman`
- `@frankekn`
- `@ImLukeF`
- `@mcaxtr`

Exceptions:

- Once a maintainer-authored PR is at least 14 days old, triage it normally.
- A specific PR/issue number or an explicit request for maintainer-owned work overrides suppression.
- When a recent maintainer PR is the canonical fix for an external hot issue, mention it only as the fix path; do not count it as a triage or landing candidate.
- Do not close, label, or deprioritize solely because an item is maintainer-authored; this section only controls what appears in triage shortlists.

## Apply close and triage labels correctly

- If an issue or PR matches an auto-close reason, apply its label only when labeling or closure is explicitly authorized; let `.github/workflows/auto-response.yml` handle the comment/close/lock flow. Without that authority, report the matching reason without mutating GitHub.
- Do not manually close plus manually comment for these reasons.
- If an issue/PR is provably fixed on current `main` and closing is authorized, comment with focused proof plus the canonical commit/PR and any relevant release, then close it.
- `r:*` labels can be used on both issues and PRs.
- Current reasons:
  - `r: skill`
  - `r: support`
  - `r: no-ci-pr`
  - `r: too-many-prs`
  - `r: testflight`
  - `r: third-party-extension`
  - `r: moltbook`
  - `r: spam`
  - `invalid`
  - `dirty` for PRs only

## Select explicitly small high-confidence triage candidates

When explicitly asked for `X` small, easy, or narrowly scoped issues or PRs to triage, `X` means qualified candidates, not sampled threads. These shortlist filters do not apply to a confirmed issue/PR selected for end-to-end repair; do not reject its correct root-cause fix merely because a coherent owner-boundary refactor is required.

Plain review, triage, listing, and shortlist requests are read-only: the lead or workers inspect and report candidates without editing files or mutating GitHub. Only an explicit scoped fix request authorizes this patch-local/proof flow; shipping and public writes still require separate approval:

1. Review the issue body, comments, related threads, current code, and adjacent tests.
2. Fix only shortlisted issues whose root cause and owning architectural neighborhood are high-confidence.
3. Add focused regression proof when practical.
4. Stop with the dirty diff, touched files, and test/gate output for maintainer review.
5. After maintainer approval to ship, make one commit per accepted fix, with release-note context in the PR body or commit message when user-facing.
6. After authorization, synchronize and push for the actual destination: direct `main` must rebase onto latest `origin/main` without merge commits; rebase a PR only for an actual conflict, failing native guard/exact-head check, explicit user request, or material stale-base risk, never merely because `main` advanced. Comment and close only issues proven fixed on `main` or explicitly triaged closed.

Do not batch unrelated issue fixes into one commit. Do not publish, assign, comment, close, or label during the review/prove phase.

Missing `CHANGELOG.md` is not a PR review finding or merge blocker. If landing/fixing a user-visible change, make sure the PR body or commit message captures the release-note context; never ask or block solely on it.

Only list candidates that pass all gates:

- small owner/surface, with a likely narrow fix and focused regression test
- symptom is reproducible or provable with logs, failing test, live command, dependency contract, or current-main behavior
- root cause is traceable to code with file/line and the proposed fix touches that path
- no strong smell that a broader refactor, ownership rethink, migration, or product decision is the better fix
- dependency-backed behavior checked against upstream docs/source/types; live or web proof used when local proof is insufficient

Loop:

1. Use `gitcrawl` / `gh` to gather candidate clusters.
2. Read issue/PR body, comments, current code, adjacent tests, and dependency contracts.
3. Try focused repro or proof.
4. Reject unclear, stale, speculative, broad-refactor, or owner-ambiguous items.
5. Continue until `X` qualified candidates or the bounded search is exhausted.

Output only qualifying candidates, with: ref, surface, proof, cause, fix sketch, why small, expected test/gate. If none qualify, say so; do not pad.

## Structure PR review output

- Start every PR review with 1-3 plain sentences explaining what the change does and why it matters. Put this before `Findings`.
- Then list findings first. If none, say `No blocking findings` or `No findings`.
- Show size near the top as `Production LOC: +<additions>/-<deletions> (net <delta>) | Tests: +<additions>/-<deletions>`, classifying per-file `git diff --numstat` or live PR file stats. Optional aggregate PR totals never replace the production/test split; justify positive production growth.
- Always answer: bug/behavior being fixed, PR/issue URL and affected surface, provenance for regressions when traceable, and best-fix verdict.
- For bug/regression fixes, include a compact `Provenance:` line after cause/root-cause when a bounded history pass can identify it. Use `git log -S/-G`, `git blame`, linked PRs/issues, and tests.
- Provenance must separate roles when they differ: blamed code author username, blamed PR author username, blamed PR merger/committer username, automerge trigger when known, current PR author username, PR number, and date. Do not collapse them into one "introduced by" actor.
- If the blamed PR was merged by `clawsweeper[bot]` or another automation, identify the human trigger when practical. Check live PR timeline/comments first; if rate-limited, use gitcrawl/cache or public PR HTML. Look for maintainer command comments such as `@clawsweeper automerge`, `/landpr`, labels/events that armed automerge, and ClawSweeper status comments. Report `automerge triggered by @login`; if not found, say trigger unknown rather than naming the bot as the human decision-maker.
- For any confirmed bug, run `git blame` on the implicated line(s) after identifying the root cause. Report who broke it as the blamed PR merger/committer, and also name the blamed code author. Include the PR number. If no PR is traceable, use the blamed commit as the provenance: commit SHA, date, and author username. Do not guess a merger or frame missing PR metadata as a separate finding.
- Phrase provenance as `introduced by`, `made visible by`, or `carried forward by`, with confidence (`clear`, `likely`, `unknown`). If unclear, say what evidence is missing instead of guessing. For features, docs, and refactors, use `Provenance: N/A` or omit it when no broken behavior is being fixed.
- Keep summaries compact, but include enough proof that the verdict is auditable without rereading the PR.

LOC proof:

```bash
gh pr view <number> --json additions,deletions,changedFiles \
  --jq '"LOC: +\(.additions)/-\(.deletions) (\(.changedFiles) files)"'
git diff --numstat <base-sha>...<head-sha>
```

## Read beyond the diff

- Review the surrounding code path, not just changed lines. Open the caller, callee, data contracts, adjacent tests, and owner module.
- Before any verdict, read enough code to fill this map: changed surface, runtime entry point, owner boundary, one caller, one callee, sibling implementations sharing the invariant, adjacent tests, current `main` behavior, and shipped/dependency/Codex contracts when relevant.
- For large-codebase PRs, sample enough related files to understand the runtime boundary before deciding. Default to more code reading when the change touches agents, gateway, plugins, auth, sessions, process, config, or provider/runtime seams.
- Compare the PR against current `origin/main` behavior. Check whether recent main already changed the same surface.
- Dependency-backed behavior: MUST read upstream docs/source/types before judging API use, defaults, output shapes, errors, timeouts, memory behavior, or compatibility. Do not assume dependency contracts from memory or PR text.
- Judge solution quality, not only correctness. Ask whether the PR is the clean owner-boundary fix or a wart/workaround that should be replaced by a small refactor, moved seam, contract change, or deletion of duplicate logic.
- Mention the main files read when the verdict depends on code-path evidence.
- If the user challenges the verdict or asks whether the idea is really good, resume code reading first. Do not defend, soften, or reverse the verdict until the missing caller/callee/sibling/dependency path is checked.

## Best-fix review loop

Every PR review must explicitly answer: "Is this the best fix, or only a plausible fix?"

Before verdict:

1. Reconstruct the bug, feature need, or behavior claim from issue/PR/proof.
2. Trace current behavior from entry point to failure or decision point.
3. Read touched files, callers, callees, owner modules, adjacent tests, and relevant docs.
4. Read sibling surfaces that should share the invariant or could be broken by a one-sided fix.
5. Compare against current `origin/main` and shipped behavior when regression/compat matters.
6. Inspect upstream dependency/Codex source or docs for dependency-backed behavior.
7. Identify at least one alternative fix location or shape, then reject it with evidence.
8. If any required path above is uninspected, keep reading or mark `Remaining uncertainty`; do not call the PR best, blocked, proof-sufficient, or merge-ready.

Review output must include:

- `Best-fix verdict:` best / acceptable mitigation / wrong layer / too narrow / too broad.
- `Alternatives considered:` 1-3 concrete alternatives and why rejected.
- `Code read:` compact list of main files/contracts checked.
- `Remaining uncertainty:` what was not proven.

If the best-fix answer is only "maybe", keep reading or state the missing evidence. Do not call proof sufficient until the best-fix judgment is explicit.

## Enforce the bug-fix evidence bar

- Never merge a bug-fix PR based only on issue text, PR text, or AI rationale.
- Choose the strongest proof proportionate to the owner boundary and risk. When
  feasible, prefer Crabbox (`$crabbox`) or a real packaged/Docker/live lane
  exercising the reported user flow before closing or landing; do not confuse
  packaged, mocked, Docker, or unit proof with live authenticated proof.
- For a bounded deterministic owner defect, optional unavailable provider/channel
  live proof may be replaced **only when the user explicitly relaxes it** by a
  failing/passing focused owner-boundary regression, direct producer/caller/sibling
  and dependency/source contract inspection, independent review, and exact-head
  green required CI. Record the missing live/rank-up evidence openly. External
  API work, security-sensitive changes, explicitly requested live proof, and risk
  requiring real authenticated execution retain their mandatory live-proof gate.
- Before landing, require:
  1. symptom evidence such as a repro, logs, or a failing test
  2. a verified root cause in code with file/line
  3. blame-backed provenance for regressions when traceable, including blamed PR merger and automerge trigger when known, or commit SHA/date when no PR is traceable
  4. a fix that touches the implicated code path
  5. a regression test when feasible, or explicit manual verification plus a reason no test was added
- If the claim is unsubstantiated or likely wrong, obtain the missing evidence or make authorized owner-boundary repairs; never merge without proof.
- If the linked issue appears outdated or incorrect, correct triage first. Do not merge a speculative fix.
- If optional Crabbox/E2E/live proof is unavailable and the user explicitly
  relaxes it, state the exact gap and use the strongest focused owner-boundary
  and exact-head CI evidence. Never claim substitutes are live or waive mandatory
  external-API, security, or explicitly requested live proof.

## Close low-signal manual PRs carefully

- Do not close for red CI alone. Require a clear low-signal category plus stale or failed validation.
- Good manual-close categories:
  - blank or mostly untouched PR template with no concrete OpenClaw problem/fix
  - random docs-only churn such as root README translations, generic wording tweaks, or community-plugin discoverability docs that should go through ClawHub
  - test-only coverage without a linked bug, owner request, or behavior change
  - refactor-only cleanup, variable renames, formatting, or generated/baseline churn without maintainer request
  - third-party channel/provider/tool/skill/plugin work that belongs on ClawHub instead of core
  - risky ops/infra drive-bys such as new external CI services, release workflows, host upgrade scripts, Docker base migrations, or apt retry/fix-missing tweaks without owner request and green validation
  - dirty branches where a narrow stated change includes unrelated docs/generated/runtime/extension files
  - repeated bot-review spam or copied bot output without author-owned fixes
- Keep or escalate plausible focused bug fixes, green PRs, active maintainer discussions, assigned work, recent author follow-up, and unique reproduction details.
- For third-party capabilities, prefer the `r: third-party-extension` auto-response label when it applies; it points contributors to publish on ClawHub.

## Handle GitHub text safely

- For issue comments and PR comments, use literal multiline strings or `-F - <<'EOF'` for real newlines. Never embed `\n`.
- Do not use `gh issue/pr comment -b "..."` when the body contains backticks or shell characters. Prefer a single-quoted heredoc.
- Do not wrap issue or PR refs like `#24643` in backticks when you want auto-linking.
- PR landing comments should include clickable full commit links for landed and source SHAs when present.

## Search broadly before deciding

- Prefer `gitcrawl` first. Then use targeted GitHub keyword search to verify gaps, live status, comments, and candidates not present in the local store.
- Use `--repo openclaw/openclaw` with `--match title,body` first when using `gh search`.
- Add `--match comments` when triaging follow-up discussion or closed-as-duplicate chains.
- Do not stop at the first 500 results when the task requires a full search.

Examples:

```bash
gh search prs --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"
gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"
gh search issues --repo openclaw/openclaw --match title,body --limit 50 \
  --json number,title,state,url,updatedAt -- "auto update" \
  --jq '.[] | "\(.number) | \(.state) | \(.title) | \(.url)"'
```

## Follow PR review and landing hygiene

- `scripts/pr` requires `git`, `gh`, `jq`, `rg` (ripgrep), `pnpm`, and `node`
  on the maintainer host. Let its preflight fail loudly when one is missing.
  Tests that source `scripts/pr-lib/*` directly must provide the same command
  surface instead of weakening the production wrapper for a minimal test image.
- Classify source trust before executing code-changing or landing proof; acquire
  a safe remote backend lazily through `$crabbox` only when the current host
  gate requires one; never pre-warm it at task start. Trusted maintainer code
  runs suitable proof on a dedicated Linux worker and otherwise defaults to Blacksmith Testbox;
  contributor/fork code stays untrusted unless a maintainer explicitly approves
  credentialed execution after review; it uses secretless fork CI or
  sanitized direct AWS Crabbox with `CRABBOX_ENV_ALLOW=CI`,
  `--no-hydrate`, and a fresh temporary remote `HOME`, never the
  credential-hydrated Testbox workflow or a previously hydrated lease. Launch
  an installed trusted Crabbox binary from clean trusted `main`, fetch the PR
  with `--fresh-pr`, unset and reject any resolved AWS instance profile, verify
  trusted IMDS reports no IAM credentials, bind the lease to the reviewed head
  SHA, and never execute its local wrapper or config. Upload trusted
  `scripts/crabbox-untrusted-bootstrap.sh` from clean `main` alongside
  `--fresh-pr`; it installs the pinned Node/pnpm runtime before executing PR
  code. Force public networking, disable and
  unset inherited Tailscale/exit-node settings, and fail closed unless
  `crabbox inspect` reports no Tailscale state before any script. Rewarm after
  any head change, sync every run, reuse the lease, then stop it before handoff.
  Do not acquire a backend for read-only triage or docs-only work.
- Never mention release-note bookkeeping in review-only output. It is landing
  or release-generation mechanics, not a correctness finding.
- If bot review conversations exist on your PR, address them and resolve them yourself once fixed.
- Leave a review conversation unresolved only when reviewer or maintainer judgment is still needed.
- Before landing any PR with non-trivial code changes, run fresh `$autoreview` until no accepted/actionable findings remain; prior CI, ClawSweeper, or manual review is not a substitute. Skip only for truly trivial/docs-only changes or when the user explicitly opts out.
- When an agent is landing or merging a PR targeting `main`, use only the repo-native `scripts/pr` wrapper: run `scripts/pr review-init <PR>`, follow its emitted checkout/guard guidance, initialize and complete review artifacts with `scripts/pr review-artifacts-init <PR>`, validate them with `scripts/pr review-validate-artifacts <PR>`, then run `OPENCLAW_TESTBOX=1 scripts/pr prepare-run <PR>` and `scripts/pr merge-run <PR>`. The Testbox flag is mandatory for agents: it verifies hosted CI/Testbox on the current head or reuses a patch-identical pre-rebase run green within 24 hours instead of running full `pnpm` gates locally. `prepare-run` fails fast; invoke only after exact-head CI is complete and green, and do not idle on `auto-response` or `check-docs`. For owner-approved reviewed fork code without hosted Testbox, use `OPENCLAW_PR_GATES_REMOTE=testbox` instead. Do not rebase only because `main` advanced; behind-main drift is advisory unless strict drift is explicitly enabled, while GitHub still blocks conflicts.
- `scripts/pr` gotchas: subcommands require a PR number (no subcommand `--help` placeholder). Artifacts preserve template enum values with evidence detail in summaries; validate before prepare, from PR-head mode (moving main invalidates the main-baseline guard). Review flow: checkout main baseline, then PR, before artifact validation. After every PR push, rerun `scripts/pr review-init`; checkout alone leaves a stale guard SHA. Locally unset `GITHUB_TOKEN`, `GH_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN`; ambient tokens can select an exhausted or wrong identity. Review JSON: land-ready recommendation `READY FOR /prepare-pr`, `issueValidation.status=valid`; never `APPROVE`. After `scripts/pr merge-run` removes its worktree, `cd` to a persistent repo before follow-up commands.
- After GitHub throttling, check core quota before `scripts/pr prepare-run` or `merge-run`. A failed operation can retain its lock; verify no child remains, then recover only with its emitted token.
- Non-main PRs: do not run `scripts/pr prepare-run` or `merge-run`; they diff against `main`. Use review artifacts, exact base-head CI, revalidate `headRefOid`, then `gh pr merge --match-head-commit <verified-sha>`.
- PR-create merge-ref race recognition: the dropped/killed pull_request CI run appears as `startup_failure`/`BuildFailed` (`(Unknown event)`) and is not rerunnable — close/reopen or wait for the hourly `pr-ci-sweeper`; rerun attempts are wasted.
- PR/issue media upload: 422 = unsupported type; 404 = bad repo id/no push. Video: `content_type` `video/mp4` or `video/webm`; embed the returned URL on its own bare line — GitHub renders a player, `![]()` does not; transcode Playwright webm via `ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4` for broad playback. Non-media artifacts or endpoint failure: Crabbox artifact publishing plus the manifest URL.
- Use standard Git commands and stage only the files intended for each commit.
- Keep commit messages concise and action-oriented.
- Group related changes; avoid bundling unrelated refactors.
- Use `.github/pull_request_template.md` for PR submissions and `.github/ISSUE_TEMPLATE/` for issues.
- Do not commit PR-only artifacts such as screenshots under `.github/pr-assets`; attach them to the PR/comment or use an external artifact store instead.

## Extra safety

- Closing or reopening more than 20 PRs needs an explicitly authorized bounded count and scope. Standing full authority covers an already specified count/scope; more than 50 still requires separate explicit exact-count/scope approval under root policy.
- `sync` means synchronize only task-owned, explicitly authorized changes. Preserve unrelated dirty files untouched; use an isolated task-owned/native-managed worktree or nondestructive scoped publication when needed. Never commit all dirty changes, stage/stash/discard unrelated edits, or pull/rebase a dirty shared checkout; resolve only task-owned conflicts safely.
