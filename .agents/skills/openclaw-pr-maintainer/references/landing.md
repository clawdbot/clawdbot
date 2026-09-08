# Publication and native landing

Use only under scoped publication/landing authority. Preserve root approval,
source-trust, contributor-credit, and exact-head requirements. Never publish
release artifacts under ordinary ship authority.

## Checkout and source

`scripts/pr` owns review/prepare worktrees under the canonical repository. If that
location is outside writable scope, use a fresh full ordinary checkout inside the
allowed workspace before initializing the operation. Preserve complete history
and blobs for provenance. Do not clone away an active/uncertain operation or use a
new lock namespace to retry an uncertain merge.

Run the trusted canonical/origin-main wrapper. Untrusted PR code must not supply
the local wrapper or execute locally; use the source isolation procedure from
`$openclaw-testing` and `$crabbox`. Do not weaken guards to accommodate missing
commands or dependencies. The wrapper requires git, gh, jq, rg, pnpm, and node.
Unset ambient `GITHUB_TOKEN`, `GH_TOKEN`, and `HOMEBREW_GITHUB_API_TOKEN` when they
could select the wrong writer.

## Open or update the PR

Use the current template and a real body file. Preserve human credit and keep
branches editable by maintainers when safe. For a fork, consider GitHub's
Actions/secrets warning before enabling edits.

Create as draft, wait for non-null `mergeable`, then mark ready. Confirm CI
attached to the pushed head. A merge-ref startup failure cannot be rerun; the
hourly PR CI sweeper can re-fire it, or use an authorized close/reopen after
verifying the missing attachment. Do not rebase merely because main advanced.
Refresh only for a conflict, failing guard, explicit request, or material stale
base risk. An explicitly requested landing of one's own draft includes marking
it ready when needed.

## Evidence media

Read the [media upload reference](media.md) for feature detection, endpoint
commands, supported formats, and artifact fallback.

Inspect and sanitize every capture before upload. Use `gh --attach` only if the
installed command exposes it; otherwise use GitHub's user-attachments endpoint.
Never use browser upload, commit proof media into product branches, or use the
unrelated `gh attach` extension. Uploads are permanent and inherit repository
visibility. For unsupported artifacts or endpoint failure, use the repository's
approved artifact store; do not invent an external destination.

Keep images embedded and video URLs on their own lines for GitHub playback.
Feature-detect format/size support rather than assuming a particular CLI release.
Do not disclose private desktop content, identifiers, model routes, or secrets.

## Review, prepare, merge

For main-targeted PRs, use only the native sequence:

```bash
scripts/pr review-init <pr>
scripts/pr review-checkout-main <pr>
scripts/pr review-checkout-pr <pr>
scripts/pr review-artifacts-init <pr>
# Complete the generated review artifacts for this exact head.
scripts/pr review-validate-artifacts <pr>
# Invoke only after exact-head required CI is green.
OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
scripts/pr merge-run <pr>
```

Keep the generated first line of `review.md`, `review.json` PR identity, and head
stamp intact. Use template enum values; a land-ready recommendation is `READY
FOR /prepare-pr`. After every push, rerun `review-init`; checkout alone does not
refresh the guard. Validate from PR-head mode. Do not fabricate passing evidence
or erase a failing review condition.

The agent Testbox flag verifies hosted evidence instead of running full gates
locally. The wrapper may accept a patch-identical recently green pre-rebase run;
it owns that decision. For explicitly owner-approved reviewed fork code without
hosted Testbox, use the documented `OPENCLAW_PR_GATES_REMOTE=testbox` path.

Watch one exact head with `node scripts/watch-pr-ci.mjs <pr> <head-sha>`; use narrow
JSON check/run reads and fetch failed logs once. Address substantive human/bot
findings and resolve fixed conversations. A queued bot score update is not a
separate landing gate. Check live rules and review state before claiming a human
approval is mandatory; bypass ability is not authorization to skip an enforced
review.

For non-main targets, do not use `prepare-run` or `merge-run`: their base is main.
Use review artifacts and exact base/head CI, revalidate the remote head, and
merge with `gh pr merge --match-head-commit <verified-sha>` under the same authority.

## Recovery and closeout

A failed operation can retain a lock. Verify no owned child tools remain, then
recover only with the exact token and command the wrapper printed. Never remove
locks by hand or start competing retries. After throttling, inspect quota before
retrying native prepare/merge.

A failed or timed-out merge response can still mean GitHub merged it. Reconcile
remote state and ancestry before retrying. Verify the final merge commit is on
current main; do not count a draft, pending check, or local summary as landing.
After `merge-run` removes its worktree, switch command execution back to a
persistent checkout. Clean only task-owned state and return the task checkout to
current main, detached if another checkout owns the branch.

Preserve the operator-facing narrative: what failed, the owning repair, important
proof and limitations, human credit, and linked final state. Record material
tradeoffs or remaining uncertainty, not a mandatory proof essay.
