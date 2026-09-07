---
summary: "Wait on a pull request head, recover a stuck run, and clear the evidence gate"
title: "Watch a CI run"
read_when:
  - You are debugging a failing GitHub Actions check
  - You need to rerun or recover a pull request run
---

## Watching pull request CI

From a source checkout with an authenticated `gh` CLI, wait for one exact
pull-request head:

```bash
node scripts/watch-pr-ci.mjs <pr-number> <full-head-sha>
```

Maintainer GitHub helpers use the external `gh` on the caller's unchanged
`PATH`, so that route owns credentials, filtering, and any native delegation.
“Plain” means normalized terminal output: helpers do not discover native
installations, extract default-route tokens, or retry a refusal through another
binary. `OPENCLAW_GH_BIN` is an explicit operator-owned override for supporting
callers; choose it only when its authentication and protections are appropriate.
PATH-based read helpers, including this watcher, ignore that override.
Authoritative REST reads request revalidation with `Cache-Control: max-age=0`
and supply concrete repository paths. Writer identity comes from the authenticated
GraphQL viewer, not a relay's REST caller profile.

Before entering a PR worktree, `scripts/pr` checks that viewer with one request.
Rate-limit failures stop the operation before fetch or merge side effects and
report only safe metadata from that same response: HTTP status, quota resource,
remaining quota, limit, UTC reset time, and retry delay when available.
Respect `retry-after` before retrying manually; wait for the primary reset only
when that budget is exhausted. A future primary reset is not the unblock time for
a secondary throttle with quota remaining. Without a usable retry delay or an
exhausted budget's reset, wait at least 60 seconds. A zero remaining balance alone
does not attribute an HTTP 200 failure to rate limiting: malformed or missing
viewer data and unrelated errors still fail, with exhaustion reported separately.
An unknown reset is reported as unknown; a separate pooled REST quota is not
evidence about the failed viewer request. Refreshing credentials does not restore
quota. Only missing or rejected authentication suggests manually configuring or
refreshing the intended active credential; forbidden, server, transport, and
malformed responses remain blocking failures without login advice. The preflight
does not retry, switch accounts, or change GitHub CLI routing, and it does not
print raw response bodies, headers, or CLI errors.

The default `rollup` mode waits for the attached CI workflow to succeed and
for the remaining rollup checks to finish without failures. Same-name checks use
GitHub CLI-style deduplication within a workflow and event; this does not establish
GitHub server merge authorization. `Auto response` is excluded from the wait.
The default mode excludes runs associated only with another PR. Replacing an
entire older job graph requires both runs to identify the requested PR and head
uniquely, with matching workflow, event, and check-suite evidence. A shared head
SHA alone is insufficient because different PR bases can select different jobs.
Unique jobs, including cancelled jobs, remain visible without that proof.
The watcher has no PR-bound replacement evidence for `pull_request_target` graphs,
so their unique jobs remain visible too. Missing or ambiguous PR associations
prevent whole-graph replacement while the attached run is monitored; same-name,
same-event deduplication still applies on the shared head SHA.
Replacement proof resolves older run IDs referenced by the rollup, including runs
outside the initial attachment page. Metadata is reused across jobs and polls;
missing records are read under the watcher deadline, followed by a fresh PR and
rollup observation before deciding. Each poll reads at most 32 missing run records;
excess references stay pending and resume from the cache on the next poll. Known
missing or foreign associations remain blocking, as do independent failed checks.

GitHub can retain queued rerun placeholders while omitting the successful
same-name job from the rollup. The watcher reconciles a placeholder only after
verifying the successful exact-head attempt, its complete same-name job group,
and direct job evidence that every queued alias has no runner or executed
steps. Each poll permits at most 32 direct alias lookups, and evidence requests
share the remaining watcher timeout. Groups exceeding that lookup budget remain
pending with a warning. Before applying that proof, the watcher refreshes the
PR head, state, and check rollup, then rechecks the attached run. Proof applies
only to checks that still have the verified name and queued state. Active
retries, unrelated checks, and ambiguous or incomplete evidence still block
completion. This is an observation of CI state, not atomic merge authorization.

Both watcher modes attach only to `pull_request` CI runs. `--completion ci-run`
waits only for that attached workflow. Callers must separately verify required
checks; CI success does not override another required check.

The native `scripts/pr` merge flow reloads the saved prepare gate mode. Hosted
mode (`OPENCLAW_TESTBOX=1` during prepare) revalidates the prepared head through
the same hosted verifier used by prepare, including its 24-hour freshness,
workflow identity, attempt binding, and existing patch-identical reuse rules.
Accepted hosted proof proceeds directly
to required-check verification without waiting on older PR CI. Local and Crabbox
gate modes retain the `--completion ci-run` wait.

Missing prepare artifacts or rejected hosted evidence stop merge verification;
a saved mode or JSON report is not proof. Inspect `.local/gates-hosted-checks.log`,
resolve the reported failure, and rerun prepare when its artifacts need refreshing.
Malformed required-check evidence and cancelled required checks also stop
verification. Server-enforced publisher binding and the final pinned-head merge
request remain intact. Hosted mode adds no bypass.

For a squash message whose GitHub preview contains obsolete prose, use an
explicit reviewed body with `scripts/pr merge-run <PR> --body-file <path>`.
The path is relative to the caller, and the native merge owner snapshots its
regular UTF-8 file before verification. Empty files are valid. It preserves
operator-provided text and trailers, appending any missing co-authors from the
current GitHub preview and reviewed source commits. This option requires squash
and a non-queue PR; all review, CI, exact-head, and admission checks still apply.
Without the option, the existing GitHub preview behavior is unchanged.

`merge-recover` accepts the same option after its required outcome ID and
`--confirmed-operator-recovery`. Repeating `merge-run` with a retained outcome
only reconciles that outcome, even if the original body file was removed; it
never dispatches another request or changes an accepted message.

### Recover an existing PR run first

For an existing terminal PR run with a diagnosed infrastructure failure or
cancellation, prefer one failed-job retry over a new full-CI dispatch:

```bash
gh run rerun <original-run-id> --failed --repo openclaw/openclaw
```

Before cancelling a run stuck solely on unassigned jobs, verify that it is the
exact run you own for the unchanged PR head, no jobs are actively executing, and
the remaining jobs have no assigned runner or executed steps. Do not cancel
active work merely because it is slow. Wait for the run to become terminal
before retrying it.

Read back the new attempt and selected jobs: confirm the head is unchanged and
the intended failed or cancelled jobs were selected. Do not infer selection from
the command's success alone. Previously successful jobs can appear in the new
attempt with new job IDs and their original runner details; that does not mean
they executed again. Wait for the selected jobs and aggregate gate, then recheck
`gh pr checks <pr-number> --required --json name,bucket,state,link`.

Fork PR retries use GitHub-hosted runners for every CI job, including
`preflight`. Fork runs cannot read the base repository's runner-backend variable,
so this recovery path does not depend on that override. First-attempt routing
and the selected test and check coverage stay unchanged.

For genuinely missing or unrecoverable attached CI, follow the verifier's
`scripts/pr ci-dispatch <pr-number>` recovery guidance when available. Its
separate manual run can supply hosted preparation proof, but a successful check
in that suite does not replace the required PR check GitHub selects. If the
original required check remains failed or cancelled, recover that run; do not
bypass it or dispatch another full suite hoping to replace its status.

## PR context and evidence

External contributor PRs run a PR context and evidence gate from
`.github/workflows/real-behavior-proof.yml`. The workflow checks out the
trusted workflow revision (`github.workflow_sha`) and evaluates the PR body
only; it does not execute code from the contributor branch.

The gate applies to PR authors who are not repository owners, members,
collaborators, or bots. It passes when the PR body contains authored
`What Problem This Solves` and `Evidence` sections. Evidence can be a focused
test, CI result, screenshot, recording, terminal output, live observation,
redacted log, or artifact link. The body provides intent and useful validation;
reviewers inspect the code, tests, and CI to assess correctness.

When the check fails, update the PR body instead of pushing another code commit.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
