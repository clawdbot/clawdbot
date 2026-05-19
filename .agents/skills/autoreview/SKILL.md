---
name: autoreview
description: "Autoreview closeout: local dirty changes, PR branch vs main, parallel tests."
---

# Autoreview

Run Codex's built-in code review as a closeout check. This is code review (`codex review`), not Guardian `auto_review` approval routing.

Codex native review mode performs best and is recommended. Non-Codex reviewers are fallback/second-opinion paths that receive a generated diff prompt, not the full Codex review-mode runtime.

Use when:
- user asks for Codex review / autoreview / second-model review
- after non-trivial code edits, before final/commit/ship
- reviewing a local branch or PR branch after fixes

## Contract

- Treat review output as advisory. Never blindly apply it.
- Verify every finding by reading the real code path and adjacent files.
- Read dependency docs/source/types when the finding depends on external behavior.
- Reject unrealistic edge cases, speculative risks, broad rewrites, and fixes that over-complicate the codebase.
- Prefer small fixes at the right ownership boundary; no refactor unless it clearly improves the bug class.
- Keep going until the selected review path returns no accepted/actionable findings.
- If a review-triggered fix changes code, rerun focused tests and rerun the review helper.
- Default to Codex review. If Codex is unavailable or exits with an error, the helper falls back to the first configured CLI from `claude -p`, `pi -p`, `opencode run`, `droid exec`, or `copilot`. Prefer Codex for final closeout because it uses native review mode; non-Codex reviewers use a Codex-inspired generated diff prompt. The helper runs nested Codex review in yolo/full-access mode by default; use `--no-yolo` only when intentionally testing sandbox behavior.
- Stop as soon as the review command/helper exits 0 with no accepted/actionable findings. Do not run an extra direct `codex review` just to get a nicer "clean" line, a second opinion, or clearer closeout wording.
- Treat the helper's successful exit plus absence of actionable findings as the clean review result, even if the underlying Codex CLI output is terse.
- If rejecting a finding as intentional/not worth fixing, add a brief inline code comment only when it explains a real invariant or ownership decision that future reviewers should know.
- Do not push just to review. Push only when the user requested push/ship/PR update.
- For OpenClaw maintainers, keep autoreview validation Crabbox/Testbox-aware when maintainer validation mode is enabled (`OPENCLAW_TESTBOX=1` or `AUTOREVIEW_OPENCLAW_MAINTAINER_VALIDATION=1`). A review pass may inspect files and run cheap non-Node probes, but it must not start local `pnpm`, Vitest, `tsgo`, `npm test`, or `node scripts/run-vitest.mjs` from a Codex/worktree review unless the operator explicitly requested local proof. For runtime proof, use existing evidence or route through Crabbox/Testbox and report the id. Do not apply this rule to ordinary contributors who do not have maintainer Testbox access.

## Pick Target

Dirty local work:

```bash
codex review --uncommitted
```

Use this only when the patch is actually unstaged/staged/untracked in the
current checkout. For committed, pushed, or PR work, point Codex at the commit
or branch diff instead; do not force `--mode local` / `--uncommitted` just
because the helper docs mention dirty work first. A clean `--uncommitted` review
only proves there is no local patch.

Branch/PR work:

```bash
git fetch origin
codex review --base origin/main
```

Do not pass any prompt with `--base`. Some Codex CLI versions reject both inline
and stdin prompt forms, including the helper's `codex review --base <ref> -`,
with `--base <BRANCH> cannot be used with [PROMPT]`. If the helper hits this
error, run plain `codex review --base <ref>` and report that the helper prompt
injection was skipped.

If an open PR exists, use its actual base:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
codex review --base "origin/$base"
```

Committed single change:

```bash
codex review --commit HEAD
```

or with the helper:

```bash
.agents/skills/autoreview/scripts/autoreview --mode commit --commit HEAD
```

Use commit review for already-landed or already-pushed work on `main`. Reviewing
clean `main` against `origin/main` is usually an empty diff after push. For a
small stack, review each commit explicitly or review the branch before merging
with `--base`.

## Parallel Closeout

Format first if formatting can change line locations. Then it is OK to run tests and review in parallel:

```bash
.agents/skills/autoreview/scripts/autoreview --parallel-tests "<focused test command>"
```

Tradeoff: tests may force code changes that stale the review. If tests or review lead to code edits, rerun the affected tests and rerun review until no accepted/actionable findings remain. Once that rerun exits cleanly, stop; do not spend another long review cycle on redundant confirmation.

## Context Efficiency

Codex review is usually noisy. Default to a subagent filter when subagents are available. Ask it to run the review and return only:
- actionable findings it accepts
- findings it rejects, with one-line reason
- exact files/tests to rerun

Run inline only for tiny changes or when subagents are unavailable.

## Helper

Bundled helper:

```bash
.agents/skills/autoreview/scripts/autoreview --help
```

The helper:
- chooses dirty `--uncommitted` first
- otherwise uses current PR base if `gh pr view` works
- otherwise uses `origin/main` for non-main branches
- auto-runs `PNPM_CONFIG_PM_ON_FAIL=ignore PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false PNPM_CONFIG_OFFLINE=true pnpm run check` in parallel when a repo has `package.json`, `pnpm-lock.yaml`, `node_modules`, and a `check` script; disable with `AUTOREVIEW_AUTO_TESTS=0`
- use `--mode commit --commit <ref>` for already-committed work, especially clean `main` after landing
- should be left in `--mode auto` or forced to `--mode branch` for PR/branch work; do not force `--mode local` after committing
- supports `--reviewer codex|claude|pi|opencode|droid|copilot|auto`; `auto` means Codex first
- supports `--fallback-reviewer auto|claude|pi|opencode|droid|copilot|none`; default is configured CLI fallback
- falls back only when Codex is unavailable or exits nonzero, not when Codex reports findings
- writes only to stdout unless `--output` or `AUTOREVIEW_OUTPUT` is set
- supports `--dry-run`, `--parallel-tests`, and commit refs
- runs nested review with `--dangerously-bypass-approvals-and-sandbox --sandbox danger-full-access` by default
- injects maintainer-only OpenClaw validation policy into native Codex review when `OPENCLAW_TESTBOX=1` or `AUTOREVIEW_OPENCLAW_MAINTAINER_VALIDATION=1`, so local memory-heavy Node/Vitest checks are avoided in favor of Crabbox/Testbox proof
- branch mode may fail on Codex CLI versions that reject `--base` plus the helper's stdin prompt; on that exact parser error, rerun plain `codex review --base <ref>` instead of falling back to a non-Codex reviewer
- keeps accepting `--full-access`; use `--no-yolo` or `AUTOREVIEW_YOLO=0` to opt out
- still accepts legacy `CODEX_REVIEW_*` env vars when the matching `AUTOREVIEW_*` var is unset
- prints `autoreview clean: no accepted/actionable findings reported` when the selected review command exits 0

## Final Report

Include:
- review command used
- tests/proof run
- findings accepted/rejected, briefly why
- the clean review result from the final helper/review run, or why a remaining finding was consciously rejected

Do not run another Codex review solely to improve the final report wording. If the final helper run exited 0 and produced no accepted/actionable findings, report that exact run as clean.

## PR / CI Closeout

- Prefer direct run/job APIs after CI starts: `gh run view <run-id> --json jobs`; use PR rollup only for final mergeability.
- After rebase, compare `origin/main..HEAD`; drop CI-fix commits already upstream before pushing.
- For prompt snapshot CI failures, prove/generate with Linux Node 24 before rerunning the failed job.
- Update PR body once near the final head unless proof labels are missing or stale enough to block CI.
