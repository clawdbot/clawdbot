# Cron receipt handoff audit

## Verdict

**LAND-READY on frozen baseline `982e0181b748717a312f37a5464a423a9341440c`.**

The implementation is committed locally at
`0f37cbceabd75788981b18e84a71fe5374495bc2`. No push, pull request, merge,
release, deploy, external send, or operator-state mutation was performed.

The checkout's `origin/main` tracking ref moved during the audit. The requested
checkout was not fetched or rebased, so landing against a newer main still
requires its normal exact-head gate.

## Confirmed bug and owner

A direct `CronService.run()` removed during execution durably terminalized its
run receipt but emitted no `finished` event. Its task stayed `running`, and
status/history exposed no terminal outcome. The queued sibling worked because
`enqueueRun()` supplies a `ManualRunTerminalTracker`; direct runs do not.

The defect was in the manual completion owner at
`src/cron/service/ops-run.ts`. The removed-job branch called a helper that
returned whenever the queued tracker was absent, so it bypassed
`emitCronRunFinished()`, the canonical event plus task/history finalizer in
`src/cron/service/ops-run-preparation.ts`.

The fix preserves the existing `required` distinction:

- queued calls use the tracker to deduplicate terminal emission;
- the removed direct-run branch passes `required=true` because it has no
  tracker but still requires one durable terminal event, history row, and task
  outcome;
- other tracker-less paths retain the previous no-op behavior.

Task-registry notification and channel ACK custody remain separate. Cron task
rows stay `notifyPolicy: "silent"` and `deliveryStatus: "not_applicable"`.
The regression uses `delivery.mode="none"`, so it sends nothing externally and
does not change any channel-specific ACK contract.

## Commits and LOC

- Root fix: `7bd7f5c5533a01790e58ce3dd7e276bd6fbc7b0f`
- Review follow-up: `0f37cbceabd75788981b18e84a71fe5374495bc2`
- Aggregate production LOC from the frozen baseline:
  `src/cron/service/ops-run.ts` `+7/-7` (net 0)
- Aggregate test LOC from the frozen baseline:
  `src/cron/service.one-shot-schedule-ownership.test.ts` `+41/-13` (net +28)
- Aggregate total: `+48/-20` (net +28); production remains net zero.
- Follow-up alone: `+6/-6` production, entirely naming/comment changes.

## Reproduction and proof

The boundary sequence is:

1. Start a direct or queued manual one-shot run with a deferred isolated runner.
2. Remove the job while execution is active.
3. Recreate the same job ID to prove the old outcome cannot mutate the new job.
4. Release the original runner.
5. Assert one exact `finished` event, one matching receipt, one history entry,
   terminal task state, pristine replacement state, and no duplicate outcome.

Before the fix, both direct variants failed with zero terminal events. The
queued variants passed. After the fix and after the terminology follow-up:

- focused boundary: 14/14 passed;
- receipt/history/task and restart siblings: 100/100 passed;
- direct and queued removal assert the exact error
  `Cron job removed by operator.`, one durable receipt, one history entry, and
  replacement isolation;
- Blacksmith Testbox `tbx_01m04jecfarzrerece5e87dwqd`, Actions run
  `31930301305`: formatting, core production types, core test types, targeted
  lint, full build, import cycles, and diff check passed;
- fresh autoreview after the follow-up: clean, no actionable findings, 0.99
  confidence.

The aggregate `check:changed` run on Testbox
`tbx_01m04jc3dx8h3eqs1m1f3ra26p` (Actions run `31930253327`) stopped on the
existing assertion-safety ratchet in ten unrelated files. The synced moving
baseline contained 218 changed files; neither touched cron file appeared in
that failure. Exact cron types, lint, format, build, cycles, tests, and diff are
green.

## Duplicate and follow-up status

No duplicate of this direct-run terminal-custody repair was found in local
history. Existing queued-run coverage was a correct sibling, not a duplicate.
Other receipt findings from the extended audit—cross-process same-ID
replacement attribution, stale superseded history, and ambiguous no-identity
delivery projection—are distinct owner-boundary follow-ups and are not folded
into this commit.
