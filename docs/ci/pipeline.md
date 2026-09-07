---
summary: "Job graph, fail-fast order, and the Control UI size budgets"
title: "CI pipeline jobs"
read_when:
  - You need to know which CI job owns a check
  - You want the order jobs run in and what blocks what
---

OpenClaw CI runs on pushes to `main` (Markdown and `docs/**` paths are ignored
at the trigger), on every non-draft pull request, and on manual dispatch.
Canonical `main` pushes use a two-slot pipeline keyed by run-number parity, so
at most two integration runs overlap. Each slot is non-canceling and keeps one
coalesced pending tip: a new merge replaces that slot's older pending run
instead of canceling work that already registered a Blacksmith matrix. Runs in
the two slots can complete out of order; exact-head consumers remain bound to
their requested SHA and are unaffected. Pull requests still cancel superseded
heads, and manual dispatches use isolated groups. Draft no-op events use per-run
isolated groups before job gating, so a delayed draft event cannot displace
pending or running ready-for-review CI. `converted_to_draft` keeps the PR-wide
group to cancel earlier CI while skipping its own jobs. Explicit workflow
cancellation and manual dispatch behavior are unchanged; draft isolation adds no
downstream automatic recovery. `preflight` classifies the
diff and turns expensive lanes off when only unrelated areas changed. Ordinary
manual `workflow_dispatch` runs intentionally bypass smart scoping and fan out
the full graph for release candidates and broad validation. Exact-head
`release_gate` fallbacks retain the pull request's macOS, iOS smoke, and native
generated-locale scope instead of forcing unrelated Apple lanes or locale
parity. Native source verification still runs. Android lanes stay opt-in through
`include_android` (or the `release_gate` input). Release-only
plugin coverage lives in the separate
[`Plugin Prerelease`](/ci/release-validation#plugin-prerelease) workflow and only runs from
[`Full Release Validation`](/ci/release-validation#full-release-validation) or an explicit manual
dispatch.

Scheduled QA runs nightly at 04:41 UTC. Its live runtime job runs the
`gateway-restart-full-access-live` scenario with `openai/gpt-5.6-luna` alongside
the three-restart replay-safety scenario. The Full Access check must preserve
shell access and delegation without repeating the interrupted side effect;
failure fails the job. Both scenarios run serially and retain their reports in
the job's uploaded artifacts.

## Pipeline overview

| Job                              | Purpose                                                                                                                                                                                                                                                                                                  | When it runs                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `preflight`                      | Detect changed scopes and build the CI manifest; all-Blacksmith canonical Node-relevant runs also restore the exact dependency cache before fanout                                                                                                                                                       | Always on non-draft pushes and PRs                     |
| `security-fast`                  | Private key detection, changed-workflow audit via `zizmor`, and production lockfile audit                                                                                                                                                                                                                | Always on non-draft pushes and PRs                     |
| `pnpm-store-warmup`              | Warm the lockfile-pinned Actions cache for fork PRs, manual runs, and same-repo docs-only PRs                                                                                                                                                                                                            | Node or docs-check lanes without an exact-cache writer |
| `build-artifacts`                | Build `dist/`, Control UI, built-CLI smoke checks, startup memory, and embedded built-artifact checks                                                                                                                                                                                                    | Node-relevant changes                                  |
| `control-ui-performance`         | Compare Control UI CSS with the exact base revision and enforce asset budgets independently of artifact generation                                                                                                                                                                                       | Runtime-build or Control UI test changes               |
| `control-ui-i18n`                | Verify generated Control UI locale bundles, metadata, and translation memory; advisory on automatic runs, blocking on manual release CI                                                                                                                                                                  | Control UI i18n-relevant changes and manual CI         |
| `checks-fast-core`               | Fast Linux correctness lanes: environment-variable, max-lines, and assertion-safety baseline ratchets, bundled + protocol, Bun launcher, and the CI-routing fast task                                                                                                                                    | Node-relevant changes                                  |
| `qa-smoke-ci-profile`            | Self-contained balanced parts of the automatic QA Smoke coverage set; one private-overlay build per part (the smoke set has no docker-lane or Control UI scenarios; the run step fails closed if one returns)                                                                                            | Pushes and manual runs; PRs only on QA-owned surfaces  |
| `checks-fast-contracts-plugins`  | One setup shared by two sequential weighted plugin contract processes; frozen targets keep separate rows                                                                                                                                                                                                 | Node-relevant changes                                  |
| `checks-fast-contracts-channels` | One setup shared by two sequential weighted channel contract envelopes; frozen targets keep separate rows                                                                                                                                                                                                | Node-relevant changes                                  |
| `checks-node-*`                  | Changed-target Node tests on pull requests; compact integration shards on `main`; metadata-complete compact fallback on broad PRs; full named shards on manual and release runs                                                                                                                          | Node-relevant changes                                  |
| `docker-seed-e2e`                | One Docker scheduler job for the executable `mcp-channels`, `cron-mcp-cleanup`, `mcp-code-mode-gateway`, and `update-channel-switch` owner lanes                                                                                                                                                         | PR changes to their E2E helpers or CI gate owners      |
| `check-*`                        | Sharded main local gate equivalent: guards, transient npm-lock validation, bundled-channel config metadata, prod types, lint, dependencies, test types                                                                                                                                                   | Node-relevant changes                                  |
| `check-additional-*`             | Boundary check stripes (including prompt snapshot drift), session accessor/transcript reader/SQLite transaction boundaries, extension lint groups, package boundary compile/canary, and runtime topology architecture; the pure-reporting plugin SDK API diff runs on manual and release dispatches only | Node-relevant changes                                  |
| `checks-node-compat-node22`      | Node 22 compatibility build and smoke lane                                                                                                                                                                                                                                                               | Full Release Validation and manual dispatches only     |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                                                                                                                                                                                                                            | Docs changed (PRs and manual dispatch)                 |
| `native-i18n`                    | Verify native source extraction and localization safety on source PRs and release gates; enforce generated parity on generated PRs, generated-scope release gates, and ordinary manual CI                                                                                                                | Native i18n-relevant changes                           |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                                                                                                                                                                                                                                   | Python-skill-relevant changes                          |
| `checks-windows`                 | Windows-specific process/path tests plus shared runtime import specifier regressions                                                                                                                                                                                                                     | Windows-relevant changes                               |
| `macos-node`                     | Focused macOS TypeScript tests: launchd, Homebrew, runtime paths, packaging scripts, process-group wrapper                                                                                                                                                                                               | macOS-relevant changes                                 |
| `macos-swift`                    | Swift lint and build for the macOS app, plus tests for the app, shared OpenClawKit, and standalone Swabble package                                                                                                                                                                                       | macOS-relevant changes                                 |
| `ios-build`                      | Debug build and Swift lint smoke; full manual CI adds separate Release device and native test phases                                                                                                                                                                                                     | iOS/capture changes and full manual CI                 |
| `ios-screenshot-shard`           | Two device-family shards using the locked Ruby/Fastlane bundle: iPhone in one job, and 13-inch iPad plus Watch in the other; scenarios stay serial within each device                                                                                                                                    | Full manual CI only                                    |
| `ios-screenshot-evidence`        | Hosted reducer that verifies exact artifact/family topology, digests, every OpenClaw-managed capture-attempt outcome (including failed invocations without an xcresult), and run provenance before publishing the canonical release screenshot artifact                                                  | After both screenshot shards                           |
| `android`                        | Phone and Wear unit tests, debug builds, Android lint, and Kotlin lint                                                                                                                                                                                                                                   | Android-relevant changes                               |
| `openclaw/ci-gate`               | Final aggregate: requires preflight and security; rejects selected skips and every downstream failure or cancellation                                                                                                                                                                                    | Every non-draft CI run                                 |
| `openclaw-performance`           | Separate workflow: daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.6 live lanes                                                                                                                                                                             | Scheduled and manual dispatch                          |
| `docs-external-links`            | Separate workflow: Docs External Link Audit checks external documentation links with lychee and uploads a report; it reports findings without failing, so it never blocks a pull request                                                                                                                 | Scheduled and manual dispatch                          |

The rare path-triggered `docker-seed-e2e` job selects only the executable
owners of changed E2E helpers and runs them through one scheduler invocation.
Trusted same-repository pull requests request one 32-vCPU Blacksmith runner with
main and tail parallelism set to 3. The weighted scheduler still admits only one
weight-three MCP lane at a time; the larger host supplies package-build and
container capacity. GitHub-hosted, fork, and retry paths run the same selected
lanes serially. The job is part of `openclaw/ci-gate`. It adds at
most one runner registration during an affected pull-request window and adds no
registrations for unrelated pull requests.

Standalone Periphery workflows enforce zero dead-code findings for the iOS and macOS apps. The shared OpenClawKit workflow scans both consumers in parallel and reports a declaration only when Periphery emits the same Swift USR from both builds. Its generated `OpenClawProtocol/GatewayModels.swift` schema contract is retained as generator-owned code rather than treated as app-local dead code.

All four scans use `scripts/install-periphery.sh` to install the checksum-pinned Periphery 3.8.0 OSS release, including its adjacent `libIndexStore.dylib`, in a dedicated runner-temporary directory. The installer rejects download, checksum, and version failures without falling back to Homebrew. Installer changes select all three native workflows.

[Upstream archived the OSS project](https://github.com/peripheryapp/periphery/commit/56a0eb6fb97b785c8fbc1044ccbc7b5d9f06ebec). The pin is a maintainer-owned bridge for the workflows' Xcode 26.6 toolchain, not a claim of ongoing upstream support. Native CI maintainers must revalidate both app scans and both shared consumers before changing Xcode, the pinned release, or the analyzer; retain the zero-findings policy and exact-USR intersection rather than adding a baseline or a weaker fallback.

## Fail-fast order

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs. Canonical `main` starts immediately in one of two parity slots; each slot admits one complete run and coalesces later pushes into its newest pending tip. Downstream jobs wait for the manifest, then eligible Blacksmith jobs restore exact dependencies from the trusted warmer or fall back to the ordinary pnpm-store cache on a miss. Pushes, pull requests, and manual runs targeting the workflow revision run preflight with native Node and skip dependency setup. Manual runs targeting a different revision install dependencies and retain that target's `tsx` tooling.
2. `security-fast`, `check-*`, `check-additional-*`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs. The production dependency audit sends one complete graph with up to four attempts and a four-minute total request budget, including retries and response reading. Timeouts, native fetch failures, HTTP 429, and 5xx responses retry with exponential backoff; retryable HTTP responses honor `Retry-After`. Attempts and recovery are logged. Persistent unavailability, vulnerability findings, invalid inputs, malformed advisory data, oversized responses, and permanent HTTP failures block CI. An unavailable audit is incomplete coverage, not a clean result. Local pre-commit and release dependency audits use the same bounded request owner and fail on unavailability.
3. `build-artifacts` and the locale checks overlap with the fast Linux lanes. Control UI and native app source PRs exclude generated locale snapshots/resources; their serialized refresh workflows repair and auto-merge isolated generated PRs in the background. Source CI still blocks stale source inventories and unsafe localization calls. Generated PRs, manual CI, and release prep enforce full translated/platform-generated parity. Canonical `release/YYYY.M.PATCH` branches may include release-prep locale repairs with the other generated release output.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-plugins`, `checks-fast-contracts-channels`, `checks-node-*`, `checks-windows`, `macos-node`, `macos-swift`, `ios-build`, the screenshot shards, and `android`.
5. `openclaw/ci-gate` waits for every selected lane. Preflight and security must succeed; downstream jobs may skip only when unselected by the manifest and existing event, runner, and compatibility conditions. An unexpected selected skip or any failed or canceled downstream job fails the aggregate. The aggregate uses `!cancelled()` so failed prerequisites still report, while canceling the workflow skips final reporting and releases its concurrency slot without waiting for another runner.

To retranslate every Control UI or native app string, dispatch **Control UI Locale Refresh** or **Native App Locale Refresh** from `main` with `full_refresh=true`. Ordinary runs remain incremental. Both workflows read the primary and fallback models from the `OPENCLAW_I18N_MODEL` and `OPENCLAW_I18N_FALLBACK_MODEL` GitHub secrets, using the existing translation OpenAI API key. Only an explicit `model_not_found` provider error selects the fallback; authentication, quota, and network failures do not. Generated metadata and public diagnostics omit model identifiers.

The merge coordinator may reuse an authenticated successful `openclaw/ci-gate`
for the same pull-request head for up to 24 hours. This avoids rewriting a
contributor branch after unrelated `main` changes. The reusable result does not
replace the separate strict, App-owned test-merge check against current `main`.
A later pending or failed rerun does not erase an earlier successful result for
that unchanged head during the freshness window.

The default-branch ruleset requires the GitHub Actions-owned `openclaw/ci-gate` check. Repository maintainers and admins have an audited break-glass bypass intended only for signed direct fast-forward landings; the organization ruleset still blocks deletion and non-fast-forward updates. Normal pull-request merges should continue to use the gate rather than bypass failed CI. The separate strict App-owned test-merge check still binds the head to current `main`.

GitHub may mark superseded pull-request jobs as `cancelled` when a newer head lands. Treat that as CI noise unless the newest run for the same PR is also failing. Canonical `main` runs are not canceled after admission; each of the two parity slots replaces only its older pending run with the newest tip. Matrix jobs use `fail-fast: false`, and `build-artifacts` reports embedded channel, core-support-boundary, and gateway-watch failures directly instead of queuing tiny verifier jobs. The canonical-main CI concurrency key is versioned (`CI-v8-*`) so GitHub-side zombies in the old group cannot block the two-slot pipeline; runnable PR groups remain on `CI-v7-*`, while passive draft runs use `CI-draft-v1-*`. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs. The plugin-list startup-memory guard keeps a 400 MiB ceiling on self-hosted Blacksmith Linux and allows 425 MiB on GitHub-hosted Linux, whose RSS baseline is higher for the same built CLI. The startup-memory check finishes alone before other built-artifact checks start on every runner, so concurrent verifiers do not perturb the RSS measurement.

The Testbox validation, native Periphery, OpenGrep PR Diff, Sandbox Common Smoke,
and Plugin Init Scaffold Validation workflows isolate passive draft PR events
(`opened`, `reopened`, and `synchronize`) from useful PR work at concurrency
admission. A delayed draft payload therefore cannot cancel an active ready run or
replace a pending one before the draft job or scan is skipped. Disabling
`cancel-in-progress` alone would still replace pending work. Where subscribed,
`converted_to_draft` stays in the ordinary PR group to intentionally cancel work;
non-draft head supersession and each workflow's existing manual/push grouping
remain unchanged. Periphery report publication separately checks source intent
and live PR state; see [Scope and routing](/ci/scope-and-routing).

The singleton smoke then rebuilds the runtime plugin overlay before any other verifier reads it. On Blacksmith, Gateway watch finishes its build-receipt writes and whole-tree measurement next; Doctor, SQLite lifecycle, channel, core-support-boundary, and Discord attachment checks can then overlap. Hosted 4-core runners keep their existing serial sequence and channel/core pair. TUI canaries run after all other verifiers finish. Every verifier owns a separate Vitest module cache, and each selected result remains part of the same failure aggregation. The wave step is unconditional because its startup and singleton checks always run; individual checks retain their selection gates. The artifact job consumes only its selected checkout, so base-commit fetching stays with jobs that actually compare revisions.

Use `pnpm ci:timings`, `pnpm ci:timings:recent`, or `node scripts/ci-run-timings.mjs <run-id>` to summarize wall time, start delay, slowest jobs, failures, and the `pnpm-store-warmup` fanout barrier from GitHub Actions. Use `pnpm ci:timings:trend` for a 72-hour baseline and a latest-12-hours versus prior-12-hours comparison. Trend mode includes every main push outcome, cancellation/pass rates, and successful-run wall time, then loads a balanced latest/prior sample of at most 100 successful runs by default. Its detailed sample separates workflow admission, job dependency/gate delay (`job.created_at` minus the first job's creation), runner queue/start latency (`job.started_at` minus `job.created_at`), and execution; it also reports critical-path ownership and the actual GitHub API request count. Reruns use attempt-specific jobs and are excluded from run-level wall/admission distributions because GitHub retains the original workflow creation time. Raise or lower the detailed-run selection cap with `--detail-runs` (a run with more than 100 jobs requires multiple requests), emit JSON to stdout with `--json`, or save the same report with `--output .artifacts/ci-timings/trend.json`; missing output directories are created automatically. The baseline must cover at least two comparison windows.

Run the timing helper locally; there is no in-workflow timing-summary job (a permanently disabled one was removed once the local helper became the tool everyone actually used). For build timing, check the `build-artifacts` job's `Build dist` step: `pnpm build:ci-artifacts` prints `[build-all] phase timings:` and includes `ui:build`; the job also uploads the `startup-memory` artifact.

The `Run Node test shard` step prints Bash `time -p` totals: elapsed (`real`), user CPU (`user`), and system CPU (`sys`) seconds, including waited-for child processes. Compare CPU totals with elapsed time across equivalent runs to distinguish extra CPU work from slower execution with similar CPU work. These totals alone do not establish runner contention.

Node test shards that need a built CLI run `pnpm build qaRuntime` before starting
Vitest. This profile builds runtime JavaScript, plugin assets, and freshness and
provenance metadata. Private QA shards select their private runtime entries. The
`build-artifacts` job owns Control UI and SDK declaration validation; release
package builds still generate the full declarations.

Declaration caches hash the selected writer's transitive generator imports,
package and plugin metadata, explicit schema and build metadata inputs, and
the compiler's recorded source files. Editing an unrelated CI script does not
rebuild declarations. Resolution topology still participates in the cache key,
and an unresolved generator import stops the build instead of trusting a cache.

Local `pnpm build:ci-artifacts` uses the same memory admission as full and package
builds. The orchestrator passes the resolved heap budget to every child process,
including the SDK declaration writer, so local builds do not depend on CI's
`NODE_OPTIONS` setting. The existing policy accounts for host and cgroup limits
and reserves native-memory headroom. If the default budget cannot fit the build,
it stops before build steps or cache restoration; `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB`
remains the explicit operator override for attempting a different budget.

## Control UI size budgets

`pnpm ui:build` produces and verifies the bundle, then reports its compressed
sizes. Budget violations do not prevent artifact generation. The separate
`control-ui-performance` job enforces the budgets without blocking other jobs
from building or testing the same source.

Startup CSS has a 45 KiB advisory target and a 50 KiB hard ceiling. Growth below
1 KiB passes; an increase of 1 KiB or more in either startup CSS or the largest
CSS file fails the comparison. The existing largest-file, JavaScript, request-count,
and isolated-renderer ceilings still apply independently. Reports include exact
bytes, base deltas, and remaining headroom, with an early warning when the largest
CSS file has less than 1 KiB of headroom.

CI builds the selected checkout and the exact preflight base with the same
installed Node, Vite, and dependencies. The temporary base's CSS sidecars are
normalized through the candidate's pinned compressor before comparison. The
report identifies both revisions and the toolchain. There is no manually updated
CSS baseline, and the cumulative ceilings still bound a series of small changes.

Run the same comparison locally after installing dependencies:

```bash
pnpm ui:check-performance:base <base-commit-sha>
```

To enforce absolute budgets on an existing build, run `pnpm ui:check-performance`.
Use `--base-dist <directory>` to compare with an already-built base, or
`--report-only` to report violations without failing. Missing or malformed build
artifacts remain errors in report-only mode.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
