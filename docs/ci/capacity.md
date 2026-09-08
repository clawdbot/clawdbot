---
summary: "Runner registration budget, concurrency headroom, and measured shard timings"
title: "CI capacity and shard weights"
read_when:
  - You are tuning CI concurrency or shard counts
  - You need the measured timings behind shard packing
---

## Runner registration budget

OpenClaw's current GitHub runner-registration bucket reports 10,000 self-hosted
runner registrations per 5 minutes in `ghx api rate_limit`. Re-check
`actions_runner_registration` before each tuning pass because GitHub can change
this bucket. The limit is shared by all Blacksmith runner registrations in the
`openclaw` organization, so adding another Blacksmith installation does not add
a new bucket.

Treat Blacksmith labels as the scarce resource for burst control. Jobs that
only route, notify, summarize, select shards, or run short CodeQL scans should
stay on GitHub-hosted runners unless they have measured Blacksmith-specific
needs. Any new Blacksmith matrix, larger `max-parallel`, or high-frequency
workflow must show its worst-case registration count and keep the org-level
target below about 60% of the live bucket. With the current 10,000-registration
bucket, that means a 6,000-registration operating target, leaving headroom for
concurrent repositories, retries, and burst overlap.

The protected cache warmer has two platform rows: the existing Linux workload and one hosted macOS pnpm-store publisher. Its per-ref concurrency and pending-run coalescing are unchanged. Each admitted warmer run adds one hosted macOS job and no Blacksmith registrations; pull-request CI adds no writers or jobs. Native producer and consumer measurements must include cache transfer, extraction, installation, and archive size before claiming a setup-time saving.

The published-upgrade PR/main tripwire reuses the reserved `docker-seed-e2e` job,
so the retained peak envelope stays `4 × 144 + 21 × 200 = 4,776` registrations.
Docs-only main tips remain excluded by the `**/*.md` and `docs/**` push filters.
Admitted main pushes retain the same two non-canceling parity slots; the bound
includes both active runs and both coalesced successors. It does not assume
that every pushed commit starts a run.
The weekly Update Migration dispatch uses one targeted Docker group per
supported baseline for native operator state and keeps synthetic cleanup on
the candidate-relative predecessor. If that predecessor is outside the
supported set, it adds one existing matrix row: at most five targeted jobs,
plus image preparation, the group planner, and the hybrid ref validator, for
at most eight Blacksmith registrations per weekly run. Its separate non-canceling concurrency group
coalesces pending scheduled runs and cannot cancel manual validation. Release
checks reuse the same bounded grouping and unchanged 32-job cap: at four
distinct baselines, normal Package Acceptance selects 16 targeted jobs (17
when the predecessor needs its own row) and release soak selects 20. The
three-scenario group limit and 32-job concurrency cap are unchanged. The additional weekly burst and expanded release jobs
share the existing headroom for releases, adjacent repositories, and carryover;
the live shared bucket must still be checked before further fanout changes.

The three Mac Node parts add two hosted jobs per run on `github` and `hybrid`, with no added Blacksmith registrations there. Normal Blacksmith routing adds two registrations per qualifying attempt-1 push or trusted PR; manual runs, retries, and untrusted PRs remain hosted. The matrix concurrency cap is three. GitHub's documented Enterprise macOS concurrency allowance is 50, shared with other hosted Mac workflows; it does not guarantee immediate runner admission. No runner class or repository capacity setting changes with this split.

`Release npm Cache Warm` (`release-npm-cache-warm.yml`) runs a hosted Linux job on scheduled and manual triggers to prepare an npm download seed from the latest published OpenClaw package with lifecycle scripts disabled. Its concurrency group is separate from push-triggered Vitest warming, so newer pushes cannot cancel a pending seed. Scheduled runs publish from `main`, so new release branches can restore that seed through GitHub's default-branch cache scope. Each seed starts empty and contains only the current baseline dependency graph. Cross-OS release checks first restore their candidate-specific cache, then a matching runtime/suite cache, then this shared seed. Only npm's content-addressed `_cacache` directory is archived; install prefixes, OpenClaw state, npm logs, and executable `npx` caches remain fresh. The producer and consumers use the same relative archive path and enable cross-OS archives. npm retains normal freshness and integrity checks and downloads missing platform-specific packages. This adds one hosted Linux job per scheduled or manual warmer run, no jobs on pushes, and no Blacksmith registrations.

Small precise PR changes use a focused Node plan. Broad, deleted or unknown changes retain compact core plus the affected plugin fallback; canonical pushes use the integration compact. Every compact planner profile is capped at 80 rows, and plugin fallback packing is capped at 50. The final canonical Node matrix also enforces 64 push rows or 120 PR rows, including precise plans. Missing changed paths, missing current planner capabilities and planner errors fail preflight instead of emitting an incomplete successful matrix. Approved historical dispatches retain their full named plans. Count every emitted matrix row and nonmatrix job, including all six Android rows despite its two-job concurrency cap.

The shared plugin catch-all, QA and provider suites use native Vitest sharding, sized from the existing 90-file envelope budget. Their complete configs still own discovery and exclusions; the counting inventory never narrows execution to the directly changed plugin. At `2f7fb353`, the catch-all has 486 counting entries and 474 effective files across six jobs, QA has 238/232 across three, and providers have 275/256 across four. Counting entries include files excluded by Vitest, so the budget is conservative. Each job retains its existing worker limits, isolation policy and per-file module cleanup.

Precise and fallback plugin envelopes share the same packing owner and a 240-second aggregate estimated budget per job, including multiple envelopes of the same config. Members retain compatible runner/dist requirements and run one at a time; total cost bounds packing rather than a pair limit. Each envelope retains its original child process, environment, native shard arguments and include scope, including process-bounded Codex, Matrix and Telegram work. Runtime-preparing envelopes remain separate. Co-location preserves each original file/process bound and native shard partition; a physical job may contain several such envelopes. Workers, timeouts and serial stop-on-failure behavior stay unchanged. Costs retain the larger complete-family rate from [run 33676780376](https://github.com/openclaw/openclaw/actions/runs/33676780376) and [run 33747183683](https://github.com/openclaw/openclaw/actions/runs/33747183683), rounded up per counting file without lowering prior floors. Both cohorts used two CPUs and two workers; counting inputs include the config-owned exclusions, and runtime preparation is charged separately. Repacking the retained 78 envelopes with these rates projects 30 jobs instead of 32. The largest sum of matching observed child spans is 340.128 seconds. This is a forecast across different source revisions, not measured combined-job latency; native CI must verify elapsed time and cleanup within the eight-minute end-to-end objective.

Eligible Blacksmith and hybrid compact bins with multiple ordinary groups request the existing 32-vCPU runner and two child-process slots. They admit 360 predicted aggregate seconds; compatible small groups can fill that budget without the ten-group cutoff retained by serial jobs. Runtime consumers in ordinary bins share preparation only with other consumers, keeping no-build groups on their own capacity. Blacksmith serial jobs retain their 200/276-second budgets; hybrid serial jobs retain 210 seconds. Exclusive jobs retain 150 seconds by default. Only complete ordinary hybrid bins of non-build CLI groups may use 250 seconds and share split siblings; every child must still fit 150 seconds. Groups above their existing serial cap stay alone. Exclusive groups, single groups, dist descriptors and jobs with runtime preparation remain serial. Hybrid exclusive and dist bins retain their existing prerequisite sharing. The shard executor admits at most two processes only when the actual host has at least eight available CPUs and 24 GiB of memory; smaller capacity admits one. Each overlapping child keeps two Vitest workers, inner project parallelism remains one, and commands retain their serial file policy. The primary `github` profile stays serial at 210 seconds. Preflight records the actual row count for each source revision; canonical inventory comparisons must preserve every original child plan and test input. Native elapsed-time, memory and cleanup evidence must establish the actual effect.

Failed-job-only hybrid retries retain their original matrix and its 360-second aggregate estimates when routing to hosted Ubuntu. They do not repack to 210 seconds. The existing capacity gate reduces concurrency to one on those hosts, while the retained two-slot descriptor keeps the two-worker child budget. Such retries can exceed the eight-minute normal-run objective; existing 60/120-minute job deadlines and watchdogs are unchanged. Requested runner labels do not establish actual CPU or memory capacity.

The final Node matrix admits longer estimated jobs first across compact and plugin descriptors. Plugin estimates reuse the extension batch cost owner, including existing process boundaries; runtime preparation is charged separately from the same prerequisite table used by compact jobs. Equal estimates and historical descriptors without estimates keep their original order. The 96-job concurrency ceiling bounds active jobs, while the manifest caps bound total admissions. In run `33449014227`, all 96 slots were occupied when the late QA job started; that dependency delay was matrix admission, not evidence of runner-registration throttling.

Expanded serial large/small jobs admit 210 predicted seconds; eligible hybrid parallel bins admit 360. All profiles retain the shared 80-row compact cap. The 150-second file-split and default exclusive-group budgets stay unchanged; complete non-build CLI bins alone may use the 250-second ordinary hybrid admission budget. The PR-only performance lifecycle file retains its 136-second fallback from native spans of 127.288/135.808 seconds in runs 33532741896/33545657559; canonical pushes omit that tooling family. Trusted contributor forks can use the GitHub profile on Blacksmith, so every profile participates in the same registration bound. The widest current workflow profiles retain up to 86 other potential rows (14 nonmatrix and 72 matrix), or 87 for historical targets without the UI named-project contract. Normal Blacksmith and hybrid first attempts remove six UI rows; the conservative cap-based envelope still covers the wider profiles. Excluding the four unconditionally hosted iOS rows, two hosted macOS Swift phases, and the hosted aggregate gate gives the conservative ceiling of 80 potentially eligible rows. This includes the new Control UI performance job; keep the ceiling rather than spending savings from consolidated checks. With the final Node caps, the bounds are 144 registrations per main run and 200 per PR. Two active main slots, both pending successors and the observed peak of 21 non-skipped PR arrivals give `4 × 144 + 21 × 200 = 4,776` registrations in five minutes. This leaves 1,224 within the 6,000 reference operating target for release work, adjacent repositories and carryover; it does not prove those arrivals fit. The earlier 19-arrival estimate is obsolete. Using the prior 4,826-registration reference, the bounded 2026-09-02 cohort audit counted 321 unassigned Blacksmith jobs and reserved nine auxiliary rows, giving `4,826 + 321 + 9 = 5,156` planned registrations and an 844-row allowance below that reference. Its 40 exact attempts covered 4,830 jobs; queued observations spanned 21:50:48–21:57:11 UTC and were not simultaneous. Already-assigned jobs, old approval-waiting runs, unobserved retries and unlisted organization work remain outside that cohort, so this is a conditional planning bound rather than a live organization balance. Evaluate a single PR trial using its actual emitted rows separately from the rollout model. Budget all six npm qualification jobs and the relevant full-release children; a shared-token quota response or unused bucket does not establish organization-wide usage or physical runner capacity.

`checks-ui-e2e` emits seven rows for non-frozen targets with the named-project contract on Blacksmith and hybrid first attempts: six combined Control UI shards and one browser-extension row. Both use the same Blacksmith runner class. Freshly planned GitHub-profile and frozen targets with that contract retain twelve Control UI shards plus the browser row. Missing attempt metadata also retains that wider plan. Historical targets without the contract retain four total rows on the Blacksmith planner profile or fourteen on GitHub and hybrid profiles. The 2026-09-02 inventory at `49fb9c5` contains 359 files: 329 parallel bundle consumers, three parallel self-owned files, seven serial bundle consumers, and 20 serial private source/custom-build files. Ordinary CI excludes seven real-Gateway files, leaving 352. Four native projects represent resource ownership without adding jobs or execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` share group 0 with at most two workers total, then `ui-e2e-serial` and `ui-e2e-serial-standalone` share group 1 with one worker. Local throttling and explicit worker limits still apply. The shared weighted sequencer charges each file by its measured duration divided by that project's effective worker count and assigns every discovered specification once across the selected Control UI rows. The root config keeps the complete inventory visible for discovery. Serial scheduling still protects private source servers that share a Vite optimizer cache, real Gateways, and the runtime-budget measurement; test cases, deadlines, and isolation are unchanged.

Every selected project discovers Chromium. The first selected bundle-consuming project builds one private production bundle/preview and publishes its URL through Vitest's invocation-scoped root context; later consumers share it until invocation teardown. Standalone projects have no bundle setup or URL bridge, so standalone-only selections skip that build. Enabled manual proof capture uses the shared upload directory, including the MCP and Logs suites.

The dedicated real-Gateway job runs all 14 files in one invocation through `test/vitest/vitest.ui-e2e-prebuilt.config.ts`. It requires a clean checkout and completed runtime, private QA, and canonical Control UI artifacts from `OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build:ci-artifacts`. Source and built outputs must remain unchanged until all workers and children finish. A readiness failure stops the invocation without rebuilding or falling back to another config. MCP conformance owns a source server and runs serially first; the other 13 files then share the existing two-worker limit. The invocation preview builds its own private output from the same source. This adds no CI jobs or shards. The ordinary local config keeps real-Gateway files serial, and frozen targets lacking the prebuilt config retain their original serial command.

A controlled Linux comparison covering all 14 files and 25 tests reduced invocation elapsed time from 309.374 to 202.027 seconds. This measures the test invocation, not complete CI timing or achievement of the CI latency target.

Eligible `control-ui` rows request `blacksmith-32vcpu-ubuntu-2404`; the browser-extension row keeps the 8-vCPU request and the real-Gateway job keeps 16. Backend, event, contributor-trust and cache-write boundaries are unchanged, including hybrid first attempts and trusted contributor forks. In [run 33692146223](https://github.com/openclaw/openclaw/actions/runs/33692146223), the two slowest UI rows requested the 8-vCPU label but reported two CPUs; their 356/383-second test steps set the 8:20 non-Windows wall. The same run's 32-vCPU jobs reported eight CPUs. The larger request added no workers. In [run 33695337496](https://github.com/openclaw/openclaw/actions/runs/33695337496), all twelve UI rows reported eight CPUs and finished by 4:38 from workflow creation, with 102–145-second test steps. That margin supports consolidating to six rows; reduced-row timings still require native proof. Stale file weights also need the existing refit's independent-run and replacement thresholds, rather than a one-run manual adjustment.

The browser-extension row prepares only its native-host runtime JavaScript and assets through the existing `qaRuntime` build profile rather than rebuilding declarations and the Control UI. Both current widths remain inside the conservative registration bound. A failed-job-only retry of a six-shard plan retains those six shards. PR retries and hybrid push retries select hosted Ubuntu through live routing, so they may take longer; the existing 25-minute timeout is unchanged. A retry that reruns preflight selects twelve rows. Canonical push retries on the Blacksmith profile retain Blacksmith routing. The `max-parallel` ceiling stays 14 for historical targets without the named-project contract, which retain their previous width. Physical capacity must be checked separately from the registration bound.

The previous thirteen-serial-shard layout consumed 4,258 job-seconds in successful [run 33494931388](https://github.com/openclaw/openclaw/actions/runs/33494931388) on 2026-09-01, averaging 327.5 seconds per Control UI row; preflight added 39 seconds and the tail row took 363 seconds. The current projects reduce the modeled body through bounded bundled concurrency. In run `33638745824`, twelve successful first-attempt Control UI rows had median/p90 test steps of 197/235 seconds, while their checkout median reached 116.5 seconds. Reducing thirteen Control UI shards to twelve removes one repeated checkout and setup without combining the separate browser-extension work. The current target is eight minutes for normal non-Windows CI, with fewer jobs preferred over a tighter latency target. Measure queueing, checkout, setup and test work separately; the final gate still waits for Windows, which may exceed that target. The historical serial layout and the single hosted retry are not paired performance comparisons.

Canonical-repo CI keeps Blacksmith as the default runner path for pushes and first-attempt same-repo pull-request runs when the backend is unset or `blacksmith`. Hybrid keeps the heavy set plus the named critical-path plateau lanes on Blacksmith for attempt 1; other light lanes and every rerun Blacksmith lane use GitHub-hosted capacity. Pull-request retries of both UI E2E jobs use GitHub-hosted Ubuntu in every mode; push retries remain on their normal backend unless hybrid fallback applies. Manual `workflow_dispatch` and non-canonical repository runs use GitHub-hosted runners for the main test/build lanes. With an unset or `blacksmith` backend, ordinary canonical manual dispatches (`release_gate: false`) can still run the seven `check-shard` rows on their Blacksmith matrix runners; release-gate check rows remain hosted. Same-repo hybrid Full Release Validation sends only frozen-candidate lint to its matrix runner, both for exact main-ancestor SHAs without a release context and for canonical release-context candidates. These manual admissions are outside the main/PR arrival estimate above. The [`github` backend](/ci/runners#runner-backend-modes) provides a manual repository-wide fallback; canonical runs do not probe Blacksmith queue health or mutate the variable automatically.

## Measured shard weights

`config/ci-test-timings.json` records CI measurements for UI and Gateway E2E files
and compact Node groups. UI and compact packers prefer these weights over their in-source cold-start
tables. UI E2E keys are repo-relative paths, including tests under `ui/src/pages/`,
and every file estimate includes the measured fork, import, and setup overhead.
Compact groups have separate Blacksmith and GitHub-hosted measurements, selected
from jobs API runner labels (`blacksmith-*` versus hosted `ubuntu-24.04`); hybrid
and large-group stripe adjustments continue to use their existing policies.
Compact weights use the complete `[shard:x] begin` to `end` span, preserving
process startup and any contention in the measured run. Ordinary Blacksmith compact jobs may execute two groups concurrently; serial
jobs retain `planConcurrency: 1`. The refit preserves each complete child span,
including contention, without subtracting setup or rewriting historical costs. Runner-profile
calibration remains a separate admission policy.

Gateway E2E uses the same greedy partition owner as UI E2E. Measured file durations
include suite hooks; new files use source bytes scaled by the discovered files'
measured seconds per byte. Without measurements, Gateway partitions use source
bytes alone. The CLI JSON suite is split by command family so its existing cases
can run across the four shards without an indivisible serial tail.

The compact plan is built once in preflight. E2E shards build their partitions
independently, so they must read the same committed file from the checkout. They
never download timing artifacts or consult restored timing caches. Missing or
invalid timing files, or `OPENCLAW_CI_TEST_TIMINGS=0`, use the cold-start estimates
for the entire file; stale keys cannot change the discovered test inventory.

With an authenticated `gh` CLI, run `pnpm ci:timings:refit` to regenerate the file
from all attempts of the last five successful `ci.yml` push runs on `main`, plus
the last five successful manual runs of each release-check workflow that owns
Gateway E2E. The refit validates run metadata before reading job logs; ordinary
manual CI dispatches are rejected because their measured target can differ from
the workflow head. Release workflows validate their selected target before tests,
and their temporary branch identifies tooling rather than the measured source.
Use `--runs <n>` to change
the sample window, `--repo <owner/repo>` to select a repository, `--out <path>` to
write elsewhere, or `--dry-run` to print changed entries without writing.
Measurements come only from successful UI E2E, Gateway E2E, and compact jobs; compact groups
also require an `exit 0` marker. Each entry needs at least two run samples;
multiple attempts within one run still contribute only one sample per key and
profile. Keys are pruned only when that profile has at least one observation in
each of at least three sampled runs, and only if the key is absent from every
contributing run. Profiles with fewer contributing runs retain all previous
keys; missing or unparseable logs do not count toward the threshold. Removals
remain explicit in the dry-run and PR change tables.
Samples above 2.5 times the key's median are discarded before taking the median,
and existing weights stay unchanged when the new median is within 15%. UI E2E
overhead is the median shard `(wall - body) / fileCount`, clamped to 0–5 seconds.

An empty `compactGroupSeconds.github` map is designed cold-start behavior:
main compact jobs normally run on Blacksmith, so the hosted profile keeps its
in-source `COMPACT_GITHUB_GROUP_SECONDS_HINTS` fallback until hosted observations
meet the sampling minimum. Later main attempts on the hybrid backend, or main
runs using `OPENCLAW_CI_RUNNER_BACKEND=github`, can fill it naturally. Once recorded,
hosted weights survive all-Blacksmith windows: pruning requires observations
from at least three hosted runs in the sampled window. Sampling stays main-only;
fork PR timings never influence the packer.

The `CI Test Timings Refit` workflow runs daily at 09:43 UTC and supports manual
dispatch on `main`. When weights change, it updates the single
`ci/test-timings-refit` branch and PR with sampled run IDs and the changed-entry
table. It never pushes to `main`; unchanged weights produce no commit or PR
update. The gitignored `.artifacts/vitest-shard-timings.json` remains a separate
whole-config timing cache for the local test-project runner, not an input to
these CI packers.

The shared generated-PR publisher refreshes `main` and rejects stale generator
inputs or overlapping timing-file changes before its leased branch push. It
uses separate repository-scoped GitHub App tokens for branch and PR writes;
the workflow's `GITHUB_TOKEN` has only contents-read permission. App-created
events trigger CI without the `GITHUB_TOKEN`-specific workflow approval step.
Normal repository review and required checks still apply; this workflow does
not enable auto-merge. See
[GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
