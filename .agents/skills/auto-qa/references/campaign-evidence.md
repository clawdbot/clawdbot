# Campaign evidence and counting

Update the operator-requested report throughout the run. Never place credentials, raw authenticated requests, private transcripts, personal device information, or local secret-store contents in an artifact.

## Campaign header

Record the user-approved scope, current requested fix target, actual start time, requested soak duration, current immutable `origin/main` SHA, authorized landing policy, report location, and machine-load budget. Record the orchestrator responsible for serialized remote-ref updates. After each landing, record the post-merge fetched baseline only after proving that it contains the recorded merge commit. If the user changes the target, update the active goal and every current ledger denominator while preserving historical time-stamped progress; never treat the old target as campaign completion.

## Audit lane

For every active lane record:

```text
lane:
  subsystem:
  baseline_sha:
  worker:
  started_at:
  deadline:
  status: running | replacing | evidence-ready | rejected
  evidence:
```

Record an independently observed live child PID, its durable supervisor or session, and the PID observation time for every CLI-backed running lane. Keep completed, failed, timed-out, and stale-baseline workers in their own wave results; a printed background PID, discarded supervisor, finished report, planned replacement, or `STOPPED REF CHANGED` response is not evidence of a running lane.

Maintain at least ten active, differently scoped lanes whenever independent worker execution is authorized. Treat permission to fetch, contact a provider, or run an externally hosted model as a separate network constraint. Track blocked worker, network, remote, and device capacity explicitly. A finished worker, future worker, unstarted process, sequential inspection, or duplicate subsystem is not an active lane. For a single-agent task, inspect ten distinct surfaces but report the actual concurrency and independent-verification limitation.

Freeze one baseline per worker wave. Verify canonical and read-only worker checkouts with both `git -C <verified-checkout> rev-parse HEAD` and empty `git --no-optional-locks -C <verified-checkout> status --porcelain=v1 --untracked-files=all --ignore-submodules=none`; never infer canonical `main` from a desktop task's detached working directory or trust a dirty checkout solely because `HEAD` matches. Require matching commit and clean-content guards at worker start and immediately before report acceptance; immutable Git-object reads are also valid. Keep intentionally dirty fix worktrees outside frozen review waves. A worker may inspect that immutable SHA without independently refreshing shared remote refs. During native PR preparation or merge, pause worker fetches and let the orchestrator own `origin/main`. After a verified landing, fetch again, prove the merge commit is contained in the fetched ref, broadcast that full new SHA, and then resume workers.

## Bug ledger

Count a product bug only after every required field is proven:

```text
number:
summary:
baseline_sha:
affected_owner_and_user_path:
reproduction_before:
observed:
expected:
independent_verification:
root_cause:
affected_callers_and_siblings:
canonical_owner_refactor:
regression_or_live_proof_after:
exact_reviewed_head:
exact_head_hosted_checks:
pull_request:
merge_commit:
risk: low
status: merged
```

Require evidence that the repair eliminates the canonical cause, not only the observed symptom. Record which sibling paths were checked, which were fixed together, and which are unaffected; count a shared invariant once. Keep an independent `review-required` section for persistence, migrations, auth, security, SDK, protocol, high-impact architectural changes, uncertain ownership, and other user decisions. Give the exact reproduction, proposed PR, real completed validation, risk, and outstanding gates. Do not include them in the merged-fix count.

## Long-running evidence

Record the actual start, immutable gateway source, owned live PID and isolated endpoint, elapsed time, exact completed successes, failures, skips, sampled system load, and final end time. Keep an established long-running soak on its original source while current-main review workers advance. A live stress result is incomplete until the specified duration has actually elapsed; an unavailable capability is unavailable, never skipped-and-green.
