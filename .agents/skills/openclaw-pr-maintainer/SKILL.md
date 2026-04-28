---
name: openclaw-pr-maintainer
description: Review, triage, close, label, comment on, or land OpenClaw PRs/issues with maintainer evidence checks.
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

## Apply close and triage labels correctly

- If an issue or PR matches an auto-close reason, apply the label and let `.github/workflows/auto-response.yml` handle the comment/close/lock flow.
- Do not manually close plus manually comment for these reasons.
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

## Enforce the bug-fix evidence bar

- Never merge a bug-fix PR based only on issue text, PR text, or AI rationale.
- Before landing, require:
  1. symptom evidence such as a repro, logs, or a failing test
  2. a verified root cause in code with file/line
  3. a fix that touches the implicated code path
  4. a regression test when feasible, or explicit manual verification plus a reason no test was added
- If the claim is unsubstantiated or likely wrong, request evidence or changes instead of merging.
- If the linked issue appears outdated or incorrect, correct triage first. Do not merge a speculative fix.

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
