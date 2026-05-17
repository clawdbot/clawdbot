---
name: codex-review
description: "Codex code review closeout: local dirty changes, PR branch vs main, parallel tests."
---

# Codex Review

Run Codex's built-in code review as a closeout check. This is code review (`codex review`), not Guardian `auto_review` approval routing.

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
- Keep going until Codex review returns no accepted/actionable findings.
- If a review-triggered fix changes code, rerun focused tests and rerun Codex review.
- Never switch or override the review model. If the review hits model capacity, retry the same command a few times with the same model. The helper runs nested review in yolo/full-access mode by default; use `--no-yolo` only when intentionally testing sandbox behavior.
- Stop as soon as the review command/helper exits 0 with no accepted/actionable findings. Do not run an extra direct `codex review` just to get a nicer "clean" line, a second opinion, or clearer closeout wording.
- Treat the helper's successful exit plus absence of actionable findings as the clean review result, even if the underlying Codex CLI output is terse.
- If rejecting a finding as intentional/not worth fixing, add a brief inline code comment only when it explains a real invariant or ownership decision that future reviewers should know.
- Do not push just to review. Push only when the user requested push/ship/PR update.

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

Do not pass an inline prompt with `--base`; current CLI rejects `--base` + `[PROMPT]` even though help text is ambiguous. If custom instructions are needed, run the plain base review first, then do a local/manual follow-up pass.

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
/Users/steipete/Projects/agent-scripts/skills/codex-review/scripts/codex-review --mode commit --commit HEAD
```

Use commit review for already-landed or already-pushed work on `main`. Reviewing
clean `main` against `origin/main` is usually an empty diff after push. For a
small stack, review each commit explicitly or review the branch before merging
with `--base`.

## Parallel Closeout

Format first if formatting can change line locations. Then it is OK to run tests and review in parallel:

```bash
scripts/codex-review --parallel-tests "<focused test command>"
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
~/.codex/skills/codex-review/scripts/codex-review --help
```

If installed from `agent-scripts`, path is:

```bash
/Users/steipete/Projects/agent-scripts/skills/codex-review/scripts/codex-review --help
```

The helper:
- chooses dirty `--uncommitted` first
- otherwise uses current PR base if `gh pr view` works
- otherwise uses `origin/main` for non-main branches
- use `--mode commit --commit <ref>` for already-committed work, especially clean `main` after landing
- should be left in `--mode auto` or forced to `--mode branch` for PR/branch work; do not force `--mode local` after committing
- writes only to stdout unless `--output` or `CODEX_REVIEW_OUTPUT` is set
- supports `--dry-run`, `--parallel-tests`, and commit refs
- runs nested review with `--dangerously-bypass-approvals-and-sandbox` by default
- keeps accepting `--full-access`; use `--no-yolo` or `CODEX_REVIEW_YOLO=0` to opt out
- prints `codex-review clean: no accepted/actionable findings reported` when the selected review command exits 0

## Final Report

Include:
- review command used
- tests/proof run
- findings accepted/rejected, briefly why
- the clean review result from the final helper/review run, or why a remaining finding was consciously rejected

Do not run another Codex review solely to improve the final report wording. If the final helper run exited 0 and produced no accepted/actionable findings, report that exact run as clean.
