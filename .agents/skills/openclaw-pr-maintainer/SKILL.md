---
name: openclaw-pr-maintainer
description: Use immediately for any pasted OpenClaw GitHub issue or PR URL/number, and for OpenClaw issue/PR review, triage, duplicate search, opener identity/who wrote it, author account age/activity, comments, labels, close, land, or maintainer evidence checks.
---

# OpenClaw PR Maintainer

Use this skill for maintainer-facing GitHub workflow, not for ordinary code changes.

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

## Suppress top-maintainer items in issue triage

When asked for issue triage, hot issues, pressing bugs, Discord-correlated issues, or "what is still open", do not surface issues or PRs authored by top maintainers by default. Prefer external/user-reported hot issues and external PRs, not maintainer-owned work queues.

Suppress by default when the opener/author is one of:

- `@vincentkoc`
- `@Takhoffman`
- `@gumadeiras`
- `@obviyus`
- `@shakkernerd`
- `@mbelinky`
- `@joshavant`
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

- Show maintainer-authored items when the requester explicitly asks for maintainer PRs/issues, PR landing candidates, release-blocking maintainer work, or a specific PR/issue number.
- Show a maintainer-authored item when it is the canonical fix for an external hot issue, but frame it as the fix path rather than as a user-facing issue candidate.
- Do not close, label, or deprioritize solely because an item is maintainer-authored; this section only controls what appears in triage shortlists.

## Apply close and triage labels correctly

- If an issue or PR matches an auto-close reason, apply the label and let `.github/workflows/auto-response.yml` handle the comment/close/lock flow.
- Do not manually close plus manually comment for these reasons.
- If an issue/PR is already fixed on current `main` or solved by a new release, comment with proof plus the canonical commit/PR/release, then close it.
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

## Select small high-confidence triage candidates

When asked for `X` issues or PRs to triage, `X` means qualified candidates, not sampled threads.

Issue triage is review/prove/patch-local by default:

1. Review the issue body, comments, related threads, current code, and adjacent tests.
2. Fix only issues that are easy, high-confidence, and narrowly owned by the implicated path.
3. Add focused regression proof when practical.
4. Stop with the dirty diff, touched files, and test/gate output for maintainer review.
5. After maintainer approval to ship, make one commit per accepted fix, with its own changelog entry when user-facing.
6. Pull/rebase, push, then comment and close only the issues that were fixed or explicitly triaged closed.

Do not batch unrelated issue fixes into one commit. Do not publish, comment, close, or label during the review/prove phase.

Missing changelog is not a PR review finding or merge blocker. If landing/fixing a user-visible change, add/update changelog automatically when practical; never ask or block solely on it.

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
- Always answer: bug/behavior being fixed, PR/issue URL and affected surface, and best-fix verdict.
- Keep summaries compact, but include enough proof that the verdict is auditable without rereading the PR.

## Read beyond the diff

- Review the surrounding code path, not just changed lines. Open the caller, callee, data contracts, adjacent tests, and owner module.
- For large-codebase PRs, sample enough related files to understand the runtime boundary before deciding. Default to more code reading when the change touches agents, gateway, plugins, auth, sessions, process, config, or provider/runtime seams.
- Compare the PR against current `origin/main` behavior. Check whether recent main already changed the same surface.
- Dependency-backed behavior: MUST read upstream docs/source/types before judging API use, defaults, output shapes, errors, timeouts, memory behavior, or compatibility. Do not assume dependency contracts from memory or PR text.
- Judge solution quality, not only correctness. Ask whether the PR is the clean owner-boundary fix or a wart/workaround that should be replaced by a small refactor, moved seam, contract change, or deletion of duplicate logic.
- Mention the main files read when the verdict depends on code-path evidence.

## Enforce the bug-fix evidence bar

- Never merge a bug-fix PR based only on issue text, PR text, or AI rationale.
- Whenever feasible, use Crabbox (`$crabbox`) for end-to-end verification before
  commenting that a bug is unreproducible, closing an issue, or opening/landing
  a fix PR. Prefer a real packaged/Docker/live lane that exercises the reported
  user flow over unit-only proof.
- Before landing, require:
  1. symptom evidence such as a repro, logs, or a failing test
  2. a verified root cause in code with file/line
  3. a fix that touches the implicated code path
  4. a regression test when feasible, or explicit manual verification plus a reason no test was added
- If the claim is unsubstantiated or likely wrong, request evidence or changes instead of merging.
- If the linked issue appears outdated or incorrect, correct triage first. Do not merge a speculative fix.
- If Crabbox/E2E proof is blocked, say exactly why and use the closest available
  local, Docker, mocked, or targeted proof. Do not present unit tests as real
  behavior proof.

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

- Never mention merge conflicts that are relatively easy to resolve, such as
  `CHANGELOG.md` entries, in review-only output. These are landing mechanics,
  not correctness findings.
- If bot review conversations exist on your PR, address them and resolve them yourself once fixed.
- Leave a review conversation unresolved only when reviewer or maintainer judgment is still needed.
- When landing or merging any PR, follow the global `/landpr` process.
- Use `scripts/committer "<msg>" <file...>` for scoped commits instead of manual `git add` and `git commit`.
- Keep commit messages concise and action-oriented.
- Group related changes; avoid bundling unrelated refactors.
- Use `.github/pull_request_template.md` for PR submissions and `.github/ISSUE_TEMPLATE/` for issues.
- Do not commit PR-only artifacts such as screenshots under `.github/pr-assets`; attach them to the PR/comment or use an external artifact store instead.

## Extra safety

- If a close or reopen action would affect more than 5 PRs, ask for explicit confirmation with the exact count and target query first.
- `sync` means: if the tree is dirty, commit all changes with a sensible Conventional Commit message, then `git pull --rebase`, then `git push`. Stop if rebase conflicts cannot be resolved safely.
