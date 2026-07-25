# Campaign evidence and counting

Update the operator-requested report throughout the run. Never place credentials, raw authenticated requests, private transcripts, personal device information, or local secret-store contents in an artifact.

## Campaign header

Record the user-approved scope, requested fix target, actual start time, requested soak duration, current immutable `origin/main` SHA, authorized landing policy, report location, and machine-load budget. Update the current baseline after every safe refresh.

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

Maintain at least ten active, differently scoped lanes while searching whenever worker creation and network use are authorized. Track blocked worker, network, remote, and device capacity explicitly. A finished worker, future worker, unstarted process, sequential inspection, or duplicate subsystem is not an active lane. For an offline or single-agent task, inspect ten distinct surfaces but report the actual concurrency and independent-verification limitation.

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
regression_or_live_proof_after:
exact_reviewed_head:
exact_head_hosted_checks:
pull_request:
merge_commit:
risk: low
status: merged
```

Keep an independent `review-required` section for persistence, migrations, auth, security, SDK, protocol, broad changes, uncertain ownership, and other user decisions. Give the exact reproduction, proposed PR, real completed validation, risk, and outstanding gates. Do not include them in the merged-fix count.

## Long-running evidence

Record the actual start, elapsed time, owned process and isolated endpoint, exact completed successes, failures, skips, sampled system load, and final end time. A live stress result is incomplete until the specified duration has actually elapsed; an unavailable capability is unavailable, never skipped-and-green.
