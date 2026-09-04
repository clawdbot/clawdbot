---
summary: "CI job graph, scope gates, release umbrellas, and local command equivalents"
title: "CI pipeline"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging a failing GitHub Actions check
  - You are coordinating a release validation run or rerun
  - You are changing ClawSweeper dispatch or GitHub activity forwarding
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
`release_gate` fallbacks retain the pull request's macOS, iOS, and native
generated-locale scope instead of forcing unrelated Apple lanes or locale
parity. Native source verification still runs. Android lanes stay opt-in through
`include_android` (or the `release_gate` input). Release-only
plugin coverage lives in the separate
[`Plugin Prerelease`](#plugin-prerelease) workflow and only runs from
[`Full Release Validation`](#full-release-validation) or an explicit manual
dispatch.

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
| `macos-swift`                    | Swift lint and build for the macOS app, plus tests for the app and shared OpenClawKit package                                                                                                                                                                                                            | macOS-relevant changes                                 |
| `ios-build`                      | Separate Release device build and Debug/simulator test phases; lifecycle and Watch operation tests remain in the test phase                                                                                                                                                                              | iOS/capture changes                                    |
| `ios-screenshot-shard`           | Two device-family shards using the locked Ruby/Fastlane bundle: iPhone in one job, and 13-inch iPad plus Watch in the other; scenarios stay serial within each device                                                                                                                                    | Screenshot-risk changes and manual CI                  |
| `ios-screenshot-evidence`        | Hosted reducer that verifies exact artifact/family topology, digests, every OpenClaw-managed capture-attempt outcome (including failed invocations without an xcresult), and run provenance before publishing the canonical release screenshot artifact                                                  | After both screenshot shards                           |
| `android`                        | Phone and Wear unit tests, debug builds, Android lint, and Kotlin lint                                                                                                                                                                                                                                   | Android-relevant changes                               |
| `openclaw/ci-gate`               | Final aggregate: requires preflight and security; rejects selected skips and every downstream failure or cancellation                                                                                                                                                                                    | Every non-draft CI run                                 |
| `openclaw-performance`           | Separate workflow: daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.6 live lanes                                                                                                                                                                             | Scheduled and manual dispatch                          |

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

The singleton smoke then rebuilds the runtime plugin overlay before any other verifier reads it. On Blacksmith, Gateway watch finishes its build-receipt writes and whole-tree measurement next; Doctor, SQLite lifecycle, channel, core-support-boundary, and Discord attachment checks can then overlap. Hosted 4-core runners keep their existing serial sequence and channel/core pair. TUI canaries run after all other verifiers finish. Every verifier owns a separate Vitest module cache, and each selected result remains part of the same failure aggregation. The wave step is unconditional because its startup and singleton checks always run; individual checks retain their selection gates. The artifact job consumes only its selected checkout, so base-commit fetching stays with jobs that actually compare revisions.

Use `pnpm ci:timings`, `pnpm ci:timings:recent`, or `node scripts/ci-run-timings.mjs <run-id>` to summarize wall time, start delay, slowest jobs, failures, and the `pnpm-store-warmup` fanout barrier from GitHub Actions. Use `pnpm ci:timings:trend` for a 72-hour baseline and a latest-12-hours versus prior-12-hours comparison. Trend mode includes every main push outcome, cancellation/pass rates, and successful-run wall time, then loads a balanced latest/prior sample of at most 100 successful runs by default. Its detailed sample separates workflow admission, job dependency/gate delay (`job.created_at` minus the first job's creation), runner queue/start latency (`job.started_at` minus `job.created_at`), and execution; it also reports critical-path ownership and the actual GitHub API request count. Reruns use attempt-specific jobs and are excluded from run-level wall/admission distributions because GitHub retains the original workflow creation time. Raise or lower the detailed-run selection cap with `--detail-runs` (a run with more than 100 jobs requires multiple requests), emit JSON to stdout with `--json`, or save the same report with `--output .artifacts/ci-timings/trend.json`; missing output directories are created automatically. The baseline must cover at least two comparison windows.

Run the timing helper locally; there is no in-workflow timing-summary job (a permanently disabled one was removed once the local helper became the tool everyone actually used). For build timing, check the `build-artifacts` job's `Build dist` step: `pnpm build:ci-artifacts` prints `[build-all] phase timings:` and includes `ui:build`; the job also uploads the `startup-memory` artifact.

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
for the remaining rollup checks to finish without failures. Supersession stays
within workflow identity; `Auto response` is excluded from the wait.

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

## Checkout ownership

The shared Linux Node checkout (`linux_node_checkout_step`) and shared Windows/macOS/iOS checkout (`platform_checkout_step`) use one process owner for every Git command within those anchors. Linux allows five whole-checkout attempts, clearing the workspace before each attempt, with 120-second candidate and trusted workflow-harness fetch deadlines and an increasing five-second backoff. Windows, macOS, and iOS retain 90-second fetch deadlines, three candidate fetch attempts on timeout only, five-second backoff, and one harness fetch attempt. Candidate and harness revisions remain separately pinned; when they match exactly, the owner copies only tracked action files from the freshly checked-out index into an independent harness directory without another fetch or index update. Different revisions retain the separate sparse, blobless harness fetch. Linux also fetches the optional comparison base at depth one for ratchets, protocol checks, PR temp reports, and changed npm-lock checks.

The sole maintained owner is `.github/actions/git-owner/owner.py`. `pnpm ci:git-owner:gen` projects it into the one pre-checkout Python heredoc in `ci.yml`; `pnpm ci:git-owner:check`, workflow checks, and the Git boundary test lane reject drift. The standalone composite action copies its own trusted bytes into a unique runner temporary directory and publishes `owner-path` and `CI_GIT_OWNER`. Neither bootstrap loads an owner from the selected candidate. Both use isolated Python (`-I -S`) and only its standard library, without a Git or network bootstrap.

Timeout, cancellation, and leader exit drain the owned POSIX process group or Windows Job Object before workspace deletion, another Git command, or step completion. Cleanup has a ten-second allowance, separate from the operation deadline. POSIX cleanup uses a checked process census to distinguish terminated zombies from live writers. A denied group signal can be accepted only when that census proves there are no live members; live or unknown state still fails closed. After inspection failure, KILL is followed by group-disappearance observation within the remaining cleanup allowance; waiting for the leader alone is insufficient. Failed inspection or cleanup closes the owner and exits with code 125; later calls in the same policy cannot launch Git. Once cleanup succeeds, cancellation takes precedence over timeout or ordinary Git failure, including cancellation received during draining. A fetch timeout alone does not explain why transport stalled.

The terminal exception boundary exits with 125 and appends a `[ci-git-owner] diagnostic=` record to its existing fail-closed annotation. The diagnostic reports up to four exceptions, following explicit causes before implicit contexts, with known exception types and bounded integer `errno`/`winerror` values when available. Each exception includes up to six owner-source function names and line numbers; these identify calls in the pinned owner revision. Traversal stops after 256 traceback frames per exception and marks truncation. Policy frames, paths, messages, arguments, commands, environment, and credentials are omitted. Unknown exception types are labeled `unknown`; diagnostic failures report `unavailable` without replacing the terminal exit. `FetchTimeout` is reported only when present in the chain. Earlier failures without this evidence retain an unknown cause; elapsed time or exit 125 alone cannot establish a timeout or a particular failing API.

Straight-line callers use `--git <seconds> <args>`; zero means no operation deadline. Recovery policies use `--policy <trusted-python-file>` or `--policy -` (trusted source on stdin) in the same Python process and import `run_git`, `git_output`, `GitFailure`, and `FetchTimeout` from `ci_git_owner`. Policies catch only ordinary Git failures and operation timeouts. Ordinary Git exits 125 and 143 remain distinct from ownership failure and cancellation inside that typed boundary; shell exit codes alone cannot distinguish them. Generic Git and policy invocations require no GitHub or runner environment. `run_git` accepts output streams and command-local environment overrides without persisting Git configuration; cleanup always uses the shared ten-second allowance. Git stdin is always `DEVNULL`. `git_output` returns exact UTF-8 text with surrogate escapes for undecodable bytes, preserving whitespace and NUL separators; only checkout ref resolution trims output. Inline policy lets a running workflow supply its own trusted policy to a pinned owner without importing code from the selected checkout.

Preflight, manual security, Python skills, ClawHub docs source, and Android reuse that owner. Preflight and Python skills retain three timeout-only depth-one fetch attempts; manual security keeps depth two and its unavailable-target fallback. Preflight separately retries depth-two blobless parent metadata on any Git failure and verifies exact requested SHAs even when an event ref moves. ClawHub and Android retain five whole-checkout attempts: only the ClawHub source directory is cleared for docs, while Android clears its candidate workspace and requires an executable Gradle wrapper. Preflight reuses that index export after the complete candidate checkout when revisions match; different revisions retain the pinned Actions checkout and its existing transport/retry contract after the candidate SHA is resolved. Android keeps its separate trusted-harness checkout.

The security scan fetches its PR-count-derived history during the first authenticated checkout, before checkout removes credentials. Protocol checks, PR temp reports, and changed npm-lock checks likewise consume the exact comparison SHA prepared during checkout, with no later base fetch. Manual npm-lock dispatches and targets without changed-check support retain the full sweep. Remaining supplemental fetches in `ci.yml` use the workflow-owned bootstrap from the runner temporary directory, never a helper from the selected candidate. Release-gate ratchets retain six merge-snapshot attempts; cleanup uncertainty or cancellation stops consumers. Preflight resolves default-branch and release refs through authenticated GitHub API calls, then passes the resolved SHAs to cache classification and the manifest planner. Correction-base lookup finishes before candidate-owned code runs, and its token stays outside the manifest step.

Lock reclamation is separate from process ownership. The checkout and base-fetch policies pass `reclaim_locks=True` only for their exclusively owned checkout; supplemental CI fetches select the equivalent `--checkout-git <seconds> <args>` entrypoint. After a failed or terminated fetch and verified process-tree extinction, the owner removes newly created locks in physical Git metadata; pre-existing locks and linked metadata remain untouched. Generic Git calls do not claim metadata, so read-only commands also work in linked worktrees.

The shared `ensure-base-commit` action resolves the adjacent owner from its own action package and runs its availability/recovery policy in process. It retains 30-second fetch deadlines: exact SHA at depth one, then deepen by 25, 100, and 300, then a plain ref fetch (not `--unshallow`). Availability is checked after successful fetches and ordinary failures, but never after cancellation or unverified cleanup.

Workflow Sanity is the first external pinned typed-policy adopter: after Python 3.12 setup, it prepares `git-owner@dd4528b6393e7d00063067a080ca7241b48ce475` and supplies the trusted audit-config policy inline. An already-present base commit skips transport. Otherwise, its exclusively owned checkout enables lock reclamation while retaining 30-second fetch deadlines, at most three attempts per ref, and five-second cancellation-aware backoff only between timeout or ordinary Git 124/137 retries. Ordinary exact-SHA failure or retry exhaustion permits branch fallback; ownership failure or cancellation does not. Each config independently selects the exact SHA or existing remote branch with unbounded local reads, and the environment path is published only after both configs and the Zizmor path rewrite succeed.

QA Profile Evidence is another pinned terminal adopter of `git-owner@dd4528b6393e7d00063067a080ca7241b48ce475`. Each Git-using job prepares the owner outside later checkouts using the established system Python bootstrap. Its four validation/protocol fetches retain 120-second operation deadlines; its six trusted-harness and selected-source bootstrap fetches retain no operation deadline. All ten use straight-line `--checkout-git` calls with one attempt, so ownership failure or cancellation stops before downstream checkout, readback, or publication. Called-workflow identity and selected-source trust classification remain separate and unchanged.

Mantis ref validation uses the same pinned owner. The shared `mantis-validate-trusted-ref` action owns one unbounded main fetch, even with both baseline and candidate refs. Discord smoke validation owns two fetch sites with 120-second deadlines: main, then the exact release branch when needed. Each fetch has one attempt and must drain before trust probes or outputs. The validators retain distinct trust policies and output contracts; a Discord release-branch mismatch never falls through to PR lookup.

Mantis installers and worktree preparation also use that pinned owner, prepared immediately after the harness checkout in each run job. Discord status reactions and thread attachment retain their two depth-one Crabbox clones with 120-second deadlines through `--git 120`. Slack desktop retains init, remote-add, one depth-one fetch of `main`, and detached `FETCH_HEAD` checkout; only its fetch has a 120-second deadline. All six worktree additions across status reactions, thread attachment, Slack desktop, and Web UI chat proof use `--checkout-git 0` from the harness checkout. Local init, remote-add, checkout, and worktree operations have no operation deadline. Ownership failure or cancellation is terminal before subsequent Git operations, Go/pnpm builds, probes, or outputs. No current Mantis Git invocation uses GNU `timeout`.

Docs Sync Publish Repo prepares the same pinned owner after the source and ClawHub checkouts, using system Python before Node setup. Its inline typed policies own clone and the connected publication chain. Clone and both fetch sites retain 120-second operation deadlines; clone and publication retain five attempts with 2/4/6/8/10-second backoffs, including the final failed attempt. Only ordinary Git failure or `FetchTimeout` permits retry after verified cleanup. The advisory pre-commit fetch may fail and safely continue to commit; publication failure first attempts an owned rebase abort. Rebase, push, local reads, and config/add/commit remain unbounded. ClawHub HEAD must complete through the owner before the sync script consumes it. Cleanup uncertainty, setup failure, or cancellation is terminal before retry, abort, another deletion, or consumption. Only the fixed publish path is replaced, without following its symlink; exclusive publish operations reclaim newly created locks while preserving existing locks. Queue concurrency, stale-source checks, and no-change success remain unchanged.

Docs Agent prepares the same pinned owner immediately after checkout. Two trusted inline gate policies own Git before and after the unchanged shell GitHub/JQ cadence block; manual dispatch and superseded CI exit before that query. The connected commit policy owns diff, config, staging, commit, fetch, push, and stale-main readback. Gate and commit each retain five `fetch --no-tags` attempts with 120-second deadlines and exclusive-checkout lock reclamation. Gate backoffs are 2/4/6/8 seconds, only between attempts; commit fetch and push failures retain 2/4/6/8/10 seconds, including the final failure. Local reads, docs-only enforcement producers, config/add/commit, and push remain unbounded. Only typed ordinary Git failure or `FetchTimeout` permits the existing recovery paths after verified cleanup; setup, census, cleanup failure, and cancellation are terminal before retry, fallback, outputs, or downstream work. The one-hour cadence, REST `.id` current-run exclusion, cancelled/skipped exclusions, and review-base ordering remain unchanged.

Generated PR publication prepares the same pinned owner before minting tokens. One trusted action policy owns every Git operation through staging, commit, overlap/invalidation checks, neutralization, leased push, reconciliation, and auth cleanup. Branch-head lookups and pushes retain 60-second deadlines; base fetches retain 120 seconds; local Git stays unbounded. There is no general Git retry or backoff. Only the existing deletion race permits one fresh-base rebuild and one create-only push after the observed nonempty head disappears. Typed ordinary `GitFailure` and `FetchTimeout` allow that semantic recovery only after verified cleanup; status 125 or 143 alone cannot identify an owner failure or cancellation. Git read failures cannot become no-overlap or merged-tree success. Cleanup uncertainty or cancellation stops before another Git/GH command, fallback, output consumption, summary, or auth-cleanup success. GitHub CLI commands retain their existing GNU timeout and reconciliation policies. The publisher remains the terminal step for Control UI locales, native locales, CI timing refit, and maturity publication.

Maturity Scorecard prepares that immutable owner immediately before selected-ref checkout, preserving its runner-temporary environment handoff across checkout. Its trusted inline policy owns the full validation decision. Main, release-branch, and publication-base fetches and all local probes remain unbounded with one attempt. The sole 60-second operation is `ls-remote --exit-code --heads`: ordinary status 0 selects the branch, status 2 retains the default branch, and every other status fails with the lookup diagnostic after cleanup. A timeout is not absence; owner failure and cancellation never select a fallback or publish outputs. Main-ancestor, release-tag, and exact release-branch-head trust ordering, floating-main freeze, publication ancestry and excluded-path diff checks, and publication hash bytes remain unchanged.

Linux App Release, macOS Release, and NPM Placeholder Bootstrap prepare the same pinned owner before their selected-source checkout. Linux keeps one `fetch --quiet origin main` with its 120-second deadline, then performs tag peeling and main ancestry locally without operation deadlines; ordinary ancestry nonzero retains the existing main-reachability rejection, while lifecycle failure or cancellation cannot publish `tag_sha`. macOS keeps its unbounded `rev-parse HEAD`, exact forced public-branch refspec, checkout-persisted read authentication, and one 120-second fetch before the metadata checker. NPM Placeholder keeps non-Git workflow/target identity rejection before checkout inspection, one 120-second forced main fetch, and two unbounded ancestry checks before publishing the immutable target SHA. None adds retries or backoff. The macOS metadata checker's separately owned ten-minute ancestry subprocess remains outside this explicit workflow-Git adoption.

Plugin ClawHub Release and Plugin NPM Release also prepare that owner before selected or trusted checkout. ClawHub retains its main/release fetch, optional release-tag fetch, and matching-alpha fetch, each with a 120-second deadline; npm retains its extended-stable, main/release, matching-alpha, preflight-readback, and publish-readback 120-second fetches. Local probes, ref enumeration, ancestry, checkout, and object reads remain unbounded. ClawHub preserves local-to-origin ref fallback after safely drained ordinary probe failures; the resolved commit still must pass separate OIDC identity and ancestry checks. Only merge-base status 1 advances to the next trust source; other ancestry errors and failed release-ref enumeration are terminal. Owner failure and cancellation are terminal throughout, including during ref resolution. Exact source `package.json` bytes are written only after fetch and `git show` drain, before hashing or publication evidence consumption. No Git retry or backoff is added, and npm's separate 300-second token-bootstrap publish deadline is unchanged. Push-triggered plugin range discovery and manifest history reads remain separately owned by their Node callers and are not claimed by this workflow adoption.

To use the standalone action from another workflow, pin `openclaw/openclaw/.github/actions/git-owner@<full-40-character-commit-SHA>` to a reviewed revision containing the action. Supply policy from the trusted workflow inline or from the same trusted action package, never from the selected candidate. Within `ci.yml`, the existing bundled-protocol and CI-routing matrix tasks smoke-test the action from the separately pinned `.ci-harness` checkout before Node setup, compare its output and copied bytes, and run owned `git --version` without network access. Other workflows' direct Git commands remain outside this ownership coverage until they adopt it.

## Scope and routing

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`. Ordinary manual dispatch skips changed-scope detection and makes the preflight manifest act as if every scoped area changed. The exact-head `release_gate` exception evaluates the fetched pull request merge tree and retains its macOS, iOS-build, screenshot-risk, and generated-native-locale decisions while still verifying native sources.

Release screenshot routing is deliberately conservative because an app change can break deterministic App Store capture without breaking compilation. Pull requests and exact-head release gates run the full iPhone, iPad, and Watch matrix when the diff touches `apps/ios/**`, linked OpenClawKit or Swabble code, Apple Swift configuration, or the scripts used by screenshot capture. The two device shards start alongside `ios-build (release)` and `ios-build (tests)`, because each owns its simulator build and consumes no output from those jobs. CI keeps scenarios serial within each device and captures Watch evidence in the iPad shard. The final gate independently requires both build phases and both screenshot shards. Both build phases and both screenshot shards start on GitHub-hosted `macos-26`; the test phase retains Debug compilation, Swift lint, lifecycle tests, and Watch operation tests. Frozen compatibility targets retain their existing Debug-only build contract. A hosted reducer verifies the exact evidence union before publishing the sole canonical artifact consumed by `openclaw/ci-gate`. Ordinary manual CI and full-scope release validation run that matrix; `npm-beta` and `npm-stable` defer native qualification. The screenshot decision is independent of macOS routing; a pure iOS app change does not select macOS jobs by itself.

Separate iOS and macOS Periphery workflows enforce a zero-findings dead-code policy. Each runs only when a non-draft pull request touches its native scan scope, or when manually dispatched.

The macOS Periphery scan always uses GitHub-hosted `macos-26`. For eligible same-repository first attempts, this transfers the existing scan's runner registration from `blacksmith-12vcpu-macos-26` to hosted capacity and avoids measured Blacksmith admission waits. The iOS and shared OpenClawKit scans retain trust-aware Blacksmith-first routing with hosted reruns.

- **CI workflow edits** validate the Node CI graph, workflow linting, and the Windows lane (`ci.yml` executes it), but do not force iOS, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
- **Git-owner changes** to its action, base-commit policy, projection generator, lifecycle tests and support, or named owner-adopting workflows such as Workflow Sanity, QA Profile Evidence, Mantis ref validation/installers/worktrees, Docs Sync Publish Repo, OpenClaw Performance, the Linux/macOS/npm-placeholder release admission jobs, and plugin ClawHub/npm publication select the existing `macos-node` and Windows lanes. These run native checkout ownership proof without selecting Swift, iOS, or Android jobs; Mac app and shared-native changes retain their existing Mac lanes.
- **macOS Swift runner budgets** are 20 minutes per worker on Blacksmith and 30 minutes per worker on every GitHub-hosted route, including first-attempt pull requests from untrusted contributors. The `macos-swift` matrix runs two independent phases: `release` owns lint, schema checks, and the release app build; `tests` owns the Talk opt-out build, shared package suite, app coverage build/tests, and health renders. Both phases must pass the existing CI gate. At most two workers run concurrently, and a failed phase does not cancel the other phase's diagnostics. This adds one runner per selected native run without changing runner routing or the other matrix caps.
- **macOS fixture support** changes select the existing Mac Node gate so the shared managed-command and concurrency owner receives Darwin proof independently of Swift/app changes.
- **macOS Swift build caches** retain the original nanosecond timestamps and content hashes of their source inputs inside `apps/macos/.build`. The restore helper replays timestamps only for byte-identical regular files with matching permissions in the current input inventory; changed, missing, linked, or invalid entries keep their checkout metadata and invalidate through SwiftPM normally. The v6 archive keys include the phase, helper, toolchain, package graph, and source identities, with same-phase, same-graph prefix reuse. Each phase starts with a cold seed instead of restoring the former combined build archive, then records metadata immediately before its own trusted save. Both phases may restore the shared SwiftPM dependency cache, but only `release` saves it. Candidate cache trust is unchanged: cache-off validation compiles both phases cold. Historical targets retain their target-owned build commands.
- **Workflow Sanity** runs `actionlint`, `zizmor` over all workflow YAML files, the composite-action interpolation guard, and the conflict-marker guard. The PR-scoped `security-fast` job also runs `zizmor` over changed workflow files so workflow security findings fail early in the main CI graph.
- **Docs on `main` pushes** are checked by the standalone `Docs` workflow with the same ClawHub docs mirror used by CI, so mixed code+docs pushes do not also queue the CI `check-docs` shard. Pull requests and manual CI still run `check-docs` from CI when docs changed.
- **TUI PTY** runs two built-CLI artifact canaries in `build-artifacts`: a local model roundtrip and a real Gateway connection. The complete suite is defined in `test/vitest/vitest.tui-pty.config.ts`; canonical pull-request fallbacks and manual/release full plans retain its `core-runtime-tui-pty` descriptor. CI consumes that descriptor only through the built-artifact selection flag, so the full suite has no executing matrix row; manual and release CI also run only the canaries. Canonical `main` push compaction omits the full descriptor while keeping the canaries.
- **SQLite session lifecycle** runs the built-CLI migration, restart, compaction, cleanup, and session RPC proof only when the diff touches its direct storage/session owners or a reachable session path in the embedded runner. The `build-artifacts` verifier wave runs it against the runtime already built in that job, after the isolated startup-memory measurement. It overlaps independent readers on Blacksmith and stays serial on hosted runners; manual and release dispatches always select it when the target contains the proof.
- **CI routing-only edits, the small set of core-test fixtures the fast task runs directly, and narrow plugin contract helper edits** use a fast Node-only manifest path: `preflight`, `security-fast`, and only the fast lanes the change touches — a single `checks-fast-core` CI-routing task, the plugin contract job, or both. That path skips build artifacts, Node 22 compatibility, channel contracts, full core shards, bundled-plugin shards, and additional guard matrices.
- **QA Smoke on pull requests** runs only when the diff touches a QA-owned surface: the qa-lab harness, `qa/` scenario data, the matrix/telegram channels the smoke profile drives, the docker packaging scripts, or the gate's own orchestration. Broad runtime changes (src, ui, packages, dependency manifests) no longer select the six-part smoke matrix per PR; every canonical `main` push and release validation still runs the full profile set, so runtime regressions surface one push after merge instead of taxing every PR with roughly five extra hosted-runner minutes.
- **Windows Node checks** are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes. Test-only changes to any explicit target in `test:windows:ci:1` or `test:windows:ci:2` also select the existing Windows lane; these package scripts own its test inventory.

The slowest Node test families are split or balanced so each job stays small without over-reserving runners:

- Plugin contracts and channel contracts each retain two weighted process selections in one job, with the standard GitHub runner fallback. Frozen targets keep separate jobs.
- **Additional checks:** Current targets combine export-collision, session accessor/transcript reader, SQLite transaction, and SQLite schema checks into one serial source-contract row, preserving each command and collecting every failure. Additional checks use five rows on push/PR and six on current-target dispatch; the SDK API report is allocated only for dispatch. Frozen targets retain their eight original rows and historical command fallbacks.
- Core unit fast/support lanes run separately; unit-src, Control UI, and gateway-core each use three deterministic file-weighted stripes, while the security and media/UI companion configs retain their scoped whole-config support groups; core runtime infra splits into process, shared, hooks, secrets, and three cron domain shards.
- Auto-reply runs as balanced workers, with the reply subtree split into agent-runner, commands, dispatch, session, and state-routing shards; dispatch further isolates core, delivery, and lifecycle entrypoints.
- Agentic gateway/server (control-plane) configs split across chat, auth, model, HTTP/plugin, runtime, and startup lanes instead of waiting on built artifacts.
- Normal CI packs only isolated infra include-pattern shards into deterministic bundles of at most 64 test files, reducing the Node matrix without merging non-isolated command/cron, stateful agents-core, or gateway/server suites. Heavy fixed suites stay on 8 vCPU while most bundled and lower-weight lanes use 4 vCPU. Previously promoted compact workloads retain 8-vCPU capacity through their semantic owners and selected files before packing. Timing or build-ownership changes cannot transfer that capacity to an unrelated row. Hosted stripes inherit their parent owner's capacity; whole named manual and release plans retain their existing routing.
- Pull requests on the canonical repository reuse the changed-test resolver against the synthetic merged-tree diff. Precise core changes use bounded targeted jobs; plugin changes retain their owning configs and pack compatible envelopes into serial jobs. Each selected test file keeps its existing process isolation. The planner combines sibling tests with import-graph dependents and falls back to a metadata-complete compact plan for workspace package, package/lockfile, shared harness, split-config, renamed, or deleted changes, public extension-contract changes, tests with special shard setup, partially resolved or empty targets, oversized path or target plans, and planner errors. Nondist descriptors run as Node jobs; dist descriptors fold into the built-artifact boundary. The number of compact jobs follows the current measured weights. That PR fallback retains all sixteen tooling stripes, the isolated tooling shard, and the TUI PTY shard because scripts and PTY owners intentionally require their Go, dist, and environment metadata. Those timing-sensitive groups remain isolated in concurrency-one exclusive bins. Targeted plans always retain the full boundary gate because its repository scanners cannot be derived from imports.
- When canonical pull requests fall back to compact planning, directly changed, existing tests owned by the release-only plugin shard remain as exact-file selections in the existing compact jobs. Canonical Vitest routing keeps unit-fast, contract, bundled, and E2E tests with their own suites; source files, directories, deleted tests, and live tests do not widen plugin coverage. The broad `agentic-plugins` sweep remains release-only, and push and manual CI plans are unchanged.
- Canonical `main` pushes use a Blacksmith integration compact with nondist Node jobs plus the dist boundary descriptor. Former multi-config walls (CLI plus CLI-process, isolated plus fake-timers unit fast, and the logging/process/runtime-config trio) are split into per-config shards so no single group floors a lane. Real Node+TSX command tests belong to the isolated CLI-process catalog, so ordinary CLI tests do not prepare a runtime. The process catalog splits into five groups, with split sizing bounded below by its complete file costs and runtime prerequisite so an older aggregate timing cannot hide newly owned work. File packing also includes the prerequisite, and only the child containing the update dry-run consumer prepares that runtime. The gateway process file stays alone because its cold proof already takes 200 seconds. CLI owners retain the 150-second serial-group admission target and their two-worker limit; the hosted runtime prerequisite itself has a 160-second floor. They omit the low-signal-per-push tooling and TUI PTY groups while retaining all product-runtime groups, including three file-weighted stripes apiece for unit-src, Control UI, and gateway-core. Blacksmith serial admission stays at 200 seconds for the large class and 276 seconds for the small class. Ordinary groups that can share two process slots admit 360 predicted aggregate seconds; a group already above its serial cap stays alone. Manual dispatches and Full Release Validation retain the full named per-shard matrix. No scheduled workflow currently runs that full Node suite; this is a known coverage-timing gap, not coverage supplied by this compact plan.
- Doctor session and cron tests keep the two longest SQLite files in separate shards, with the remaining files together. Each shard runs complete files under the commands config's existing execution policy. The three owners cannot share a compact job; Blacksmith gives them 8-vCPU placement and its 200-second admission target. The two new owners charge the observed file body plus the full group overhead until the canonical timing refit has two successful main-run samples. Fixture sizes, assertions, and process isolation are unchanged.
- Direct measurements for generated hosted stripes own their packing weights just like native groups. GitHub runs use hosted measurements and hybrid attempt-one runs use Blacksmith measurements; only unmeasured children divide the parent estimate. This keeps an expensive measured child from being packed beside extra work under an artificially small estimate while preserving its test partition, worker pins and per-child file execution policy.
- Changed-plugin jobs run their independent config envelopes serially, including configs whose inner process chunks also run sequentially. The existing worker policy can then use the detected CPU budget without reserving capacity for overlapping plans; multi-target jobs retain their separate concurrency policy.
- The sixteen tooling stripes use measured file weights to keep the Git owner, managed-process, worker-artifact, and transform-cache proofs in separate jobs. Go setup follows explicit selected files first. For whole-config tooling plans, only the ordinary tooling config owns the docs i18n Go tests; isolated and Docker catalogs do not. Unknown historical configs retain their original Go setup. The shard containing the unified declaration compiler fixture retains the existing larger runner; hosted splits carry that placement through each child's selected files before packing. Its synthetic compiler graph uses the existing 1,024 MB heap override, while production full builds keep their resource guard. Git owner cases each own an isolated checkout and process tree, so their real timeout and cleanup checks overlap at most two cases per runner. Worker transform proofs use a separate suite with its own fixture lifetime; late child cleanup cannot remove another suite's inputs. These changes preserve the test cases, deadlines, and process isolation; measured admission determines the job count within the existing hybrid row cap.
- Blacksmith numbered tooling bins request the 32-vCPU class after packing while retaining their logical runner classes, names, file inventory, serial project/file execution and two-worker pins. In run 33689551111, the three slowest tooling bins received two CPUs and 8 GB of memory; their 314–342-second bodies set an eight-minute non-Windows wall. The larger request addresses that host-capacity mismatch without adding shards. Hosted and hybrid tooling placement is unchanged; the request needs native timing proof before claiming the eight-minute target.
- Control UI browser projects greedily pack discovered test files using committed per-file timings, then cold-start basename hints, then source byte size. Bundled files default to at most two workers, bounded by the shared worker limit and local throttling; explicit Vitest CLI worker overrides remain available. Private source servers, real Gateways, and runtime-budget tests stay in a single-worker project; local whole-suite runs finish bundled work before starting that project. Per-file overhead is refitted from serial invocations; parallel invocations still update their file weights. Timing keys supply weights only: discovery still determines the complete test inventory, including new files and files without measurements.
- Broad browser, QA, media, and miscellaneous plugin tests use their dedicated Vitest configs instead of the shared plugin catch-all. Include-pattern shards record timing entries using the CI shard name, so `.artifacts/vitest-shard-timings.json` can distinguish a whole config from a filtered shard.
- The browser-extension Chromium bootstrap command prepares `qaRuntime`. It builds the native-host and relay JavaScript and runtime assets; the separate artifact job owns Control UI and plugin SDK declaration validation. The real Chromium flow and its assertions are unchanged.
- The browser native-host launch test is a separate POSIX E2E case. Linux `build-artifacts` runs it explicitly after building or restoring dist, using `OPENCLAW_E2E_USE_PREBUILT_DIST=1` so the test cannot start another build. Its JSON report must contain exactly the named passing assertion in the expected file, with one passed test and zero failures, pending tests, or todos; missing artifacts, skipped tests, and absent results fail. The workflow step skips only when a frozen historical checkout lacks the test file: that is unavailable historical proof, not coverage. Current checkouts with a missing file still fail. Changes to the case, its installation fixture, or its relay-key fixture select the artifact job even on test-only diffs; unrelated browser unit tests stay build-free. Manual CI uses the same artifact step, independently of the release-only plugin sweep.
- Linux Node shard jobs persist Vitest's experimental filesystem module cache through the upstream Actions cache API. On Blacksmith runners, official cache actions use [Blacksmith's colocated cache backend](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions) instead of GitHub's, so cache entries are backend-local even when their keys match. Blacksmith CI shards are restore-only and unpack the protected Blacksmith seed into isolated runner-local roots. While the GitHub-hosted outage backend is active, every `checks-node-*` test shard, `checks-ui`, the ordinary sharded `checks-ui-e2e` job, both fast contract matrices, and the Vitest-running `checks-fast-core` tasks restore a separately published immutable transform seed from GitHub's backend. The composite action's single default-off `restore-test-caches` input keeps the expansion easy to disable without changing cache keys or writer policy; mixed fast-core rows enable it only for tasks that invoke Vitest. The real-Gateway UI job does not restore these test caches; native and Control UI i18n lanes do not invoke Vitest. The hybrid planner profile uses matching key contracts across two backend-local archives: attempt-1 Blacksmith rows read the Blacksmith seed, while hosted retries can read only a separately published GitHub seed. Ordinary CI jobs remain restore-only; the separate trusted warmer owns protected backend-local cache publication. The non-cancelling warmer follows main, runs daily, accepts manual or repository dispatch, and serializes per ref. Its Linux row follows `OPENCLAW_CI_RUNNER_BACKEND` and publishes only to the cache backend serving that selected runner. A hosted fallback therefore requires its own trusted hosted warmer seed; a successful Blacksmith publication does not populate GitHub's cache backend. Maintainers can select the existing hosted backend for an isolated trusted warmer without canceling a main writer. The Linux row launches each selected shard/config envelope through the normal runner in a fresh child process with concurrency one and `--testNamePattern=(?!)`. Collection preserves the include patterns, environment, compiled imports and per-file cleanup while reusing the same serial cache leaf. Test bodies run in ordinary CI; imports reached only inside those bodies can remain cold until that run. The warmer finishes every selected envelope and saves the content-keyed transform and compile caches even when collection fails, then reports the failure after the cache saves; ordinary CI shard execution remains fail-fast. This prevents config-global state from leaking, avoids expanding filtered shards into whole configs, and retains transforms produced by the previous child. Setup computes the transform-input fingerprint once when transform caching is enabled and passes it to restore and generation validation; disabled caches do not scan the checkout. The fingerprint clears incompatible lockfile, package, tsconfig, and Vitest-config generations. Before publishing, the trusted warmer scans and prunes the transform cache to 75% after it exceeds 2 GiB, and the Node compile cache to 75% after it exceeds 1 GiB. Consumer jobs never prune the restored seed. Vitest hashes module id, source content, environment, and resolved transform config, so ordinary partial source changes keep unchanged entries warm while changed modules miss safely. Coarse restore prefixes bridge workflow runs; normal Actions cache LRU and inactivity eviction bound old immutable archives.
- Trusted Blacksmith Linux Node jobs restore root `node_modules`, workspace importer trees (including plugin-local versions and links), and the workspace-local pnpm store from one immutable upstream Actions cache, which Blacksmith transparently serves from its colocated backend. Pnpm imports with hard links where the filesystem permits, and keeping the complete installed tree and store in one archive preserves those links. Pnpm's metadata cache lives beneath that same archived store root, so restored installs can verify supply-chain policy without depending on the producer's home directory. Source postinstall and build preparation leave pnpm-owned dependency trees intact. The key includes an explicit archive format, runner OS and architecture, the exact Node patch, and the semantic install-input fingerprint; there are no stale-prefix fallbacks. Manifests are canonicalized before hashing. The repository-owned `openclaw` metadata block and non-install scripts are excluded because pnpm and the audited direct root hooks do not read them, so runtime schema, publication metadata, formatting, and ordinary test/build script edits keep the dependency tree warm; unaudited lifecycle-hook drift fails closed until its source inputs join the fingerprint contract. Dependency, package-manager, hook-source, and lockfile changes always select a new immutable archive. Every exact restore runs frozen offline pnpm reconciliation, so an unchanged archive validates without registry access or importer relinking. If reconciliation fails, setup first clears every importer tree and rebuilds it offline from the restored store, then clears both modules and store and retries from the network rather than serving a partial tree. Setup then disables pnpm's redundant pre-run dependency check so install and frozen reconciliation remain the only dependency writers; shard commands must not launch concurrent implicit installs. The separate trusted warmer publishes the toolchain and exact dependency archives immediately after setup succeeds, before build and transform warming; preflight and downstream CI jobs are restore-only. Canonical pushes and same-repo pull requests opt into exact restores only on actual self-hosted runners, including hybrid attempt 1. An exact miss automatically falls back to the coarser pnpm store cache. Manual CI dispatches, fork pull requests, hosted lanes, and hosted retries use only that store cache. Cache restore/save failures are optimization misses rather than correctness failures, and normal branch scoping, LRU, and inactivity eviction bound obsolete archives. The former mutable dependency StickyDisk path was retired after repeated successful writers acknowledged commits that later runs still restored as empty filesystems.
- Node shard and build-artifact jobs also restore Node's portable on-disk compile cache through immutable Actions caches. In GitHub-hosted outage mode, the hosted Vitest lane set above restores the separately published GitHub test-scope archive alongside its transform seed. Independent `test` and `build` namespaces keep their bytecode separate. The trusted warmer owns the protected test seed; ordinary `build-artifacts` and test jobs only restore caches. PR and ordinary test jobs only read protected snapshots, so feature-branch bytecode never enters the shared seed and PR traffic creates no cache archives. This reuses V8 bytecode for Node-loaded orchestration, build tooling, and external dependencies across different checkout paths, including when only part of the source graph changes. A maximum-size 2 GiB transform archive costs roughly 15–20 seconds to restore at about 125 MB/s; measured fast-contract transforms are roughly 21 seconds against an approximately 8-second restore, and broader cold imports reach roughly 100–143 seconds. The optimization should be reverted if measured savings fall below restore cost. Vitest child processes disable an inherited compile cache because coverage can be enabled inside dynamic configs and V8 coverage can lose source-position precision when scripts are deserialized from bytecode.
- The existing Linux cache warmer publishes the native SDK declaration archive to the cache backend serving its selected runner before its full build. Hosted lint stripes and the dedicated package-boundary lane restore the matching archive from their runner's backend and validate native compiler inputs and complete outputs before reusing it. A Blacksmith warmer does not populate GitHub's cache backend, so hosted fallback requires a separately published hosted seed. After saving, the warmer removes its native SDK output so the subsequent packaged declaration cache describes the same tree as ordinary build consumers. Package-store contents and pnpm store-location bookkeeping are not compiler inputs; installed dependency bytes, resolution topology, explicit inputs, and compiler identity still invalidate stale declarations. The all-Blacksmith profile retains its read-only sticky-disk path. The Control UI and UI E2E jobs share a Linux Playwright Chromium archive keyed by the exact pinned Playwright version. The protected warmer also runs one standard hosted `macos-15` row that installs dependencies and publishes only the pnpm store after an exact miss. It uses the existing OS, architecture, Node-version, package, and lockfile key; macOS CI remains restore-only. This row leaves exact dependency, build, transform, and compile caching disabled and runs no build or test warming. Pnpm owns pruning, while the before/after disk usage and saved archive size expose retained content; pruning does not impose a content-store size bound.
- The build-artifact and Docker seed jobs restore the protected full-build cache through the shared Node setup action. Full, package, and `ciArtifacts` builds share `scripts/write-plugin-sdk-entry-dts.ts`: it stages the canonical public/private `tsdown` SDK declaration groups and caches each group independently. A hit restores into fresh staging; both cold and cached generations must contain every selected SDK entry and a complete relative declaration closure before publication to `dist/`. The SDK cache never adopts declarations from live `dist/`. Local plugin lint and package-boundary compilation use independent native declaration trees, not packaged declarations; see [declaration ownership](/reference/test#shared-test-state-and-process-helpers). The built Doctor plugin-index proof reuses that exact `dist/` output instead of invoking the E2E harness's fallback TypeScript build a second time.
- Full and package builds separately cache the AI, workspace-package, and remaining unified declarations. The unified runtime always rebuilds JavaScript before the shared declaration owner stages one base group and five plugin groups; the later SDK stage uses the same owner for its two groups. Both stages restore unchanged groups into private staging and compile only misses with the existing serial executor. They share one before/after input snapshot and validate every selected entry, successful compiler receipt, relative declaration edge, and shared-chunk owner before publication, including after package preparation clears `dist`. Conflicting shared bytes or changed consumed inputs fail before live declarations are written; cache records refresh only after successful publication. Canonical DTS configuration enables TypeScript stable type ordering so an unrelated literal allocation does not reorder an unchanged exported type in a rebuilt group. Full publication prunes obsolete declarations while preserving signed app bundles and Control UI assets; SDK publication owns only its flat entries and preserves other groups’ shared chunks. The AI and workspace-package steps also rebuild JavaScript on cache hits. Implicit and explicit declaration-enabled builds share those seeds; runtime-only profiles use an uncached graph and cannot publish declaration generations. Each declaration group hashes ordinary source bytes from its successful compiler Program, so edits to existing unconsumed tests, UI sources, and workflows retain its cache hit. The exact checkout-local `.cache/vitest` scratch root is excluded from resolution discovery; explicitly consumed inputs, installed aliases, and adjacent or nested paths still invalidate normally. It still validates inherited configuration, generator and package/plugin metadata, compiler identity, and resolution topology; consumed declaration dependencies and new resolution candidates invalidate the generation. Workspace-package changes conservatively invalidate the AI and package declaration caches. The protected warmer publishes build archives immediately after a successful full build, before unrelated test warming and pnpm maintenance. Every warmer attempt gets a new immutable archive key; coarse restore prefixes supply prior groups, and per-step signatures remain the sole content-validity owner. Rebuilt groups replace their complete owned cache trees, including obsolete bytes whose previous record is missing or invalid. GitHub's cache quota and inactivity eviction bound old generations; identical warmer attempts can publish separate archives. The weekly Node 22 lane instead publishes a 14-day artifact after successful `main` runs and restores only artifacts whose immutable producer identity resolves to that workflow on `main`, avoiding quota churn without allowing PR code to write a shared cache. Private-QA declarations are never persisted in Actions caches because cache namespaces are not confidentiality boundaries.
- `check-additional-boundaries` runs the complete supplemental guard list (`scripts/run-additional-boundary-checks.mts`) with four concurrent child processes and per-check timings. Its 20 checks retain individual failures, deadlines and process cleanup. The shared four-rule focused scan runs once across all source roots; the narrower public lint commands remain available. Prompt snapshots run in their separate lane. Package-boundary compile/canary work stays together, and runtime topology architecture runs separately from the gateway watch coverage embedded in `build-artifacts`.
- On the 32-vCPU self-hosted build runner, Gateway watch, channel tests, and the core support-boundary shard start together inside `build-artifacts` after `dist/` and `dist-runtime/` are already built. GitHub-hosted fallback runs keep Gateway watch serial so low-core contention cannot consume its readiness deadline. Full Node builds then verify Discord component attachment filenames through a serial public Gateway message action, checking the built revision and retaining the named-test JSON result; frozen targets that predate the case explicitly report unavailable proof. Both paths then run the two built TUI PTY artifact canaries alone.

The standalone UI suite runs three native Vitest shards through the same group
executor and cache leaf as its bounded four-file seed in the trusted warmer.
Each row retains the root Node worker limit of three; Chromium uses its project
default. The shards preserve the complete four-project inventory and each
project's isolation and cleanup policy. Every frozen target keeps its original
singleton, unsharded test command. The window.open lint runs once in row one.
The extra two jobs add two Blacksmith registrations per selected non-frozen run
on Blacksmith routes, and none on hosted routes. They do not guarantee an
eight-minute workflow: preflight, setup, queue time and other jobs still apply.
Its native reporter records runtime CPU and memory facts, configured project
workers, module diagnostics, and observed queue/end events. Browser pool logs
record actual Chromium sessions. Project counts at run start describe discovery
before sharding; completed module identities and final counts prove coverage.
Event intervals are not scheduler-admission times; repeated environment/prepare
durations must not be summed into wall time.
These receipts do not establish transform-cache hits.
Tooling stripes install Go only when their selected files include the docs
translation test; historical whole-config plans retain their existing setup.

Shell-heavy macOS signing and elevation cases admit up to three cases per file,
capped at Node's available parallelism. Independent checkout fixture tables
retain their two-case limit. Each case owns its commands and temporary roots;
cleanup joins its process tree and callback work before removing those inputs.
Outer suites and the remaining checkout contract cases stay sequential.

Once admitted, canonical Linux CI permits up to 96 concurrent Node test jobs.
The manifest separately enforces total-job budgets: 64 Node rows for canonical
pushes and 120 for canonical PRs, including precise and plugin plans. The smaller
fast/check lanes remain capped at 12; Windows is capped at two
and Android at two because those runner pools are narrower. Compact whole-config batches run
with a 120-minute batch timeout, while include-pattern groups share the same
bounded job budget.

Type-aware lint on CI runners with fewer than 8 CPUs or 24 GiB of RAM uses the
existing Go compiler memory policy (`GOGC=30`, `GOMEMLIMIT=3GiB`) to reduce swap
pressure. Explicit Go settings remain authoritative. The limit is soft and
applies only to the lint child; declaration preparation retains its own policy.

Android CI runs `testPlayDebugUnitTest` and `testThirdPartyDebugUnitTest` in separate matrix tasks. Each flavor has its own source set and `SensitiveFeatureConfig`; `apps/android/app/src/thirdParty/AndroidManifest.xml` declares additional permissions and components. The current `build-play` task assembles and lints both phone flavors and the Wear shared module, and compiles the benchmark, while `build-play-compat` retains Play-only packaging for frozen targets. GitHub-hosted `build-play` gets a 35-minute job budget for its three memory-bounded Gradle invocations; Blacksmith `build-play` and all other Android tasks retain 20 minutes. The budget follows the current attempt's runner route even when a retry reuses the original preflight matrix. Each current Gradle task has one protected sticky disk; PR jobs use disposable clones, while protected runs refresh content-addressed Gradle entries in place.

Robolectric resolves Android SDK artifacts outside Gradle's dependency cache, so every Android `test-*` task receives a workflow-owned Gradle init script that points test JVMs at a dedicated Maven-local repository. Actions cache restores are task-, platform-, and Android-contract-scoped; a prefix restore can seed a changed contract, but only a successful trusted run may publish the completed exact cache after a miss. Cold runs may download missing SDK artifacts, while warm runs reuse the exact archive. Build and lint tasks do not receive the Robolectric init script.

Remaining Blacksmith sticky-disk keys are deliberately bounded by supported task dimensions, never PR number, commit, run, branch, or dependency hash. Dependency, runtime transform, and compile caches use Actions cache instead because immutable archives expose verifiable restore/save results and avoid mutable snapshot-promotion failures. After a sticky key-version migration, add only the exact obsolete key, architecture, and region identities to `.github/retired-sticky-disks.json`, dispatch `Sticky Disk Cleanup` from `main` with the same dimensions and confirmation, verify deletion, then remove those entries. The workflow routes ARM identities to an ARM runner, rejects runner-region mismatches, uses Blacksmith's exact-key deletion action, and never deletes Docker builder caches or wildcard prefixes. Actions cache archives use normal LRU and inactivity eviction.

The `check-dependencies` shard runs Knip dependency, unused-file, and unused-export checks. Both guards enforce zero findings across production and full-tree scans, with no unused-file allowlist. The export guard also audits script entry exports. Production excludes test-support consumers; the full-tree and script scans include tests as consumers. Model intentional dynamic consumers in `config/knip.config.ts`, `config/knip.all-exports.config.ts`, or `config/knip.scripts-exports.config.ts` as appropriate. Each guard reports every scan outcome and fails if any scan fails. Historical targets run the export guard when they provide it and retain their older dead-code fallback otherwise.

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

## ClawSweeper activity forwarding

`.github/workflows/clawsweeper-dispatch.yml` is the target-side bridge from OpenClaw repository activity into ClawSweeper. It does not check out or execute untrusted pull request code. The workflow creates a GitHub App token from `CLAWSWEEPER_APP_PRIVATE_KEY`, then dispatches compact `repository_dispatch` payloads to `openclaw/clawsweeper`.

The workflow has three lanes:

- `clawsweeper_item` for exact issue and pull request review requests;
- `clawsweeper_comment` for explicit ClawSweeper commands in issue comments;
- `github_activity` for general GitHub activity that the ClawSweeper agent may inspect.

The `github_activity` lane forwards normalized metadata only: event type, action, actor, repository, item number, URL, title, state, and short excerpts for comments or reviews when present. It intentionally avoids forwarding the full webhook body. The receiving workflow in `openclaw/clawsweeper` is `.github/workflows/github-activity.yml`, which posts the normalized event to the OpenClaw Gateway hook for the ClawSweeper agent.

Main pushes remain `github_activity` observations. They do not produce hosted per-commit reports or commit Check Runs.

General activity is observation, not delivery-by-default. The ClawSweeper agent receives the Discord target in its prompt and should post to `#clawsweeper` only when the event is surprising, actionable, risky, or operationally useful. Routine opens, edits, bot churn, duplicate webhook noise, and normal review traffic should result in `NO_REPLY`.

Treat GitHub titles, comments, bodies, review text, branch names, and commit messages as untrusted data throughout this path. They are input for summarization and triage, not instructions for the workflow or agent runtime.

Barnacle treats bug-labeled issues as verification candidates rather than inactivity-close candidates. It may add the `stale` label, which dispatches one exact ClawSweeper review, but it cannot close that issue. ClawSweeper may then apply an evidence-backed resolution; a proven fix on current `main` closes as completed, while current or inconclusive bugs stay open. The stale workflow also audits recent close events and fails when a Barnacle identity closes a bug as `not_planned`.

## Manual dispatches

Ordinary manual CI dispatches run the same job graph as normal CI but force every non-Android scoped lane on: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, iOS build, and Control UI/native app i18n. Their logical runner profile is always `github`, independent of the physical fallback selected by `runs-on`. Node 22 compatibility runs in Full Release Validation and manual dispatches only; push and pull request CI skip it. The exact-head `release_gate` fallback instead keeps the pull request's macOS, iOS, and generated-native-locale scope, including conservative release screenshot capture for screenshot-pipeline owners. Automatic source PRs and release gates verify native extraction inventory and Android/Apple localization safety without requiring translated or platform-generated output in the same PR. The serialized Native App Locale Refresh workflow rebuilds those artifacts in one isolated PR and enables exact-head auto-merge after required checks pass. Full native parity remains blocking for generated-artifact PRs, generated-scope release gates, ordinary manual CI, full-scope release validation, and release prep. Control UI locale parity remains advisory on automatic PR and `main` runs and blocking on manual/release CI. Standalone manual CI dispatches run Android only with `include_android=true` (the `release_gate` input also forces Android); full-scope release validation enables Android by passing `include_android=true` without setting `release_gate`; npm qualification scopes defer Android. Plugin prerelease static checks, the full `agentic-plugins` sweep, the full extension batch sweep, and plugin prerelease Docker lanes are excluded from CI. The Docker prerelease suite runs only when `Full Release Validation` dispatches the separate `Plugin Prerelease` workflow with the release-validation gate enabled.

PR baseline ratchets derive their comparison state from the checked-out synthetic merge tree and verify its head parent against the event head. The max-lines entry chains the environment-variable budget with the same fork-point ref before the assertion-safety check, so production source growth cannot first surface on `main`. Manual runs use a unique concurrency group so a release-candidate full suite is not cancelled by another push or PR run on the same ref. The optional `target_ref` input lets a trusted caller run that graph against a branch, tag, or full commit SHA while using the workflow file from the selected dispatch ref; ratchet baselines are compared with the target's merge base against the default-branch head resolved for that run. The `release_gate` input is an exact-SHA maintainer fallback for capacity-stalled PR CI: it requires `target_ref` to be a full commit SHA that matches the dispatched branch head and `pull_request_number` to identify the open PR whose merge tree is validated. Release-gate merge-tree lint uses the same five core stripes as hosted PR CI plus one extension stripe, so no single hosted runner owns the full type-aware lint workload.

```bash
gh workflow run ci.yml --ref release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha> -f include_android=true
VALIDATION_SHA="<full-commit-sha>"
gh workflow run full-release-validation.yml --ref main \
  -f ref="$VALIDATION_SHA" \
  -f expected_sha="$VALIDATION_SHA"
```

Gateway extended-stable runs npm preflight, Full Release Validation, and plugin
npm release from `extended-stable/YYYY.M.33`; core publish consumes those three
run IDs plus the validation attempt. `release-ci/*` evidence is invalid because
publish binds every run to the canonical branch and release SHA. The tag
publishes Gateway images and only the `extended-stable*` aliases; the path skips
the regular orchestrator and its ClawHub, native-app, GitHub Release, website,
and private dist-tag surfaces. See [Monthly Gateway extended-stable
publication](/reference/RELEASING#monthly-gateway-extended-stable-publication)
for commands and recovery.

### Windows Testbox Probe

The manual `windows-testbox-probe.yml` workflow keeps Windows/WSL probing and
headless Windows CI on the selected `runner_label`. The `run_windows_ci` input
(default `false`) requests both headless CI and a separate native Scheduled Task
proof job on GitHub-hosted `windows-2025`. Neither job depends on the other, so
their results remain independently visible; either requested proof failing fails
the workflow.

For both proofs, set `target_ref` to an exact 40-character commit SHA. Both jobs
check out that target, and native proof verifies checkout equality before running
the lifecycle test. Native preflight runs before setup and requires an interactive
Windows session. A noninteractive runner fails qualification rather than silently
skipping proof. Selecting `windows-2025` does not establish native qualification:
the unchanged lifecycle assertions and cleanup must pass on the actual runner.
Cleanup and diagnostic upload still run after failure, and retained evidence is
removed only after cleanup and upload succeed.

## Runners

Runner choice follows contributor trust, not whether a pull request came from a fork. Every `runs-on` expression admits Blacksmith only when `github.event.pull_request.author_association` is `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR`, so a fork pull request from someone who has already landed a commit is routed exactly like a maintainer pull request. `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, and `MANNEQUIN` stay on GitHub-hosted runners, which are free for public repositories, so an unreviewed author cannot spend Blacksmith capacity. Maintainers report `CONTRIBUTOR` here because org membership is concealed; keep `CONTRIBUTOR` in that list or maintainer pull requests lose Blacksmith. Pushes and manual dispatches are unaffected. Cache trust is a separate, stricter boundary: exact dependency restores require a pull request from `openclaw/openclaw`, and ordinary CI never publishes the shared archives. The separate trusted warmer owns publication.

| Runner                          | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                  | `openclaw/ci-gate` in every mode, `preflight` in hybrid mode, `check-docs` in every mode (its ClawHub mirror clone is unauthenticated by design), `security-fast` outside hybrid first attempts, manual CI dispatch and non-canonical repository fallbacks, CodeQL security and quality scans, workflow-sanity, labeler, auto-response, the standalone Docs workflow, the whole Install Smoke workflow, all configurable CI jobs in `github` mode, and the remaining light lanes plus rerun Blacksmith lanes in `hybrid` mode. The GitHub/hybrid planner profile expands the Node matrix, QA Smoke to six parts, core oxlint across five Programs (three jobs on ordinary non-frozen hybrid push/PR runs), and type checks across three jobs. Extension/scripts lint plus optional UI and format checks stay in `check-lint`; the last core type batch shares `check-test-types` with the extensions/root/scripts tail. |
| `blacksmith-4vcpu-ubuntu-2404`  | `preflight` when the backend is unset or `blacksmith`, hybrid first-attempt `security-fast`, `pnpm-store-warmup`, `native-i18n`, `checks-fast-core` except QA Smoke CI, plugin/channel contract shards, most bundled/lower-weight Linux Node shards, `check-*` lanes except `check-lint`, selected `check-additional-*` shards, and `skills-python`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `blacksmith-8vcpu-ubuntu-2404`  | Retained heavy Linux Node suites, compact-small queue-tail bins 2, 5, and 8, the `checks-ui-e2e` browser-extension row, boundary/extension-heavy `check-additional-*` shards except runtime topology architecture, and `android`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-16vcpu-ubuntu-2404` | Automatic QA Smoke CI shards and first-attempt same-repo pull requests and pushes for `checks-ui-e2e-real-gateway`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `blacksmith-32vcpu-ubuntu-2404` | Eligible ordinary multi-group compact bins, numbered tooling bins, agent-support, the Docker seed job, `checks-ui-e2e` Control UI rows, `build-artifacts`, `check-lint`, `check-dependencies`, `check-test-types`, the two `check-test-types-core-*` rows, `check-additional-extension-package-boundary`, `check-additional-runtime-topology-architecture`, and npm release preflight; these CPU-heavy lanes need the measured capacity described below                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `blacksmith-8vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-6vcpu-macos-15`     | `macos-node` on `openclaw/openclaw` when the backend is unset or `blacksmith`; hybrid and existing fallback routes use `macos-15`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `blacksmith-12vcpu-macos-26`    | `macos-swift` on `openclaw/openclaw`; untrusted authors fall back to `macos-26`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The two iOS build phases and both screenshot shards always use GitHub-hosted `macos-26`. Repeated first attempts left the Blacksmith macOS jobs unassigned while other CI completed. In [run 33616182173](https://github.com/openclaw/openclaw/actions/runs/33616182173), the hosted retry assigned all three waiting Mac jobs within eight seconds; the Debug/simulator job passed in 15m31s. Starting on that verified image removes the wait-before-retry path. This moves one existing build job and two screenshot jobs off Blacksmith for eligible PRs; the additional Release phase is also hosted. The same Xcode pin, ordinary pnpm-store cache, matrix caps, and complete native evidence requirements apply.

The Node test planner marks only shards that run the real native grep fixture.
Those Linux jobs install the `ripgrep` package when the selected runner image
does not provide it. Other Node shards do not pay that setup cost.

Current targets share one checkout/setup per fast contract family. The two weighted plugin selections still run as separate `test:contracts:plugins` processes; the two channel selections still run separate `test:contracts:channels` invocations, each retaining its four owning configs, four project slots and one worker per project. The envelopes run sequentially, and any nonzero exit stops the job before another envelope is admitted. Frozen targets keep their original matrix rows and execute one envelope per row. Runner routing, caches, worker budgets and aggregate-gate selection stay unchanged. In main run `33704083233`, the separate plugin bodies totaled 94 seconds and the channel bodies 145 seconds; those sums support consolidation but are not measured combined durations.

### Blacksmith runner capacity

Npm preflight, test types, core type stripes, and runtime-topology checks request
`blacksmith-32vcpu-ubuntu-2404` to compensate for smaller delivered machines.
In the [2026-09-01 capacity probe](https://github.com/openclaw/openclaw/actions/runs/33538827388),
that label was the first measured class meeting the eight-CPU/24-GiB threshold
used by OpenClaw's parallel-check policy:

| Requested x64 Ubuntu 24.04 label | Observed CPUs | Observed RAM |
| -------------------------------- | ------------: | -----------: |
| `blacksmith-2vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-4vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-8vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-16vcpu-ubuntu-2404`  |             4 |    15.42 GiB |
| `blacksmith-32vcpu-ubuntu-2404`  |             8 |    30.95 GiB |

OS CPU count, affinity, Node, and CPU-time measurements agreed. Guest cgroup
quotas were unlimited. The provider-side reason for the mismatch is unresolved;
the table records observed capacity, not Blacksmith's advertised specifications
or a guaranteed allocation. The probe measured capacity, not whole-release
speedup or billing equivalence.

The larger requests compensate for that observed allocation. Size workers from
`nproc`/available parallelism and memory rather than the label. This promotion
preserves existing worker limits, explicit budgets, matrix sizes, and
`max-parallel`: a 32-vCPU label does not authorize 32 workers. Promoting these
existing jobs adds no runner registrations. Repeat the capacity probe and
reassess sizing after Blacksmith's allocation changes.

Backend routing still applies. Hybrid retries and untrusted pull requests retain
their hosted routes. Ordinary manual CI dispatches remain hosted in hybrid mode;
Full Release Validation's existing frozen-target lint exception remains separate.
Npm preflight uses the larger Blacksmith request by default and retains its
explicit `use_github_hosted_runners` option.

### Runner backend modes

The `macos-swift` lane builds Swift tests once and runs each test once per job. The ordinary suite retains default-profile behavior; AppState isolation tests run afterward in a separate named-profile process through the same resource-owning launcher. Each launch owns a private home and disposable, unlocked default Keychain until the test process group and output pipes close. HOME and profile markers do not isolate macOS services; both partitions run only on the disposable credentialless macOS worker. Current launcher-capable targets bound Swift Testing parallelism to the runner's logical CPU count, capped at 12, for automatic runs, manual dispatches, and rerun attempts. Only frozen targets that predate the resource owner use the serial fallback. A failing test fails the job without an in-job retry. See [native test safety](/platforms/mac/dev-setup#run-native-tests-safely).

The repository variable `OPENCLAW_CI_RUNNER_BACKEND` controls the runner backend for `ci.yml`:

| Value                 | Light lanes                                                                           | Heavy lanes                                                            | Rerun behavior                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| unset or `blacksmith` | Blacksmith-first, with the existing manual-dispatch and fork fallbacks                | Blacksmith-first, with the existing manual-dispatch and fork fallbacks | Existing behavior is unchanged                                                       |
| `github`              | GitHub-hosted                                                                         | GitHub-hosted                                                          | Every configurable job remains hosted                                                |
| `hybrid`              | Preflight stays hosted; other eligible critical-path jobs use Blacksmith on attempt 1 | Blacksmith on attempt 1; GitHub-hosted on `github.run_attempt > 1`     | Rerunning a failed or stuck Blacksmith job automatically moves it to hosted capacity |

Configurable heavy lanes are `build-artifacts`, `android`, and `macos-swift`. The iOS build and screenshot jobs always use `macos-26`. The focused `macos-node` lane uses the existing GitHub-hosted `macos-15` image in hybrid mode, with the same test inventory and two-worker limit. `openclaw/ci-gate` always uses `ubuntu-24.04`: its Bash-only result aggregation needs no checkout or dependency setup. This removes one Blacksmith registration from previously eligible runs without adding jobs or changing the required check. Hosted runner assignment can still delay completion. `preflight` uses GitHub-hosted Ubuntu in hybrid mode, with the same logical planner profile and cache trust; unset or `blacksmith` keeps its existing route. This avoids the measured first-attempt preflight queue on Blacksmith, but hosted assignment can also queue and needs native measurement. `security-fast` uses Blacksmith only on eligible hybrid first attempts and stays hosted outside `hybrid`. Security hooks use pinned installed packages and local hook definitions, so they no longer initialize remote Git repositories. Budget one control-job registration per eligible Blacksmith run or eligible hybrid first attempt; the `github` override remains unchanged. Hybrid sends the compact Node matrix, up to 80 compact rows plus separately appended plugin fallback rows, seven-row `checks-ui-e2e` matrix for non-frozen targets with the named-project contract, the `checks-ui-e2e-real-gateway` lane that shares its serial Chromium workload, four-row QA Smoke matrix on canonical automatic runs (six rows for manual dispatches), the two-part Windows matrix, `checks-ui`, `check-lint`, `check-test-types`, the two `check-test-types-core-*` rows, `check-dependencies`, `check-additional-extension-package-boundary`, `check-additional-runtime-topology-architecture`, and `report-plugin-sdk-api-diff` to Blacksmith on attempt 1. Eligible multi-group ordinary compact rows request `blacksmith-32vcpu-ubuntu-2404`. Other compact-small rows retain `blacksmith-4vcpu-ubuntu-2404`, compact-large rows retain `blacksmith-8vcpu-ubuntu-2404`, and the planner's measured small queue-tail promotions retain their 8-vCPU labels. Every other configurable `ci.yml` lane stays hosted in hybrid, including the core-lint jobs, the remaining lint/check rows, docs, and Python skills. Separate Opengrep workflows remain GitHub-hosted.

Hybrid is the normal degraded-capacity mode. If Blacksmith is down: rerun the failed or stuck heavy job; it lands on hosted automatically. During a full Blacksmith outage, record whether `OPENCLAW_CI_RUNNER_BACKEND` is set and its current value, then enable the `github` circuit breaker:

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body github
```

The `github` override also routes Full Release Validation orchestration, npm qualification, live QA, performance, package Telegram, OpenWebUI, and release runtime-pair jobs to GitHub-hosted Ubuntu. Existing explicit hosted-runner inputs remain supported. Runner placement changes; coverage, artifact identities, approvals, worker limits, and timeouts do not. Already-running jobs are not moved. Keep OpenWebUI disk requirements and performance baseline hardware differences in mind when interpreting hosted results.

Hosted `ci.yml` paths use the same setup exercised by manual dispatches and fork pull requests. Fork PRs are forced into the logical `github` planner profile even when repository variables are unavailable, so broad core lint and test-type workloads retain hosted stripes instead of falling back to oversized all-in-one jobs. Frozen targets opt into this event-aware profile through `hosted-runner-profile-contract-v1`; targets without the marker retain their historical workload shape. Blacksmith-only Docker and sticky-disk steps are skipped, dependency setup uses the ordinary Actions pnpm-store cache, and low-memory Android builds use separate Gradle processes. Hybrid attempt-1 Blacksmith Node and plateau lanes restore the exact workspace dependency archive from the trusted warmer. Eligibility uses the actual runner environment, so hosted lanes and retries stay on the ordinary store cache. The exact key includes the resolved Node patch, OS, architecture, and semantic dependency inputs; a different runner image safely misses and follows the existing store-install path. The Node toolchain itself is also cached through that API: Blacksmith's image tracks an older runner-images snapshot whose toolcache Node patches (measured 2026-08-16: 20.20.0, 22.22.0, 24.13.0) sit just under this repo's `engines` floor, so every job otherwise re-downloads Node from nodejs.org. Restores are prefix-keyed and saves carry the resolved patch, because an exact-key hit suppresses the post-job save and would pin the first payload forever once the floor advanced past it. A restored payload below the floor is rejected, pruned, and replaced. Vitest transform and Node compile caches still use the upstream Actions cache API; their Linux-only `runner.os != 'Windows'` conditions do not exclude Blacksmith labels, and the trusted warmer alone publishes each backend-local protected seed. The warmer's selected runner route determines whether that publication reaches Blacksmith's cache or GitHub's cache. Core oxlint keeps five deterministic hosted Programs with one lint thread each. Ordinary non-frozen hybrid push/PR runs pair stripes 1+2 and 3+4 sequentially, leaving stripe 5 alone, across three jobs. A failing stripe stops its row. The `github` profile, frozen targets, manual dispatches, and release gates retain five jobs; GitHub plugin stripes keep their existing owners. Plugin lint ownership is described below; script lint and optional UI and format checks stay in the existing `check-lint` row. Extension type-aware lint discovers `extensions/tsconfig.json` for plugin tests and helpers, retaining imported dependencies and shared ambient declarations without adding unrelated core/UI/package source roots. Plugin production files keep their existing package-boundary projects. Eligible test-only pull requests reuse the local changed-check selector: `check-test-types` validates the complete core graph boundary once, then compiles every graph that consumes the changed tests. Preflight omits both `check-test-types-core-*` jobs before runner allocation, and the additional-boundary lane transfers its core graph check to this required central row. Ambiguous compiler ownership or a removed test falls back to all 16 graphs in the central row. Pushes, manual and frozen targets, shared or mixed changes, and unsupported targets retain the full path. For full runs with stripe support on `github` or `hybrid`, the two `check-test-types-core-*` rows run stripes 1+2 and 3+4 sequentially, and `check-test-types` runs stripe 5 before the extensions/root/scripts tail. Targets without stripe support and the all-Blacksmith profile keep the full central path. Each core type row preserves at most two concurrent compiler children and one builder per child. Core checks retain the standalone resource policy; the remaining type commands retain their existing environment. A failed boundary or compiler stops its row before another command starts.

On hosts with less than 24 GiB RAM, serial plugin lint runs use the same eight-directory chunks as Windows. This bounds each type-aware process while covering every plugin and root source file. Outside Windows, explicit full-speed or parallel overrides keep the previous unsplit workload. The Windows chunk-size override remains Windows-only. Lint prepares only the SDK declaration tree; the separate package TypeScript boundary check still prepares the SDK and plugin declarations.

For current targets using the `github` profile, plugin lint chunks are divided deterministically across six existing jobs. Each of the five core-lint jobs runs its core Program, then its plugin chunks; `check-lint` owns the sixth stripe, script lint, and formatting. Every selected chunk retains its original arguments and runs sequentially under the existing resource and artifact-ownership limits. This removes the single-job serial tail without adding jobs or increasing chunk sizes. Hybrid, Blacksmith, release gates, and historical targets without extension-stripe support retain their existing plugin-lint ownership.

The compact Node planner keeps separate Blacksmith and standard 4-core hosted timing ownership. The `github` profile and serial `hybrid` jobs admit 210 predicted seconds per job, including shared runtime preparation. Eligible ordinary hybrid bins use the larger Blacksmith capacity policy below; file partitions, process envelopes and explicit worker pins stay intact. GitHub applies a 1.6x median scaling fallback only to unmeasured groups. Hybrid splits groups using the slower of the first-attempt Blacksmith estimate and the hosted retry estimate against the unchanged 150-second ceiling. This prevents a faster retry estimate from leaving a slow first attempt indivisible. Its attempt-1 packing applies the existing 0.87 scale to Blacksmith estimates, using committed measurements before the cold-start hints. These calibrated predictions remain separate from the recorded wrapper wall times. Refits can change the number and composition of compact jobs without changing runner policy. Direct sampled hints cover the doctor and cron-service outliers. In hybrid, the unmeasured `agentic-gateway-core-3` tail retains its 140-second fallback within the applicable serial or parallel admission budget.

The Blacksmith profile reuses the existing file partitioner for three measured serial outliers: chat/session control-plane tests, the third Gateway core group, and infrastructure storage/state tests. Their complete file inventory, config ownership, worker pins, build prerequisites and complete timing-history floors remain intact. Agent support stays one larger-runner job. On the captured 2026-09-02 inventory, these exceptions add three compact jobs while plugin consolidation removes twenty-two. The resulting broad-PR projection is 103 Node jobs; the last measured run used 121. Source inventory has changed between those observations, so actual CI must establish the final count and wall-time improvement.

Ordinary non-Windows CI targets eight minutes; Windows must still pass but sits outside this latency objective. The 210-second expanded packing budget is an estimate, not a job timeout or a measured workflow result. Preflight, checkout/setup, queueing and actual test walls all count.

Dynamic child timings bind to the configs, environment, complete parent file inventory, and ordered child allocation. Human shard names stay readable in logs; wrapper timing spans use the membership key. A parent total can be reconstructed only from every part of one matching allocation, so partial samples from different partitions cannot be combined. Every child retains its file-weighted share of the current parent estimate, and a matching child sample can raise that floor. GitHub admission uses hosted measurements; hybrid admission uses scaled Blacksmith measurements while either profile can require a wider shared split. Failed and timeout-and-retry samples are excluded from refreshes.

Whole-config groups with registered file listers (CLI processes, agent support, gateway methods, runtime config, isolated unit fast) split into file-weighted hosted stripes. CLI file weights use serial file-boundary intervals from successful main runs, so the longest process fixture is separated from the remaining files without overcounting concurrent cases. Agent support and chat also carry relative file weights to separate their slowest owners; support anchors include median case-body sums from three successful main runs. The subprocess-heavy tooling family uses sixteen file-weighted stripes based on 2,412 seconds of observed serial work in run 33364935118. Tooling file weights include import/setup time; a shared runtime prerequisite is charged once to the stripe that owns its consumers. Compact admission charges the strongest prerequisite once per job (100 seconds for runtime, 104 seconds for private QA, with the hosted scaling fallback). Mixed explicit file groups keep their runtime consumers together and stripe the remaining test work separately; the fixed build cost does not create extra stripes for files that need no build. GitHub tooling retains its packing of remaining files into the existing 150-second budget. A single packing pass applies that complete cost and the existing sibling-separation rules; no later rebalance can invalidate an admitted cap. Hosted child splits retain nonempty file partitions and recompute build ownership for each child. Indivisible files may exceed the target and retain their truthful prediction.

When agent-support membership changes, its native fallback retains 479 seconds from complete main-run spans of 478.25, 450.21, and 418.13 seconds in runs 33537556582, 33537739443, and 33543106647. The hosted fallback remains 253 seconds. Hybrid keeps that observed native fallback without applying the older whole-suite scale; matching child samples can still raise the file-weighted parent floor. This kept the measured 241-file inventory in four hybrid parts when the old 240-file generation no longer matched. On the Blacksmith profile, the whole support group requests `blacksmith-32vcpu-ubuntu-2404`; its files, process envelope and resource-derived worker limit stay unchanged.

Compact descriptor counts and predicted maxima vary with the committed measurements; the serial TUI PTY dist descriptor keeps its indivisible measured wall. In `github` mode compact jobs run hosted; hybrid attempt 1 uses each row's 4-vCPU, 8-vCPU or 32-vCPU Blacksmith label, while hybrid retries use hosted runners. For targets with the named-project contract, Control UI E2E uses six combined weighted shards on non-frozen Blacksmith and hybrid first attempts and twelve on other freshly planned runs, plus one browser-extension row. Frozen targets without the named-project contract retain the same combined Control UI command and their historical width: three shards on the Blacksmith planner profile or thirteen on hosted profiles, plus the browser-extension row. QA Smoke uses its existing four-part plan on normal canonical hybrid first attempts, removing two repeated checkouts, dependency setups and private runtime builds. Blacksmith profiles retain four parts; GitHub profiles and freshly planned hybrid retries, manual targets and runs with missing attempt metadata retain six. Failed-job-only retries preserve the original matrix width. Hybrid first attempts use Blacksmith; GitHub mode and hybrid retries use hosted runners. All scenarios, separate channel runs, concurrency limits, stagger and deadlines remain unchanged; native timings must establish the effect on completion time. QA's planner reserves the final part's observed roughly two-minute Matrix rider before greedily assigning primary scenarios, keeping that separate run from becoming the tail. Windows runs two jobs with disjoint, project-aligned explicit test lists on every backend. This partitions the complete Windows-specific inventory without applying Vitest `--shard` to project-local single-file selections, which Vitest rejects. The split width is pinned to two because `blacksmith-8vcpu-windows-2025` admits exactly two concurrent jobs (measured on run 31865243804): a third part queues behind a finished one, while a single lane serialized the whole 226-second body onto the wall and made Windows the slowest job in every run that scheduled it. The Windows cron process-identity proof uses the existing runtime prerequisite owner before starting its real Gateway; it does not require the broader E2E declaration and private-QA builds. Worker-artifact cases use independent per-test fixture lifetimes with at most two concurrent cases; the case that observes process-wide preparation logs remains sequential. The transform-cache cases share part 2 with the PowerShell installer, checkout-owner, and SDK declaration tests; the original worker suite stays in part 1. Jobs requesting the existing Blacksmith Windows class admit at most two project processes, each with one Vitest worker, after the shared runtime prerequisite completes. The requested label does not verify available CPUs or RAM; native proof must cover concurrent fixture memory and cleanup. The largest selected project starts first, using its exact recorded timing when available and the same advisory file weights as the CI planner otherwise; generated worker artifacts and per-project caches retain their existing ownership. Hosted fallbacks keep serial project execution. A hybrid retry reruns both parts on hosted `windows-2025`, slower but bounded. Expect slower individual builds on standard 4-core hosted runners. Blacksmith's runner-registration budget is irrelevant for hosted jobs, but GitHub-hosted concurrency limits apply.

Mac Node coverage uses three disjoint package-script parts on the existing runner labels. The elevation lifecycle suite owns one part; native artifact and packaging proofs own the second; checkout and the remaining platform projects own the third. The aggregate `test:macos:ci` command runs every part, and historical targets without part scripts retain one complete job. Project execution stays serial, tooling stays one file at a time, and the existing CPU-clamped three-case Mac fixture limit and two-case checkout limit are unchanged. Retained native costs place about 152 seconds of test work in the longest part, but setup and runner admission still require native measurement before claiming an eight-minute workflow.

After recovery, restore the value recorded before enabling the circuit breaker. For example, restore a previous `hybrid` setting with:

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body hybrid
```

Delete the variable only if it was previously unset; deletion selects the default Blacksmith-first routing:

```bash
gh variable delete OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw
```

`ci.yml` does not probe Blacksmith or mutate this variable. Hybrid fallback is per job and activates only when a coordinator reruns the workflow or selected failed jobs.

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

The three Mac Node parts add two hosted jobs per run on `github` and `hybrid`, with no added Blacksmith registrations there. Normal Blacksmith routing adds two registrations per qualifying attempt-1 push or trusted PR; manual runs, retries, and untrusted PRs remain hosted. The matrix concurrency cap is three. GitHub's documented Enterprise macOS concurrency allowance is 50, shared with other hosted Mac workflows; it does not guarantee immediate runner admission. No runner class or repository capacity setting changes with this split.

`Release npm Cache Warm` (`release-npm-cache-warm.yml`) runs a hosted Linux job on scheduled and manual triggers to prepare an npm download seed from the latest published OpenClaw package with lifecycle scripts disabled. Its concurrency group is separate from push-triggered Vitest warming, so newer pushes cannot cancel a pending seed. Scheduled runs publish from `main`, so new release branches can restore that seed through GitHub's default-branch cache scope. Each seed starts empty and contains only the current baseline dependency graph. Cross-OS release checks first restore their candidate-specific cache, then a matching runtime/suite cache, then this shared seed. Only npm's content-addressed `_cacache` directory is archived; install prefixes, OpenClaw state, npm logs, and executable `npx` caches remain fresh. The producer and consumers use the same relative archive path and enable cross-OS archives. npm retains normal freshness and integrity checks and downloads missing platform-specific packages. This adds one hosted Linux job per scheduled or manual warmer run, no jobs on pushes, and no Blacksmith registrations.

Small precise PR changes use a focused Node plan. Broad, deleted or unknown changes retain compact core plus the affected plugin fallback; canonical pushes use the integration compact. Every compact planner profile is capped at 80 rows, and plugin fallback packing is capped at 50. The final canonical Node matrix also enforces 64 push rows or 120 PR rows, including precise plans. Missing changed paths, missing current planner capabilities and planner errors fail preflight instead of emitting an incomplete successful matrix. Approved historical dispatches retain their full named plans. Count every emitted matrix row and nonmatrix job, including all six Android rows despite its two-job concurrency cap.

The shared plugin catch-all, QA and provider suites use native Vitest sharding, sized from the existing 90-file envelope budget. Their complete configs still own discovery and exclusions; the counting inventory never narrows execution to the directly changed plugin. At `2f7fb353`, the catch-all has 486 counting entries and 474 effective files across six jobs, QA has 238/232 across three, and providers have 275/256 across four. Counting entries include files excluded by Vitest, so the budget is conservative. Each job retains its existing worker limits, isolation policy and per-file module cleanup.

Precise and fallback plugin envelopes share the same packing owner and a 240-second aggregate estimated budget per job, including multiple envelopes of the same config. Members retain compatible runner/dist requirements and run one at a time; total cost bounds packing rather than a pair limit. Each envelope retains its original child process, environment, native shard arguments and include scope, including process-bounded Codex, Matrix and Telegram work. Runtime-preparing envelopes remain separate. Co-location preserves each original file/process bound and native shard partition; a physical job may contain several such envelopes. Workers, timeouts and serial stop-on-failure behavior stay unchanged. Costs retain the larger complete-family rate from [run 33676780376](https://github.com/openclaw/openclaw/actions/runs/33676780376) and [run 33747183683](https://github.com/openclaw/openclaw/actions/runs/33747183683), rounded up per counting file without lowering prior floors. Both cohorts used two CPUs and two workers; counting inputs include the config-owned exclusions, and runtime preparation is charged separately. Repacking the retained 78 envelopes with these rates projects 30 jobs instead of 32. The largest sum of matching observed child spans is 340.128 seconds. This is a forecast across different source revisions, not measured combined-job latency; native CI must verify elapsed time and cleanup within the eight-minute end-to-end objective.

Eligible Blacksmith and hybrid compact bins with multiple ordinary groups request the existing 32-vCPU runner and two child-process slots. They admit 360 predicted aggregate seconds; compatible small groups can fill that budget without the ten-group cutoff retained by serial jobs. Runtime consumers in ordinary bins share preparation only with other consumers, keeping no-build groups on their own capacity. Blacksmith serial jobs retain their 200/276-second budgets; hybrid serial jobs retain 210 seconds. Exclusive jobs retain 150 seconds, and groups above their existing serial cap stay alone. Exclusive groups, single groups, dist descriptors and jobs with runtime preparation remain serial. Hybrid exclusive and dist bins retain their existing prerequisite sharing. The shard executor admits at most two processes only when the actual host has at least eight available CPUs and 24 GiB of memory; smaller capacity admits one. Each overlapping child keeps two Vitest workers, inner project parallelism remains one, and commands retain their serial file policy. The primary `github` profile stays serial at 210 seconds. Preflight records the actual row count for each source revision; canonical inventory comparisons must preserve every original child plan and test input. Native elapsed-time, memory and cleanup evidence must establish the actual effect.

Failed-job-only hybrid retries retain their original matrix and its 360-second aggregate estimates when routing to hosted Ubuntu. They do not repack to 210 seconds. The existing capacity gate reduces concurrency to one on those hosts, while the retained two-slot descriptor keeps the two-worker child budget. Such retries can exceed the eight-minute normal-run objective; existing 60/120-minute job deadlines and watchdogs are unchanged. Requested runner labels do not establish actual CPU or memory capacity.

The final Node matrix admits longer estimated jobs first across compact and plugin descriptors. Plugin estimates reuse the extension batch cost owner, including existing process boundaries; runtime preparation is charged separately from the same prerequisite table used by compact jobs. Equal estimates and historical descriptors without estimates keep their original order. The 96-job concurrency ceiling bounds active jobs, while the manifest caps bound total admissions. In run `33449014227`, all 96 slots were occupied when the late QA job started; that dependency delay was matrix admission, not evidence of runner-registration throttling.

Expanded serial large/small jobs admit 210 predicted seconds; eligible hybrid parallel bins admit 360. All profiles retain the shared 80-row compact cap. The 150-second file-split and exclusive-group budgets stay unchanged. The PR-only performance lifecycle file retains its 136-second fallback from native spans of 127.288/135.808 seconds in runs 33532741896/33545657559; canonical pushes omit that tooling family. Trusted contributor forks can use the GitHub profile on Blacksmith, so every profile participates in the same registration bound. The widest current workflow profiles retain up to 86 other potential rows (14 nonmatrix and 72 matrix), or 87 for historical targets without the UI named-project contract. Normal Blacksmith and hybrid first attempts remove six UI rows; the conservative cap-based envelope still covers the wider profiles. Excluding the four unconditionally hosted iOS rows and the hosted aggregate gate gives the conservative ceiling of 82 potentially eligible rows. This includes the new Control UI performance job; keep the ceiling rather than spending savings from consolidated checks. With the final Node caps, the bounds remain 146 registrations per main run and 202 per PR. Two active main slots, both pending successors and the observed peak of 21 non-skipped PR arrivals give `4 × 146 + 21 × 202 = 4,826` registrations in five minutes. This leaves 1,174 within the 6,000 reference operating target for release work, adjacent repositories and carryover; it does not prove those arrivals fit. The earlier 19-arrival estimate is obsolete. The bounded 2026-09-02 cohort audit counted 321 unassigned Blacksmith jobs and reserved nine auxiliary rows, giving `4,826 + 321 + 9 = 5,156` planned registrations and an 844-row allowance below that reference. Its 40 exact attempts covered 4,830 jobs; queued observations spanned 21:50:48–21:57:11 UTC and were not simultaneous. Already-assigned jobs, old approval-waiting runs, unobserved retries and unlisted organization work remain outside that cohort, so this is a conditional planning bound rather than a live organization balance. Evaluate a single PR trial using its actual emitted rows separately from the rollout model. Budget all six npm qualification jobs and the relevant full-release children; a shared-token quota response or unused bucket does not establish organization-wide usage or physical runner capacity.

`checks-ui-e2e` emits seven rows for non-frozen targets with the named-project contract on Blacksmith and hybrid first attempts: six combined Control UI shards and one browser-extension row. Both use the same Blacksmith runner class. Freshly planned GitHub-profile and frozen targets with that contract retain twelve Control UI shards plus the browser row. Missing attempt metadata also retains that wider plan. Historical targets without the contract retain four total rows on the Blacksmith planner profile or fourteen on GitHub and hybrid profiles. The 2026-09-02 inventory at `49fb9c5` contains 359 files: 329 parallel bundle consumers, three parallel self-owned files, seven serial bundle consumers, and 20 serial private source/custom-build files. Ordinary CI excludes seven real-Gateway files, leaving 352. Four native projects represent resource ownership without adding jobs or execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` share group 0 with at most two workers total, then `ui-e2e-serial` and `ui-e2e-serial-standalone` share group 1 with one worker. Local throttling and explicit worker limits still apply. The shared weighted sequencer charges each file by its measured duration divided by that project's effective worker count and assigns every discovered specification once across the selected Control UI rows. The root config keeps the complete inventory visible for discovery. Serial scheduling still protects private source servers that share a Vite optimizer cache, real Gateways, and the runtime-budget measurement; test cases, deadlines, and isolation are unchanged.

Every selected project discovers Chromium. The first selected bundle-consuming project builds one private production bundle/preview and publishes its URL through Vitest's invocation-scoped root context; later consumers share it until invocation teardown. Standalone projects have no bundle setup or URL bridge, so standalone-only selections skip that build. The dedicated real-Gateway job still runs its complete canonical inventory in one Vitest invocation, including suites outside the UI source directory. Before that invocation, `OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build:ci-artifacts` builds the runtime, private QA modules, and Control UI together. This keeps same-origin build identities aligned and prevents media bootstrap from rebuilding the runtime behind the UI; use the same preparation for a local run of the complete inventory. Its six bundle consumers share the preview; MCP conformance owns a private source server. Both serial resource groups use the same single-worker phase. Enabled manual proof capture uses the shared upload directory, including the MCP and Logs suites.

Eligible `control-ui` rows request `blacksmith-32vcpu-ubuntu-2404`; the browser-extension row keeps the 8-vCPU request and the real-Gateway job keeps 16. Backend, event, contributor-trust and cache-write boundaries are unchanged, including hybrid first attempts and trusted contributor forks. In [run 33692146223](https://github.com/openclaw/openclaw/actions/runs/33692146223), the two slowest UI rows requested the 8-vCPU label but reported two CPUs; their 356/383-second test steps set the 8:20 non-Windows wall. The same run's 32-vCPU jobs reported eight CPUs. The larger request added no workers. In [run 33695337496](https://github.com/openclaw/openclaw/actions/runs/33695337496), all twelve UI rows reported eight CPUs and finished by 4:38 from workflow creation, with 102–145-second test steps. That margin supports consolidating to six rows; reduced-row timings still require native proof. Stale file weights also need the existing refit's independent-run and replacement thresholds, rather than a one-run manual adjustment.

The browser-extension row prepares only its native-host runtime JavaScript and assets through the existing `qaRuntime` build profile rather than rebuilding declarations and the Control UI. Both current widths remain inside the conservative registration bound. A failed-job-only retry of a six-shard plan retains those six shards. PR retries and hybrid push retries select hosted Ubuntu through live routing, so they may take longer; the existing 25-minute timeout is unchanged. A retry that reruns preflight selects twelve rows. Canonical push retries on the Blacksmith profile retain Blacksmith routing. The `max-parallel` ceiling stays 14 for historical targets without the named-project contract, which retain their previous width. Physical capacity must be checked separately from the registration bound.

The previous thirteen-serial-shard layout consumed 4,258 job-seconds in successful [run 33494931388](https://github.com/openclaw/openclaw/actions/runs/33494931388) on 2026-09-01, averaging 327.5 seconds per Control UI row; preflight added 39 seconds and the tail row took 363 seconds. The current projects reduce the modeled body through bounded bundled concurrency. In run `33638745824`, twelve successful first-attempt Control UI rows had median/p90 test steps of 197/235 seconds, while their checkout median reached 116.5 seconds. Reducing thirteen Control UI shards to twelve removes one repeated checkout and setup without combining the separate browser-extension work. The current target is eight minutes for normal non-Windows CI, with fewer jobs preferred over a tighter latency target. Measure queueing, checkout, setup and test work separately; the final gate still waits for Windows, which may exceed that target. The historical serial layout and the single hosted retry are not paired performance comparisons.

Canonical-repo CI keeps Blacksmith as the default runner path for pushes and first-attempt same-repo pull-request runs when the backend is unset or `blacksmith`. Hybrid keeps the heavy set plus the named critical-path plateau lanes on Blacksmith for attempt 1; other light lanes and every rerun Blacksmith lane use GitHub-hosted capacity. Pull-request retries of both UI E2E jobs use GitHub-hosted Ubuntu in every mode; push retries remain on their normal backend unless hybrid fallback applies. Manual `workflow_dispatch` and non-canonical repository runs use GitHub-hosted runners for the main test/build lanes. With an unset or `blacksmith` backend, ordinary canonical manual dispatches (`release_gate: false`) can still run the seven `check-shard` rows on their Blacksmith matrix runners; release-gate check rows remain hosted. Same-repo hybrid Full Release Validation sends only frozen-candidate lint to its matrix runner, both for exact main-ancestor SHAs without a release context and for canonical release-context candidates. These manual admissions are outside the main/PR arrival estimate above. The [`github` backend](#runner-backend-modes) provides a manual repository-wide fallback; canonical runs do not probe Blacksmith queue health or mutate the variable automatically.

## Surface ratchets

Two shrink-only budgets guard the configuration surface. Both fail CI on growth
until the budget file is consciously updated in the same PR, and both demand a
ratchet-down when cleanup lowers the real count.

- `config/env-var-count-budget.txt` caps the number of distinct `OPENCLAW_*`
  names in production source under `src/`, `packages/`, and `extensions/`
  (tests and QA Lab excluded). Checked by `node --import tsx scripts/check-env-var-count.mts`.
  Removing env vars: lower the number in the same PR. Adding one is a
  config-surface decision — justify it in the PR body.
- `docs/.generated/config-baseline.counts.json` caps the per-kind
  (core/channel/plugin) `openclaw.json` schema entry counts. Checked by
  `pnpm config:docs:check`; regenerate with `pnpm config:docs:gen` after any
  schema change.

## Local equivalents

The lint wrapper owns Go resource limits for current CI. It applies them on
hosts with fewer than eight available CPUs or less than 24 GiB of memory,
without applying lint defaults to declaration preparation. Explicit Go settings
remain inherited. Frozen revisions retain the workflow limits because their
wrappers can predate this policy.

Oxlint keeps `eslint/no-redeclare` enabled for JavaScript. For `.ts`, `.tsx`,
`.mts`, and `.cts`, `tsgo` owns declaration validity, including intentional
type/value pairs with the same public name. `eslint/no-var` remains enabled
for all source formats; the compiler does not reject every `var` redeclaration.

`eslint/no-eval` rejects direct and indirect evaluation by default. Only
`extensions/qa-lab/src/web-runtime.ts` allows indirect evaluation, because QA
scenario scripts need page-global declaration semantics that Playwright's
expression evaluation does not preserve. Direct evaluation remains an error
there. Tests that execute emitted browser scripts use isolated `node:vm`
contexts instead of process-global evaluation.

```bash
pnpm changed:lanes                            # inspect the local changed-lane classifier for origin/main...HEAD
pnpm check:changed                            # smart local check gate: changed formatting/typecheck/lint/guards by boundary lane
pnpm check                                    # fast local gate: prod tsgo + sharded lint + parallel fast guards
pnpm check:test-types
pnpm check:timed                              # same gate with per-stage timings
pnpm build:strict-smoke
pnpm check:architecture
pnpm test:gateway:watch-regression
OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts
pnpm test                                     # vitest tests
pnpm test:changed                             # cheap smart changed Vitest targets
pnpm test:ui                                  # Control UI unit/browser suite
pnpm ui:i18n:check                            # generated Control UI locale parity (release gate)
pnpm native:i18n:baseline                     # update source-owned native extraction inventory
pnpm native:i18n:verify                       # source inventory + Android/Apple localization safety
pnpm native:i18n:check                        # strict translated/platform-generated parity (release gate)
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs                               # docs format + lint + broken links
pnpm build                                    # build dist when CI artifact/smoke checks matter
pnpm ios:build                                # generate and build the iOS app project
pnpm ci:timings                               # summarize the latest origin/main push CI run
pnpm ci:timings:recent                        # compare recent successful main CI runs
pnpm ci:timings:trend                         # 72h main baseline; latest 12h versus prior 12h
node scripts/ci-run-timings.mjs <run-id>      # summarize wall time, queue time, and slowest jobs
node scripts/ci-run-timings.mjs --latest-main # ignore issue/comment noise and choose origin/main push CI
node scripts/ci-run-timings.mjs --recent 10   # compare recent successful main CI runs
node scripts/ci-run-timings.mjs --trend-hours 72 --compare-hours 12 --detail-runs 100 --output .artifacts/ci-timings/trend.json
pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json
pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json
pnpm test:startup:memory
pnpm test:extensions:memory -- --json .artifacts/openclaw-performance/source/mock-provider/extension-memory.json
pnpm perf:kova:summary --report .artifacts/kova/reports/mock-provider/report.json --output .artifacts/kova/summary.md
```

The native source gate covers catalog-owned macOS, iOS, and shared Apple source
roots. Linux-runnable source extraction requires explicit typed localized formats
(for example, `String(format: String(localized: "Expires in %lld minutes"), minutes)`
for an `Int`) instead of arbitrary Swift interpolation. Constrained inflected
count resources are supported on both platforms. Use explicit verbatim text for
user, system, or already-localized data.

## OpenClaw Performance

`OpenClaw Performance` is the product/runtime performance workflow. It runs daily on `main` and can be dispatched manually:

```bash
gh workflow run openclaw-performance.yml --ref main -f profile=diagnostic -f repeat=3
gh workflow run openclaw-performance.yml --ref main -f profile=smoke -f repeat=1 -f deep_profile=true -f live_openai_candidate=true
gh workflow run openclaw-performance.yml --ref main -f target_ref=v2026.5.2 -f profile=diagnostic -f repeat=3
```

Manual dispatch normally benchmarks the workflow ref. Set `target_ref` to benchmark a release tag or another branch with the current workflow implementation. Published report paths and latest pointers are keyed by the tested ref, and each `index.md` records the tested ref/SHA, workflow ref/SHA, Kova ref, profile, lane auth mode, model, repeat count, and scenario filters.

The workflow installs OCM from a pinned release and Kova from `openclaw/Kova` at the pinned `kova_ref` input, then runs three lanes:

- `mock-provider`: Kova diagnostic scenarios against a local-build runtime with deterministic fake OpenAI-compatible auth.
- `mock-deep-profile`: CPU/heap/trace profiling for startup, gateway, and agent-turn hotspots. Runs on schedule, or on dispatch with `deep_profile=true`.
- `live-openai-candidate`: a real OpenAI `openai/gpt-5.6-luna` agent turn. Selected on schedule, or on dispatch with `live_openai_candidate=true`. Candidates ineligible for live credentials are skipped. For a selected, eligible lane, missing `OPENAI_API_KEY` fails the lane rather than skipping it.

OpenClaw-native source probes run in the separate `source_performance` job, in parallel with the Kova lanes after `resolve_target`: gateway boot timing and memory across default, skipped-channel, internal-hook, and fifty-plugin startup cases; bundled plugin import RSS, repeated mock-OpenAI `channel-chat-baseline` hello loops, CLI startup commands against the booted gateway, and the SQLite state smoke performance probe. When the previous published mock-provider source report is available for the tested ref, the source summary compares current RSS and heap values against that baseline and marks large RSS increases as `watch`. The publisher includes these source artifacts in the `mock-provider` report bundle, with the Markdown summary at `source/index.md` and raw JSON beside it.

Every lane uploads its complete GitHub artifact, including CPU, heap, trace, and compressed diagnostic bundles. A separate publisher job downloads and validates those artifacts, then mints a short-lived ClawSweeper GitHub App token scoped only to `openclaw/clawgrit-reports` contents and passes it only to the Git push step. It commits `report.json`, `report.md`, `index.md`, source-probe artifacts, and bundle metadata/checksums under `openclaw-performance/<tested-ref>/<run-id>-<attempt>/<lane>/`; the full diagnostic archive stays in the linked Actions artifact. The publisher rejects any report file over 50 MB before attempting a push. The current tested-ref pointer is `openclaw-performance/<tested-ref>/latest-<lane>.json`. Scheduled runs and `profile=release` dispatches fail if app-token creation or report publication fails. Manual non-release dispatches keep publication advisory and retain the GitHub artifacts when authentication or publishing fails. The previous source baseline is fetched anonymously from the public reports repository, so a successful baseline fetch does not prove publisher authentication.

All explicit Performance workflow Git commands use the pinned Git lifecycle owner,
prepared in `RUNNER_TEMP` before each job's selected checkout. Target resolution,
Kova revision/install Git, source revision and baseline Git, and local publisher
operations remain unbounded. Only the initial reports fetch, each push, and each
reconciliation fetch have a 120-second deadline. The owner drains the entire Git
process tree before reads, checkout reuse, artifact consumers, outputs, or retry;
exclusive reports fetches reclaim only invocation-created locks after extinction.

Report preparation and all fetches are anonymous. The App token is created only
after a new report is prepared, removed from the environment immediately, and
passed as a masked Basic header to push commands alone; it never enters the remote
URL or repository config. A verified existing report succeeds before token creation.
Only a successful empty `ls-tree` lookup means a baseline or report is absent;
repository/read failures are terminal. Malformed baseline pointer JSON remains
advisory, as does an ordinary baseline fetch failure after verified cleanup.

Publication allows exactly five pushes. Every failed push, including the fifth,
gets a 2/4/6/8/10-second backoff followed by one anonymous reconciliation fetch.
A fetched remote report proves success even after the fifth ambiguous push; direct
push success needs no fetch. Otherwise, attempts 1–4 replay the report commit on
detached `FETCH_HEAD` with `cherry-pick -X theirs`, preserving concurrent unique
reports while the current writer wins the latest pointer. There is no fifth-attempt
replay. Ordinary fetch failures warn and retry on attempts 1–4. Only typed Git
failure or timeout after verified cleanup permits recovery; owner setup, census,
cleanup failure, and cancellation stop before fallback, retry, replay, or success.
Full Release Validation continues to disable the publisher entirely and retains
performance evidence only as workflow artifacts.

## Full Release Validation

`Full Release Validation` is the manual release umbrella. Every run binds an
exact Validation SHA + Tooling SHA tuple and rejects an `expected_sha` mismatch
before child dispatch. Validation SHA maps to the Code SHA for product
validation or the Release SHA for changelog-only validation; it is not a third
release identity. Beta-publish maps to `release_profile=beta` with
`run_release_soak=false`. A canonical beta's `all` run records `npm-beta-v1`:
it retains Node and Control UI CI, Plugin Prerelease, package/install/cross-OS
checks, and QA parity, while deferring native apps, performance, and Telegram
confidence. Broad live/E2E and QA-live remain outside that bounded gate.
Postpublish-confidence uses the exact published package with soak or explicit
focused groups. Regular stable releases use `release_profile=stable` and
`npm-stable-v1`: only native apps are deferred; stable soak, blocking performance,
Node on all three OS families, Control UI, package acceptance, and QA remain.
Both npm scopes require an exact release version and validated matching branch
or tag context. Numeric regular corrections are supported; extended-stable,
uncontextualized `main`, full profiles, and explicit `ci` groups retain full CI.

See [Full release validation](/reference/full-release-validation) for the
stage matrix, exact workflow job names, profile differences, artifacts, and
focused rerun handles.

The live/E2E selected-ref validator fetches the complete commit and ref history
with a sparse checkout. Ancestry and release-ref checks remain unchanged, while
historical file contents stay out of this metadata-only job. Build and test jobs
check out their own complete source trees.

`OpenClaw Release Publish` is the manual mutating release workflow. Dispatch
regular beta and stable publishes from a protected lightweight
`release-publish/<tooling-sha12>-<epoch>` tag at the frozen Tooling SHA after the
release tag exists and after the OpenClaw npm preflight has succeeded (the preflight runs
`pnpm plugins:sync:check` among its checks). The tag still selects the exact
release commit, including a commit on `release/YYYY.M.PATCH`; Tideclaw alpha
publishes keep using their matching alpha branch. For current validation runs,
set `preflight_run_id` and `full_release_validation_run_id` to the same successful
Full Release Validation run ID and pin `full_release_validation_run_attempt`.
The publisher resolves the independent `Full Release Artifacts` producer from
that validation manifest's sealed `publicationArtifacts.npmPreflight` descriptor.
The producer ID alone does not carry Full Release Validation authorization.
Historical recovery may still supply a separate successful `OpenClaw NPM Release`
preflight run ID alongside the matching successful Full Release Validation run
and attempt. Create the tooling tag with the [release publish commands](/reference/RELEASING#regular-release-publish-automation);
real core npm, plugin npm, or ClawHub publication from `main` is rejected before
child dispatch. Docker-only recovery may still use `main`.

The publisher dispatches `Plugin NPM Release` for all
publishable plugin packages, dispatches `Plugin ClawHub Release` for the same
release SHA, then dispatches `OpenClaw NPM Release` after plugin npm succeeds.
Stable Windows promotion is optional: supply both an exact `windows_node_tag`
and candidate-approved `windows_node_installer_digests` to dispatch its signed
installers after GitHub release finalization. Omit both to skip Windows.
For npm-stable evidence, when the tagged `apps/android/version.json` matches
the stable tag's base version, a separate native qualification job starts full
CI for the exact release SHA with Android enabled. A successful result is revalidated
after core publication before the separate Android job creates its existing
approval receipt and dispatches the tag-owned APK workflow. This keeps frozen
release tags usable without allowing narrower npm evidence to authorize an
unqualified native build. Native failure remains visible and prevents Android
approval; core npm and GitHub release finalization do not wait for it. The whole
parent can remain active after core publication while native qualification
finishes. Existing full evidence and macOS's independent validation retain their
native qualification contracts. A mismatched Android pin skips both native
qualification and APK publication, with the pin, release train, and shared
mobile cutter (`scripts/mobile-release-version.ts --prepare`) remedy recorded
in the parent summary and release proof.
Focused plugin-only repairs use `plugin_publish_scope=selected` with a nonempty
package list. Plugin-only `all-publishable` runs require the same immutable npm
preflight and Full Release Validation evidence as a core publish.

```bash
PUBLISH_REF="release-publish/<tooling-sha12>-<epoch>"
FRV_RUN_ID="<successful-full-release-validation-run-id>"
FRV_RUN_ATTEMPT="<successful-full-release-validation-run-attempt>"
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_attempt="$FRV_RUN_ATTEMPT" \
  -f npm_dist_tag=beta
```

For pinned commit proof on a fast-moving branch, use the helper instead of
`gh workflow run ... --ref main -f ref=<sha>`:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
VALIDATION_SHA="<full-release-candidate-sha>"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

GitHub workflow dispatch refs must be branches or tags, not raw commit SHAs. The
helper pushes a temporary `release-ci/<sha>-...` branch at a trusted Tooling
SHA, passes the requested Validation SHA through `ref` and `expected_sha`, reuses
strict exact-target evidence when available, and verifies every child workflow
`headSha` matches the Tooling SHA. Record that Tooling SHA once and never refresh
it from moving `main`. Regular release branches accept only their final package
version or a matching beta prerelease; Tideclaw alpha validation uses its exact
alpha tag and matching alpha branch.

`release_profile` controls live/provider breadth passed into release checks. The
manual release workflows default to `stable`; use `full` only when you
intentionally want the broad advisory provider/media matrix. Stable and full
release checks always run the exhaustive live/E2E and Docker release-path soak;
the beta profile can opt in with `run_release_soak=true`.

`fail_fast` defaults to `false`: the umbrella waits for each dispatched child
workflow and reports its independent failures together. Set `fail_fast=true`
only when cancelling a child after its first failed job is more useful than the
complete failure inventory. In Release Checks, this also enables the Matrix QA
CLI's own first-scenario cancellation.

- `beta` keeps the fastest OpenAI/core release-critical lanes.
- `stable` adds the stable provider/backend set.
- `full` runs the broad advisory provider/media matrix.

The umbrella records dispatched child run ids, and `Verify full validation`
checks them during that parent attempt. Parent cancellation or timeout leaves
adopted exact children running; cancel one explicitly when it is no longer
needed.

For recovery, classify product, harness/tooling/provenance,
infrastructure/credential, and wrapper failures before editing. Only confirmed
product failure changes the Code SHA. Use one diagnosis, one fix when needed,
and one narrow `rerun_group` retry, then reassess; never widen automatically to
`all`. Narrow evidence is not publish authorization by itself.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the selected ref once into a `release-package-under-test` tarball, then passes that artifact to cross-OS checks and Package Acceptance, plus the live/E2E release-path Docker workflow when soak coverage runs. That keeps the package bytes consistent across release boxes and avoids repacking the same candidate in multiple child jobs. For the Codex npm-plugin live lane, release checks either pass a matching published plugin spec derived from `release_package_spec`, pass the operator-supplied `codex_plugin_spec`, or leave the input blank so the Docker script packs the selected checkout's Codex plugin.

Full Release Validation concurrency is keyed by Validation SHA, Tooling SHA,
rerun group, release profile, and effective soak coverage with
`cancel-in-progress: false`. Release Checks uses the same coverage identity in
each phase, so beta, stable, and full requests do not queue behind each other.
Stable/full always include soak; setting their soak flag explicitly does not
create another concurrency group. Parent cancellation does not cancel adopted
children.

In the canonical repository's `hybrid` runner mode, target resolution, evidence
reuse, candidate discovery, candidate binding, and candidate resolution use
the small Blacksmith runner pool. These serial jobs otherwise compound hosted
runner admission delays before tests can start. Other modes and noncanonical
repositories retain GitHub-hosted runners; the reusable harness also honors
its explicit hosted-runner override. Long-running decision and diagnostic
collectors remain hosted.

## Live and E2E shards

The release live/E2E child keeps broad native `pnpm test:live` coverage, but it runs it as named shards through `scripts/test-live-shard.mjs` instead of one serial job:

- `native-live-src-agents` and `native-live-src-agents-zai-coding`
- `native-live-src-gateway-core`
- provider-filtered `native-live-src-gateway-profiles` jobs
- `native-live-src-gateway-backends`
- `native-live-src-infra`
- `native-live-test`
- `native-live-extensions-a-k`
- `native-live-extensions-l-n`
- `native-live-extensions-moonshot`
- `native-live-extensions-openai`
- `native-live-extensions-o-z-other`
- `native-live-extensions-xai`
- split media audio/video shards and provider-filtered music shards

That keeps the same file coverage while making slow live provider failures easier to rerun and diagnose. The aggregate `native-live-src-gateway`, `native-live-extensions-o-z`, `native-live-extensions-media`, and `native-live-extensions-media-music` shard names remain valid for manual one-shot reruns.

Stable/full release validation includes the configless `agent exec --auth-env-only` Code Mode smoke in `native-live-test`. The test runner builds the runtime before starting workers. The smoke copies that built distribution outside the source checkout, applies the package's plugin exclusions, and reuses installed dependencies. It supplies only `OPENAI_API_KEY` to a fresh CLI environment, runs `openai/gpt-5.6-sol` without a runtime override, and verifies Code Mode engagement, nested tool calls, and an exact read-to-write artifact. This proves built-distribution behavior; Package Acceptance owns tarball installation proof. The shard requires passing evidence from this test; a missing key or skipped test cannot satisfy the release gate.

Gateway-profile shards and shards containing the image-tool provider or OpenAI plugin live tests prepare the `sourcePerformance` build profile before starting Vitest. This supplies executable provider and agent runtime artifacts without building declarations or the Control UI. Provider requests, assertions, and test deadlines remain unchanged; gateway diagnostic environment settings apply only to gateway-profile shards. Cold source-plugin Jiti import cost remains a separate performance follow-up, not live provider latency.

Stable/full release runs explicitly enable OpenAI AgentSession repeated compaction in `native-live-src-agents` with `OPENCLAW_LIVE_OPENAI_COMPACTION=1` and `OPENCLAW_LIVE_OPENAI_COMPACTION_FULL=0`. This uses the bounded 48k context profile and requires multiple compactions plus durable-marker recall. Manual shard runs retain the explicit opt-in; once enabled, a skipped compaction test fails the shard's pass-evidence gate. The separate 922k full-context stress profile remains a manual opt-in.

The native live media shards run in `ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, built by the `Live Media Runner Image` workflow. That image preinstalls `ffmpeg` and `ffprobe`; media jobs only verify the binaries before setup. Keep Docker-backed live suites on normal Blacksmith runners — container jobs are the wrong place to launch nested Docker tests.

Docker-backed live model/backend shards use a separate shared `ghcr.io/openclaw/openclaw-live-test:<sha>-<extensions>` image per selected commit. The live release workflow builds and pushes that image once, then the Docker live model, provider-sharded gateway, CLI backend, ACP bind, and Codex harness shards run with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Gateway Docker shards carry explicit script-level `timeout` caps below the workflow job timeout so a stuck container or cleanup path fails fast instead of consuming the whole release-check budget. If those shards rebuild the full source Docker target independently, the release run is misconfigured and will waste wall clock on duplicate image builds.

## Package Acceptance

Use `Package Acceptance` when the question is "does this installable OpenClaw package work as a product?" It is different from normal CI: normal CI validates the source tree, while package acceptance validates a single tarball through the same Docker E2E harness users exercise after install or update.

### Jobs

1. `resolve_package` checks out `workflow_ref`, resolves one package candidate, writes `.artifacts/docker-e2e-package/openclaw-current.tgz`, writes `.artifacts/docker-e2e-package/package-candidate.json`, uploads both as the `package-under-test` artifact, and prints the source, workflow ref, package ref, version, SHA-256, and profile in the GitHub step summary.
2. `package_integrity` downloads the `package-under-test` artifact and enforces the public package tarball contract with `scripts/check-openclaw-package-tarball.mjs`.
3. `npm_12_install_sh` installs that exact artifact through the public Linux installer under npm 12 in an isolated home/prefix, then verifies the CLI version and lifecycle-completion guard.
4. `docker_acceptance` calls `openclaw-live-and-e2e-checks-reusable.yml` with the resolved package source SHA (falling back to `workflow_ref`) and `package_artifact_name=package-under-test`. The reusable workflow downloads that artifact, validates the tarball inventory, prepares package-digest Docker images when needed, and runs the selected Docker lanes against that package instead of packing the workflow checkout. When a profile selects multiple targeted `docker_lanes`, the reusable workflow prepares the package and shared images once, then fans those lanes out as parallel targeted Docker jobs with unique artifacts.
5. `package_telegram` optionally calls `NPM Telegram Beta E2E`. It runs when `telegram_mode` is not `none` and installs the same `package-under-test` artifact when Package Acceptance resolved one; standalone Telegram dispatch can still install a published npm spec.
6. `summary` fails the workflow if package resolution, integrity, npm 12 installer acceptance, Docker acceptance, or the optional Telegram lane failed. The `advisory` input downgrades acceptance failures to warnings for advisory callers.

### Candidate sources

- `source=npm` accepts only `openclaw@extended-stable`, `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release version such as `openclaw@2026.4.27-beta.2`. Use this for published extended-stable, prerelease, or stable acceptance.
- `source=ref` packs a trusted `package_ref` branch, tag, or full commit SHA. The resolver fetches OpenClaw branches/tags, verifies the selected commit is reachable from repository branch history or a release tag, installs deps in a detached worktree, and packs it with `scripts/package-openclaw-for-docker.mjs`.
- `source=url` downloads a public HTTPS `.tgz`; `package_sha256` is required. This path rejects URL credentials, non-default HTTPS ports, private/internal/special-use hostnames or resolved IPs, and redirects outside the same public safety policy.
- `source=trusted-url` downloads an HTTPS `.tgz` from a named trusted-source policy in `.github/package-trusted-sources.json`; `package_sha256` and `trusted_source_id` are required. Use this only for maintainer-owned enterprise mirrors or private package repositories that need configured hosts, ports, path prefixes, redirect hosts, or private-network resolution. If the policy declares bearer auth, the workflow uses the fixed `OPENCLAW_TRUSTED_PACKAGE_TOKEN` secret; URL-embedded credentials are still rejected.
- `source=artifact` downloads one `.tgz` from `artifact_run_id` and `artifact_name`; `package_sha256` is optional but should be supplied for externally shared artifacts.

Keep `workflow_ref` and `package_ref` separate. `workflow_ref` is the trusted workflow/harness code that runs the test. `package_ref` is the source commit that gets packed when `source=ref`. This lets the current test harness validate older trusted source commits without running old workflow logic.

### Suite profiles

- `smoke` — `npm-onboard-channel-agent`, `gateway-network`, `config-reload`
- `package` — `npm-onboard-channel-agent`, `doctor-switch`, `update-channel-switch`, `skill-install`, `update-corrupt-plugin`, `upgrade-survivor`, `published-upgrade-survivor`, `root-managed-vps-upgrade`, `update-restart-auth`, `plugins-offline`, `plugin-update`
- `product` — the `package` set with live `plugins` coverage instead of `plugins-offline`, plus `mcp-channels`, `cron-mcp-cleanup`, `openai-web-search-minimal`, `openwebui`
- `full` — full Docker release-path chunks with OpenWebUI
- `custom` — exact `docker_lanes`; required when `suite_profile=custom`

The `package` profile uses offline plugin coverage so published-package validation is not gated on live ClawHub availability. The optional Telegram lane reuses the `package-under-test` artifact in `NPM Telegram Beta E2E`, with the published npm spec path kept for standalone dispatches.

For the dedicated update and plugin testing policy, including local commands,
Docker lanes, Package Acceptance inputs, release defaults, and failure triage,
see [Testing updates and plugins](/help/testing-updates-plugins).

Release checks call Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, `docker_lanes='doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape'`, and `telegram_mode=mock-openai`. This keeps package migration, update, live ClawHub skill install, stale-plugin-dependency cleanup, configured-plugin install repair, offline plugin, plugin-update, and Telegram proof on the same resolved package tarball. Set `release_package_spec` on Full Release Validation or OpenClaw Release Checks after publishing a beta to run the same matrix against the shipped npm package without rebuilding; set `package_acceptance_package_spec` only when Package Acceptance needs a different package from the rest of release validation. Cross-OS release checks still cover OS-specific onboarding, installer, and platform behavior; package/update product validation should start with Package Acceptance.

The `published-upgrade-survivor` Docker lane validates one published package baseline per run in the blocking release path. In Package Acceptance, the resolved `package-under-test` tarball is always the candidate and `published_upgrade_survivor_baseline` selects the fallback published baseline, defaulting to `openclaw@latest`; failed-lane rerun commands preserve that baseline. Full Release Validation with `run_release_soak=true` or `release_profile=full` keeps the latest stable baseline, resolved once to an exact npm package before fanout, and sets `published_upgrade_survivor_scenarios=reported-issues` to exercise every issue-shaped fixture for Feishu config, preserved bootstrap/persona files, configured OpenClaw plugin installs, tilde log paths, and stale legacy plugin dependency roots. Expanded published-upgrade survivor and update-migration selections are split by baseline into groups of at most three scenarios, with at most 32 targeted Docker jobs active per matrix. Grouping shares the execution planner’s baseline-compatibility policy, so every supported scenario runs exactly once without creating empty shards for old baselines. Each scenario still owns a fresh container and the unchanged npm resource limit; package and image identities remain shared across the matrix. The separate `Update Migration` workflow defaults to that same latest stable baseline and the `plugin-deps-cleanup` scenario. Pass `baselines=all-since-2026.4.23` for exhaustive historical cleanup; `last-stable-4`, `release-history`, and exact historical versions also remain explicit manual selections. Local aggregate runs can pass exact package specs with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, keep a single lane with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC` such as `openclaw@2026.4.15`, or set `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` for the scenario matrix. The published lane configures the baseline with a baked `openclaw config set` command recipe, records recipe steps in `summary.json`, and probes `/healthz`, `/readyz`, plus RPC status after Gateway start. The Windows packaged and installer fresh lanes also verify that an installed package can import a browser-control override from a raw absolute Windows path. The OpenAI cross-OS agent-turn smoke defaults to `OPENCLAW_CROSS_OS_OPENAI_MODEL` when set, otherwise `openai/gpt-5.6-luna`, so the install and gateway proof uses the lower-cost GPT-5.6 test tier.

### Legacy compatibility windows

Package Acceptance has bounded legacy-compatibility windows for already-published packages. Packages through `2026.4.25`, including `2026.4.25-beta.*`, may use the compatibility path:

- known private QA entries in `dist/postinstall-inventory.json` may point at tarball-omitted files;
- `doctor-switch` may skip the `gateway install --wrapper` persistence subcase when the package does not expose that flag;
- `update-channel-switch` may prune missing pnpm `patchedDependencies` from the tarball-derived fake git fixture and may log missing persisted `update.channel`;
- plugin smokes may read legacy install-record locations or accept missing marketplace install-record persistence;
- `plugin-update` may allow config metadata migration while still requiring the install record and no-reinstall behavior to stay unchanged.

The published `2026.4.26` package may also warn for local build metadata stamp files that were already shipped. Current package validators require both npm lockfile formats to be absent from new tarballs.

### Examples

```bash
# Validate the current beta package with product-level coverage.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f telegram_mode=mock-openai

# Validate the published extended-stable package with package coverage.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@extended-stable \
  -f suite_profile=package \
  -f telegram_mode=mock-openai

# Pack and validate a release branch with the current harness.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=release/YYYY.M.PATCH \
  -f suite_profile=package \
  -f telegram_mode=mock-openai

# Validate a tarball URL. SHA-256 is mandatory for source=url.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=url \
  -f package_url=https://example.com/openclaw-current.tgz \
  -f package_sha256=<64-char-sha256> \
  -f suite_profile=smoke

# Validate a tarball from a named trusted private mirror policy.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=trusted-url \
  -f trusted_source_id=enterprise-artifactory \
  -f package_url=https://packages.example.internal:8443/artifactory/openclaw/openclaw-current.tgz \
  -f package_sha256=<64-char-sha256> \
  -f suite_profile=smoke

# Reuse a tarball uploaded by another Actions run.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=artifact \
  -f artifact_run_id=<run-id> \
  -f artifact_name=package-under-test \
  -f suite_profile=custom \
  -f docker_lanes='install-e2e plugin-update'
```

When debugging a failed package acceptance run, start at the `resolve_package` summary to confirm the package source, version, and SHA-256. Then inspect the `docker_acceptance` child run and its Docker artifacts: `.artifacts/docker-tests/**/summary.json`, `failures.json`, lane logs, phase timings, and rerun commands. Prefer rerunning the failed package profile or exact Docker lanes instead of rerunning full release validation.

## Install smoke

The `Install Smoke` workflow no longer runs on pull requests or `main` pushes. Its nightly/manual wrapper and release validation both call the read-only `install-smoke-reusable.yml` core, and every run takes the full install-smoke path on GitHub-hosted runners:

- The root Dockerfile smoke image is built once per target SHA, bound to the workflow revision and producer attempt in an immutable artifact, then loaded by the CLI smoke, agents delete shared-workspace CLI smoke, container gateway-network E2E, and bundled `matrix` plugin build-arg smoke. The plugin smoke verifies runtime dependency install mirroring and that the plugin loads without entry-escape diagnostics.
- QR package install and the installer/update Docker smokes (including Rocky Linux installer lanes and an update lane against a configurable `update_baseline_version` npm baseline) run as separate jobs so installer work does not wait behind the root image smokes.

The slow Bun global install and runtime smoke is separately gated by `run_bun_global_install_smoke`. It installs the candidate with trusted lifecycle scripts, then verifies representative CLI, local-agent, and Gateway paths under Bun 1.4 or newer. It runs on the nightly schedule, defaults on for workflow calls from release checks, and manual `Install Smoke` dispatches can opt into it. Normal PR CI still runs the fast Bun launcher regression lane for Node-relevant changes. QR and installer Docker tests keep their own install-focused Dockerfiles.

## Local Docker E2E

`pnpm test:docker:all` prebuilds one shared live-test image, packs OpenClaw once as an npm tarball, and builds two shared `scripts/e2e/Dockerfile` images:

- a bare Node/Git runner for installer/update/plugin-dependency lanes;
- a functional image that installs the same tarball into `/app` for normal functionality lanes.

Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mts`, planner logic lives in `scripts/lib/docker-e2e-plan.mts`, and the runner only executes the selected plan. The scheduler selects the image per lane with `OPENCLAW_DOCKER_E2E_BARE_IMAGE` and `OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`, then runs lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Live lanes that use these package images do not require the separate source live-test image; model/backend lanes that consume the source image still prepare it.

### Tunables

| Variable                               | Default | Purpose                                                                                       |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `OPENCLAW_DOCKER_ALL_PARALLELISM`      | 10      | Main-pool slot count for normal lanes.                                                        |
| `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM` | 10      | Provider-sensitive tail-pool slot count.                                                      |
| `OPENCLAW_DOCKER_ALL_LIVE_LIMIT`       | 9       | Concurrent live lane cap so providers do not throttle.                                        |
| `OPENCLAW_DOCKER_ALL_NPM_LIMIT`        | 5       | Concurrent npm install lane cap.                                                              |
| `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT`    | 7       | Concurrent multi-service lane cap.                                                            |
| `OPENCLAW_DOCKER_ALL_START_STAGGER_MS` | 2000    | Stagger between lane starts to avoid Docker daemon create storms; set `0` for no stagger.     |
| `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`  | 7200000 | Per-lane fallback timeout (120 minutes); selected live/tail lanes use tighter caps.           |
| `OPENCLAW_DOCKER_ALL_DRY_RUN`          | unset   | `1` prints the scheduler plan without running lanes.                                          |
| `OPENCLAW_DOCKER_ALL_LANES`            | unset   | Comma-separated exact lane list; skips cleanup smoke so agents can reproduce one failed lane. |

A lane heavier than its effective cap can still start from an empty pool, then runs alone until it releases capacity. The local aggregate preflights Docker, removes stale OpenClaw E2E containers, emits active-lane status, persists lane timings for longest-first ordering, and stops scheduling new pooled lanes after the first failure by default.

### Reusable live/E2E workflow

Repository E2E runs as nine independent jobs: four duration-weighted Gateway shards, four
duration-weighted Control UI shards, and the standalone agent-plugin Gateway
test. Two independent producers build the selected source once per profile:
the full private-QA build for Gateway package/type checks, and the CI artifact
build for UI and agent-plugin tests. Consumers restore exact producer artifacts,
including generated plugin assets and local build metadata, and install their
own Chromium and sandbox prerequisites. Each group has four test slots, so long
UI shards start together without waiting for Gateway declarations or tests.
A failed producer blocks its own consumers; other diagnostics continue.
Gateway shards retain the existing
four fresh-process boundaries and two-worker limit. Each UI shard runs its
bundled files with up to two workers, then its private-server, real-Gateway, and
runtime-budget files serially. The root sequencer assigns files across both
projects to the same four weighted shards. No tests are filtered out, and the
existing 90-minute job deadline is unchanged. Local `pnpm test:e2e` still runs
its suite commands sequentially; each UI command uses the same project policy.

This removes seven builds per invocation and raises peak test concurrency from
six to eight. Release checks use GitHub-hosted runners, so this adds no
Blacksmith registrations there. A standalone Blacksmith invocation can register
eleven runners: two producers and nine test jobs. Producer artifact identities
survive consumer-only retries; consumers never select an artifact by their own
current attempt number.

The reusable live/E2E workflow asks `scripts/test-docker-all.mjs --plan-json` which package, image kind, live image, lane, and credential coverage is required. `scripts/docker-e2e.mjs` then converts that plan into GitHub outputs and summaries. It either packs OpenClaw through `scripts/package-openclaw-for-docker.mjs`, downloads a current-run package artifact, or downloads a package artifact from `package_artifact_run_id`, then validates the tarball inventory. The default `no-push-artifact` path builds package-digest-tagged bare/functional images through Blacksmith's Docker layer cache, packs the exact image bytes into an immutable workflow artifact, and has each consumer verify and load that artifact. `existing-only` instead requires explicit `docker_e2e_bare_image`/`docker_e2e_functional_image` GHCR refs and never builds or pushes. Those registry pulls use a bounded 180-second per-attempt timeout so a stuck stream retries quickly instead of consuming most of the CI critical path. After successful scheduled validation, `openclaw-scheduled-live-checks.yml` passes the immutable tested-image manifest to the separate package-write publisher; read-only release and prerelease callers never traverse that writer.

### Release-path chunks

Release Docker coverage runs smaller chunked jobs with `OPENCLAW_SKIP_DOCKER_BUILD=1` so each chunk verifies and loads only the artifact-backed image kind it needs (or pulls it under explicit `existing-only` reuse) and executes multiple lanes through the same weighted scheduler:

- `OPENCLAW_DOCKER_ALL_PROFILE=release-path`
- `OPENCLAW_DOCKER_ALL_CHUNK=core | package-update-openai | package-update-onboarding | package-update-migrations | package-update-self-upgrade | plugins-runtime-plugins | plugins-runtime-services | plugins-runtime-install-a..h | openwebui`

Current release Docker chunks are `core`, `package-update-openai`, `package-update-onboarding`, `package-update-migrations`, `package-update-self-upgrade`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`. `package-update-openai` includes the live Codex plugin package lane, which installs the candidate OpenClaw package, installs the Codex plugin from `codex_plugin_spec` or a same-ref tarball with explicit Codex CLI install approval, runs Codex CLI preflight and same-session agent turns, then runs a zero-retry medium-thinking turn that sends progress, reads randomized workspace inputs, writes their exact artifact, and sends completion. `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes.

Provider-neutral package checks run in three balanced rows: onboarding and install switching, channel/published migrations, and self-upgrades. This avoids serializing eight npm-heavy lanes behind one runner's npm resource limit. The aggregate `package-update-core` and `package-update` names remain available for manual runs. The `package-update-openai` row also runs root-managed VPS upgrade and authenticated update restart proof. Scheduler resource limits remain unchanged. Credential preflight failures remain blocking while the following diagnostic pool drains non-live lanes; earlier setup failures and cancellation still prevent execution.

OpenWebUI runs as a standalone `openwebui` chunk on a dedicated large-disk Blacksmith runner whenever stable or full release-path coverage requests it, even when the reusable workflow routes supported jobs to GitHub-hosted runners. Keeping the external image pull separate prevents the large image from competing with the shared package and plugin images in `plugins-runtime-services`; legacy aggregate plugin/runtime chunks still include OpenWebUI for compatible manual reruns. Bundled-channel update lanes retry once for transient npm network failures.

Each chunk uploads `.artifacts/docker-tests/` with lane logs, timings, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, slow-lane tables, and per-lane rerun commands. The workflow `docker_lanes` input runs selected lanes against images prepared for that run instead of the chunk jobs, which keeps failed-lane debugging bounded to one targeted Docker job; if a selected lane is a live Docker lane, the targeted job builds the live-test image locally for that rerun. The rerun helper validates the failure artifact's exact selected target SHA and manual dispatch repacks that ref, because the internal reusable-workflow package tuple is not part of the `workflow_dispatch` schema. Generated commands include prepared image inputs and `shared_image_policy=existing-only` only when those inputs are GHCR-backed; runner-local artifact tags are omitted so a fresh runner rebuilds them. An explicit target override drops recovered GHCR image refs unless the artifact proves they match the override. Artifact-generated workflow-definition refs are also omitted because full-release temporary branches are deleted; dispatch uses the repository default branch unless the operator explicitly overrides it.

```bash
pnpm test:docker:rerun <run-id>      # download Docker artifacts and print combined/per-lane targeted rerun commands
pnpm test:docker:timings <summary>   # slow-lane and phase critical-path summaries
```

The scheduled live/E2E workflow runs the full release-path Docker suite daily and, after it succeeds, invokes the explicit publisher for the exact tested image artifacts.

## Plugin Prerelease

`Plugin Prerelease` is more expensive product/package coverage, so it is a separate workflow dispatched by `Full Release Validation` or by an explicit operator. Normal pull requests, `main` pushes, and standalone manual CI dispatches keep that suite off. It balances non-Telegram bundled plugin tests across eight generic extension workers; those jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap. Telegram runs in dedicated shards of at most ten test files, preserving one-file Vitest processes while scheduling two processes concurrently. The combined extension matrix is capped at 12 concurrent jobs. The release-only Docker prerelease path (enabled by the `full_release_validation` input) batches targeted Docker lanes in groups of four to avoid reserving dozens of runners for one-to-three-minute jobs. The workflow also uploads an informational `plugin-inspector-advisory` artifact from `@openclaw/plugin-inspector`; inspector findings are triage input and do not change the blocking Plugin Prerelease gate.

## QA Lab

QA Lab has dedicated CI lanes outside the main smart-scoped workflow. Agentic parity is nested under the broad QA and release harnesses, not a standalone PR workflow. Use `Full Release Validation` with `rerun_group=qa-parity` when parity should ride with a broad validation run.

- The `QA-Lab - All Lanes` workflow runs nightly on `main` and on manual dispatch; it fans out mock parity plus live Matrix, Telegram, Discord, WhatsApp, and Slack jobs. Live jobs use the `qa-live-shared` environment; Telegram, Discord, WhatsApp, and Slack use Convex leases, while Matrix provisions disposable local credentials.
- Manual and scheduled aggregate runs retain the default `all` concurrency scope. Trusted release calls use separate `matrix` and `buzz` scopes so those lanes can run together for one target SHA; Matrix calls for the same SHA still serialize, while Buzz calls serialize across SHAs because they share pooled credentials.
- Release Matrix catalog validation runs on a 16-vCPU Blacksmith runner with a 90-minute job budget. Changes to that timeout, runner size, or concurrency require a matching workflow guard and exact-candidate release proof.
- `QA Profile Evidence` balances taxonomy category groups across eight isolated jobs, keeps non-isolating live channels on one shard, then asks QA Lab to merge their validated evidence into one attested `qa-evidence.json`. A timed-out or missing shard always fails aggregation; `allow_failures` applies only when every shard completed and produced valid evidence. Direct `Maturity scorecard` dispatches default `allow_failures` on so routine docs refreshes can publish accurate incomplete coverage, while reusable release calls remain strict by default.

Scheduled, manual, and release Matrix checks use the deterministic mock provider so the live transport contract is isolated from model latency and normal provider-plugin startup. Telegram release checks use the same deterministic model boundary. The live transport gateway disables memory search because QA parity covers memory behavior separately; provider connectivity is covered by the separate live model, native provider, and Docker provider suites.

`OpenClaw Release Checks` also runs the release-critical QA Lab lanes before release approval; its QA parity gate runs the candidate and baseline packs as parallel lane jobs, then downloads both artifacts into a small report job for the final parity comparison.

For normal PRs, follow scoped CI/check evidence instead of treating parity as a required status.

## CodeQL

The `CodeQL` workflow is intentionally a narrow first-pass security scanner, not the full repository sweep. Daily, manual, `main` push, and non-draft pull request guard runs scan Actions workflow code plus the highest-risk JavaScript/TypeScript surfaces with high-confidence security queries filtered to high/critical `security-severity`.

The pull request guard stays light: it only starts for changes under `.github/actions`, `.github/codeql`, `.github/workflows`, `packages`, `scripts`, `src`, or process-owning bundled plugin runtime paths, and it runs the same high-confidence security matrix as the scheduled workflow. Android and macOS CodeQL stay out of PR defaults.

### Security categories

| Category                                          | Surface                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/codeql-security-high/core-auth-secrets`         | Auth, secrets, sandbox, cron, and gateway baseline                                                                                  |
| `/codeql-security-high/channel-runtime-boundary`  | Core channel implementation contracts plus the channel plugin runtime, gateway, Plugin SDK, secrets, audit touchpoints              |
| `/codeql-security-high/network-ssrf-boundary`     | Core SSRF, IP parsing, network guard, web-fetch, and Plugin SDK SSRF policy surfaces                                                |
| `/codeql-security-high/mcp-process-tool-boundary` | MCP servers, process execution helpers, outbound delivery, and agent tool-execution gates                                           |
| `/codeql-security-high/process-exec-boundary`     | Local shell, process spawn helpers, subprocess-owning bundled plugin runtimes, and workflow script glue                             |
| `/codeql-security-high/plugin-trust-boundary`     | Plugin install, loader, manifest, registry, package-manager install, source-loading, and Plugin SDK package contract trust surfaces |

### Platform-specific security shards

- `CodeQL Android Critical Security` — scheduled Android security shard. Builds the Android app manually for CodeQL on the smallest Blacksmith Linux runner accepted by workflow sanity. Uploads under `/codeql-critical-security/android`.
- `CodeQL macOS Critical Security` — weekly/manual macOS security shard. Builds the macOS app manually for CodeQL on Blacksmith macOS, filters dependency build results out of uploaded SARIF, and uploads under `/codeql-critical-security/macos`. Kept outside daily defaults because macOS build dominates runtime even when clean.

### Critical Quality categories

`CodeQL Critical Quality` is the matching non-security shard. It runs only error-severity, non-security JavaScript/TypeScript quality queries over narrow high-value surfaces on GitHub-hosted Linux runners so quality scans do not spend Blacksmith runner-registration budget. Its pull request guard is intentionally smaller than the scheduled profile: non-draft PRs run only the matching shards for the surfaces they touch, from thirteen PR-routable shards — `agent-runtime-boundary`, `channel-runtime-boundary`, `config-boundary`, `core-auth-secrets`, `gateway-runtime-boundary`, `mcp-process-runtime-boundary`, `memory-runtime-boundary`, `network-runtime-boundary`, `plugin-boundary`, `plugin-sdk-package-contract`, `plugin-sdk-reply-runtime`, `provider-runtime-boundary`, and `session-diagnostics-boundary`. `ui-control-plane` and `web-media-runtime-boundary` stay out of PR runs. CodeQL config and quality workflow changes run the full PR shard set (the network runtime shard keys off its own CodeQL config files and network-owning source paths).

Manual dispatch accepts:

```text
profile=all|agent-runtime-boundary|config-boundary|core-auth-secrets|channel-runtime-boundary|gateway-runtime-boundary|memory-runtime-boundary|mcp-process-runtime-boundary|network-runtime-boundary|plugin-boundary|plugin-sdk-package-contract|plugin-sdk-reply-runtime|provider-runtime-boundary|session-diagnostics-boundary
```

The narrow profiles are teaching/iteration hooks for running one quality shard in isolation.

On pull requests, the network runtime shard starts with a fast diff scan. Sensitive
socket imports/calls and proxy-policy tokens, edits to its queries/config/fixtures, and
changes to the Codex transport select full CodeQL analysis in the same PR job.
Absent or null patches for monitored non-test sources also select full analysis;
metadata fetch or parse failures stop shard selection rather than silently skipping it.
Known ordinary diffs keep the fast path. The full path runs semantic query tests before
analysis, including coverage of the configured `packages/net-policy/src` directory
and preservation of exact owner/function allowances and test-path exclusions.
Full analysis fails the job on any SARIF finding or missing SARIF output; a
sensitive diff is a routing signal, not a finding.

| Category                                                | Surface                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/codeql-critical-quality/core-auth-secrets`            | Auth, secrets, sandbox, cron, and gateway security boundary code                                                                                                  |
| `/codeql-critical-quality/config-boundary`              | Config schema, migration, normalization, and IO contracts                                                                                                         |
| `/codeql-critical-quality/gateway-runtime-boundary`     | Gateway protocol schemas and server method contracts                                                                                                              |
| `/codeql-critical-quality/channel-runtime-boundary`     | Core channel and bundled channel plugin implementation contracts                                                                                                  |
| `/codeql-critical-quality/agent-runtime-boundary`       | Command execution, model/provider dispatch, auto-reply dispatch and queues, and ACP control-plane runtime contracts                                               |
| `/codeql-critical-quality/mcp-process-runtime-boundary` | MCP servers and tool bridges, process supervision helpers, and outbound delivery contracts                                                                        |
| `/codeql-critical-quality/memory-runtime-boundary`      | Memory host SDK, memory runtime facades, memory Plugin SDK aliases, memory runtime activation glue, and memory doctor commands                                    |
| `/codeql-critical-quality/network-runtime-boundary`     | Network policy package, raw socket and proxy-capture runtime, SSH tunnel, gateway lock, JSONL socket, and push transport surfaces                                 |
| `/codeql-critical-quality/session-diagnostics-boundary` | Reply queue internals, session delivery queues, outbound session binding/delivery helpers, diagnostic event/log bundle surfaces, and session doctor CLI contracts |
| `/codeql-critical-quality/plugin-sdk-reply-runtime`     | Plugin SDK inbound reply dispatch, reply payload/chunking/runtime helpers, channel reply options, delivery queues, and session/thread binding helpers             |
| `/codeql-critical-quality/provider-runtime-boundary`    | Model catalog normalization, provider auth and discovery, provider runtime registration, provider defaults/catalogs, and web/search/fetch/embedding registries    |
| `/codeql-critical-quality/ui-control-plane`             | Control UI bootstrap, local persistence, gateway control flows, and task control-plane runtime contracts                                                          |
| `/codeql-critical-quality/web-media-runtime-boundary`   | Core web fetch/search, media IO, media understanding, image-generation, and media-generation runtime contracts                                                    |
| `/codeql-critical-quality/plugin-boundary`              | Loader, registry, public-surface, and Plugin SDK entrypoint contracts                                                                                             |
| `/codeql-critical-quality/plugin-sdk-package-contract`  | Published package-side Plugin SDK source and plugin package contract helpers                                                                                      |

Quality stays separate from security so quality findings can be scheduled, measured, disabled, or expanded without obscuring security signal. Swift, Python, and bundled-plugin CodeQL expansion should be added back as scoped or sharded follow-up work only after the narrow profiles have stable runtime and signal.

## Maintenance workflows

### Dependency Audit

`Dependency Audit` runs the production lockfile audit daily at 07:23 UTC and on
manual dispatch. It stays separate from PR CI and fails on findings, unavailable
advisories, or invalid data. Each dependency graph is submitted as one request;
release checks keep their product and tooling graphs separate.

Both ordinary CI and this strict audit publish the outcome, package count,
duration, timestamp, and bounded failure reason in the job summary. A completed
npm check covers npm bulk advisories only, not every upstream advisory source.

The triage owner is **@steipete**. Investigate failed scheduled runs and rerun
the strict workflow to confirm recovery:

```bash
gh workflow run dependency-audit.yml --repo openclaw/openclaw --ref main
```

GitHub sends scheduled-run notifications to the workflow creator or the latest
cron editor, subject to that account's Actions notification settings. Keep those
notifications enabled when taking ownership; a summary mention does not send an
alert. See [GitHub's workflow notification rules](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).

For local reproduction, run
`node scripts/pre-commit/pnpm-audit-prod.mjs --audit-level=high`. Adding `--ci`
selects a shorter 30-second diagnostic budget but preserves exit codes: 0 means
no matching findings, 1 means findings or an error, and 2 means incomplete coverage.
Ordinary CI, scheduled audits, and local hooks propagate every non-zero exit.

### Docs Agent

The `Docs Agent` workflow is an event-driven Codex maintenance lane for keeping existing docs aligned with recently landed changes. It has no pure schedule: a successful non-bot push CI run on `main` can trigger it, and manual dispatch can run it directly. Workflow-run invocations skip when `main` has moved on or when another eligible Docs Agent workflow-run invocation was created in the last hour. Canceled and skipped workflow conclusions are excluded from both hourly cadence and review-base selection; active runs with no conclusion still count. When admitted, the agent reviews the commit range from the previous eligible invocation's source SHA to current `main`.

History eligibility tracks workflow attempts, not completed docs reviews: a gate-rejected attempt that finishes successfully remains eligible history.

### Duplicate PRs After Merge

The `Duplicate PRs After Merge` workflow is a manual maintainer workflow for post-land duplicate cleanup. It defaults to dry-run and only closes explicitly listed PRs when `apply=true`. Before mutating GitHub, it verifies that the landed PR is merged and that each duplicate has either a shared referenced issue or overlapping changed hunks.

```bash
gh workflow run duplicate-after-merge.yml \
  -f landed_pr=70532 \
  -f duplicate_prs='70530,70592' \
  -f apply=true
```

## Local check gates and changed routing

### Config baseline count ratchet

`pnpm config:docs:check` rejects undocumented config-surface growth and corrupt or stale count snapshots. When a reviewed product change intentionally adds schema paths, run `pnpm config:docs:gen`, inspect the core/channel/plugin count deltas and generated SHA-256 files, and commit the conscious baseline bump with the schema, help, labels, migration, and tests. Do not hand-edit the counts file to bypass the ratchet.

Config authors must also tier new leaves for Settings. Add `advanced: false` or
`advanced: true` at the leaf, or place the key beneath an ancestor whose tier
all descendants should inherit. Unclassified roots fail the schema quality
test with copy-paste stubs; paths without an ancestor are advanced by default.
The curated common-leaf snapshot makes intentional tier changes visible in
review.

Local changed-lane logic lives in `scripts/changed-lanes.mjs` and is executed by `scripts/check-changed.mjs`. That local check gate is stricter about architecture boundaries than the broad CI platform scope:

- core production changes run core prod and core test typecheck plus core lint/guards;
- core test-only changes run only core test typecheck plus core lint;
- root TypeScript tests and support files run root test typecheck plus targeted type-aware lint within `test/tsconfig/tsconfig.test.root.json`; the discoverable `test/tsconfig.json` inherits that source-only program. It includes `.ts`, `.tsx`, `.d.mts`, and `.d.cts`, not ordinary `.mts`/`.cts`; fixtures and built-artifact Docker clients stay outside targeted root lint;
- extension production changes run extension prod and extension test typecheck plus extension lint;
- extension test-only changes run extension test typecheck plus extension lint;
- bundled channel manifests, package metadata, config schemas, UI hints, and generator owners also run the bundled channel config metadata drift check;
- config schema/help, bundled plugin metadata, relative-import dependencies of source schema entries, generator/selector owners, and tracked config baseline changes run `pnpm config:docs:check`, including baseline files mixed with ordinary docs; all-lane and release metadata plans include it once;
- public Plugin SDK or plugin-contract changes expand to extension typecheck because extensions depend on those core contracts (Vitest extension sweeps stay explicit test work);
- release metadata-only version bumps run targeted version/config/root-dependency checks;
- unknown root/config changes fail safe to all check lanes.

Schema dependency selection reuses the local relative-import graph, including re-exports and deleted leaf paths still referenced by surviving source. Shared SDK channel UI-hint and secret-input schema owners, plus the workspace sensitive-URL hint owner, are explicit roots across alias boundaries. Edits to their SDK facades are also selected without traversing unrelated facade runtime dependencies. This is not universal alias or computed-import resolution.

Local changed-test routing lives in `scripts/test-projects.test-support.mts` and is intentionally cheaper than `check:changed`: direct test edits run themselves, source edits prefer explicit mappings, then sibling tests and import-graph dependents. Shared group-room delivery config is one of the explicit mappings: changes to the group visible-reply config, source reply delivery mode, or the message-tool system prompt route through the core reply tests plus Discord and Slack delivery regressions so a shared default change fails before the first PR push. Use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when the change is harness-wide enough that the cheap mapped set is not a trustworthy proxy.

## Testbox validation

Crabbox is the repo-owned remote-box wrapper for maintainer Linux proof. Agent
sessions run trusted development tests, changed gates, typecheck/lint, and
builds locally by default. They use Crabbox when the environment is part of the
proof: clean-machine, install/package, Docker, E2E, live, desktop, cross-OS, or
CI-parity work, or when the operator explicitly requests remote proof. Crabbox
is not generic compute offload. `.crabbox.yaml` defaults remote proof to
`blacksmith-testbox`. Its configured workflow hydrates provider and agent
credentials, so untrusted contributor or fork code must use secretless fork CI
or sanitized direct AWS Crabbox instead.
The check workflow hydrates its pinned dispatch commit with a depth-1 checkout;
the changed gate later reconstructs the exact merge base and synced final tree.
Sanitized AWS runs set `CRABBOX_ENV_ALLOW=CI`, pass
`--no-hydrate`, and use a fresh temporary remote `HOME`; this prevents the repo
`OPENCLAW_*` allowlist and existing auth profiles from reaching untrusted code.
They use a newly warmed lease dedicated to that untrusted source, never a
trusted or previously hydrated lease. Launch an installed trusted Crabbox
binary from a clean trusted `main` checkout and fetch only the remote PR with
`--fresh-pr`; never execute the untrusted checkout's wrapper or config locally.
Unset `CRABBOX_AWS_INSTANCE_PROFILE` and fail closed unless resolved
`aws.instanceProfile` is empty. Before any install/test, use trusted
absolute-path tools to require an IMDSv2 token, prove the IAM credentials
endpoint returns 404, and compare remote `git rev-parse HEAD` to the full
reviewed PR head SHA. Bind the lease to that SHA and stop/rewarm on head change.
Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean `main`
alongside `--fresh-pr`; it installs pinned Node/pnpm, verifies the SHA and
package-manager pin, isolates `HOME`, installs dependencies, then executes the
requested test.
Unset all `CRABBOX_TAILSCALE*` overrides, force `--network public
--tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to
report public networking with no Tailscale state before uploading any script.
Owned AWS/Hetzner capacity also remains the fallback for Blacksmith outages,
quota issues, or explicit owned-capacity testing.

For an explicitly authorized admin-only PR landing fallback, set
`OPENCLAW_PR_GATES_REMOTE=crabbox-aws` before `scripts/pr prepare-gates`.
The mode does not replace the default hosted aggregate gate. After the exact
prep head is pushed, the wrapper synchronously dispatches the protected-main
publisher. That trusted workflow checksum-installs Crabbox v0.46, resolves its
service principal through `/v1/whoami`, then runs sanitized brokered AWS with
`umask 022`, the canonical untrusted bootstrap, `pnpm build`, `pnpm check`, and
a fail-closed PR-derived test plan. The existing changed-test owner evaluates
every executable changed path independently and must resolve each one to
concrete matched test files; broad fallback, skipped paths, config targets,
deleted executable paths, and partial plans are refused. Explicit docs and
`AGENTS.md`/`CLAUDE.md` instruction surfaces may produce a zero-test plan.
The exact PR base SHA, head SHA, bootstrap hash, and deterministic plan digest
are bound into the broker command. The AWS lease uses a 90-minute idle timeout
and 240-minute TTL. The `pr-crabbox-gate-publisher.yml` workflow accepts an open draft
because proof runs during prepare-push, then rereads the live same-repository
PR and the exact active organization-admin membership object using the repo-native
GitHub App token with `Members(read)` (the repository-scoped workflow token is
not treated as org authority), validates its newly created authenticated broker
run under the same service token, ordered complete events, canonical command
and bootstrap upload hash, and
publishes the distinct `openclaw/crabbox-gate` only for the exact proven
base/head/plan binding. The publisher also proves that the PR base is the merge
base of its immutable protected-main workflow SHA and adds that workflow SHA to
the strict check summary. Before and after the remote run, it proves that a
candidate live `main` is identical to or descended from that workflow SHA, then
rereads the ref and requires the candidate to remain unchanged. A descendant
advance during the long remote run is allowed; movement inside either
comparison-and-reread window fails closed.
Retained broker logs are validated when non-empty but are optional because
released Crabbox v0.46 can report zero retained log bytes after a successful
run. Only after the publisher and exact-head check succeed does the local
wrapper derive `.local/gates.env` provider/run/lease/URL recovery metadata from
the trusted summary; those fields are not publication authority.

The fallback never replaces or republishes `openclaw/ci-gate`. Native merge
verification still rejects draft PRs and permits the server ruleset bypass only
when the Crabbox check is
completed successfully by GitHub Actions on the prepared SHA, its bound workflow
SHA is an ancestor of a stable final live protected-main snapshot, the authenticated
actor is still an active organization admin, and the sole unsatisfied required
check is the normal CI gate with a recognized hosted-runner infrastructure
failure represented by GitHub-owned job metadata with no executed workflow
steps and no assigned `runner_name`. Job logs are never authority because PR
code controls their text. Missing or mismatched checks, cancellation,
action-required or stale conclusions, an assigned runner, any failed or executed
workflow step, unknown runner backends, pending contexts, and additional
required-check failures remain blocking. Only workflow `startup_failure` or an
unacquired zero-step hosted job with `failure`/`timed_out` qualifies. The native
flow repeats the full bypass verification immediately before the admin squash
request and pins the prepared head with `--match-head-commit`. GitHub exposes
no expected-base-OID merge precondition, so the final main read minimizes but
cannot atomically eliminate a base movement race. Landing proof must compare
the squash parent with that final main snapshot, not the older workflow SHA.
The Crabbox merge path stores this comparison in
`.local/merge-crabbox-parent-audit.json`, includes it in the completion comment,
and reports any intervening main movement after the already-completed merge
without claiming atomic prevention.

Agents do not pre-warm for anticipated work. Acquire a Testbox lazily when the
first environment-sensitive command is ready, reuse the returned `tbx_...` id
for later remote commands, sync the current checkout on every run, and stop it
before handoff.

Crabbox-backed Blacksmith runs warm, claim, sync, run, report, and clean up
one-shot Testboxes. Native Blacksmith owns synchronization; Crabbox's direct
SSH sync controls and mass-deletion sanity checks do not run on this delegated
path.

Crabbox also terminates a local Blacksmith CLI invocation that stays in the
sync phase for more than five minutes without post-sync output. Set
`CRABBOX_BLACKSMITH_SYNC_TIMEOUT_MS=0` to disable that guard, or use a larger
millisecond value for unusually large local diffs.

Before a first run, check the wrapper from the repo root:

```bash
node scripts/crabbox-wrapper.mjs run --help | sed -n '1,120p'
```

The repo wrapper validates the selected Crabbox binary and provider before running. In Codex worktrees or linked/sparse checkouts, avoid the local `pnpm crabbox:run` script because pnpm may reconcile dependencies before Crabbox starts; invoke the node wrapper directly instead:

```bash
node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --timing-json --shell -- "pnpm test <path-or-filter>"
```

When using the sibling checkout, rebuild the ignored local binary before timing or proof work:

```bash
version="$(git -C ../crabbox describe --tags --always --dirty | sed 's/^v//')" \
  && go build -C ../crabbox -trimpath -ldflags "-s -w -X github.com/openclaw/crabbox/internal/cli.version=${version}" -o bin/crabbox ./cmd/crabbox
```

The `blacksmith:` block in `.crabbox.yaml` already pins the org, workflow, job, and ref defaults, so the explicit flags below are optional. Explicit clean-machine changed-gate parity:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --blacksmith-org openclaw \
  --blacksmith-workflow .github/workflows/ci-check-testbox.yml \
  --blacksmith-job check \
  --blacksmith-ref main \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm check:changed"
```

Focused test rerun when clean-machine behavior is part of the proof:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm test <path-or-filter>"
```

Full suite on an explicitly requested clean machine:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm test"
```

Read the final JSON summary. The useful fields are `provider`, `leaseId`,
`syncDelegated`, `exitCode`, `commandMs`, and `totalMs`. For delegated
Blacksmith Testbox runs, the Crabbox wrapper exit code and JSON summary are the
command result. The linked GitHub Actions run owns hydration and keepalive; it
can finish as `cancelled` when the Testbox is stopped externally after the SSH
command has already returned. Treat that as a cleanup/status artifact unless
the wrapper `exitCode` is non-zero or the command output shows a failed test.
One-shot Blacksmith-backed Crabbox runs should stop the Testbox automatically;
if a run is interrupted or cleanup is unclear, inspect live boxes and stop only
the boxes you created:

```bash
blacksmith testbox list --all
blacksmith testbox status --id <tbx_id>
blacksmith testbox stop --id <tbx_id>
```

Use reuse only when you intentionally need multiple commands on the same hydrated box:

```bash
node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --id <tbx_id> --timing-json --shell -- "corepack pnpm test <path-or-filter>"
pnpm crabbox:stop -- <tbx_id>
```

Reuse the lease, not stale source. Blacksmith Testbox owns sync, including
reused `--id` runs. Do not pass `--no-sync`: the wrapper rejects it before
lease handling or delegation. A fingerprint cache hit is not a no-sync guarantee.

Sync success is not proof of source identity. Verify the materialized Git tree
before exact-candidate proof. Keep QA evidence outside the synced checkout and
download it before another run. Do not bypass security exclusions, accept a
mismatched tree, or silently switch providers.

Untrusted contributor/fork code must use
`CRABBOX_ENV_ALLOW=CI`, `--provider aws --no-hydrate`, and a fresh
temporary remote `HOME` for every command; install dependencies inside that
sanitized command before testing. Reuse only a newly warmed lease dedicated to
the same untrusted source; never a trusted or previously hydrated lease. Never
execute the untrusted checkout's wrapper or config locally: launch the installed
trusted Crabbox binary from clean trusted `main` and pass `--fresh-pr` on every
run. Keep `CRABBOX_AWS_INSTANCE_PROFILE` unset, reject a non-empty resolved
instance profile, require a trusted remote IMDS no-role proof, and verify the
reviewed head SHA before install/test. Bind the lease to that SHA; stop and
rewarm after any head change. If no remote PR exists, use secretless fork CI.
Never select `hydrate-github` or the credential-hydrated Blacksmith workflow
for untrusted source.

If Crabbox is the broken layer but Blacksmith itself works, use direct
Blacksmith only for diagnostics such as `list`, `status`, and cleanup. Fix the
Crabbox path before treating a direct Blacksmith run as maintainer proof.

If `blacksmith testbox list --all` and `blacksmith testbox status` work but new
warmups sit `queued` with no IP or Actions run URL after a couple of minutes,
treat it as Blacksmith provider, queue, billing, or org-limit pressure. Stop the
queued ids you created, avoid starting more Testboxes, and move the proof to the
owned Crabbox capacity path below while someone checks the Blacksmith dashboard,
billing, and org limits.

Escalate to owned Crabbox capacity only when Blacksmith is down, quota-limited, missing the needed environment, or owned capacity is explicitly the goal:

```bash
CRABBOX_CAPACITY_REGIONS=eu-west-1,eu-west-2,eu-central-1,us-east-1,us-west-2 \
  pnpm crabbox:warmup -- --provider aws --class standard --market on-demand --idle-timeout 90m
pnpm crabbox:hydrate -- --provider aws --id <cbx_id-or-slug>
pnpm crabbox:run -- --provider aws --id <cbx_id-or-slug> --timing-json --shell -- "pnpm check:changed"
pnpm crabbox:stop -- --provider aws <cbx_id-or-slug>
```

Under AWS pressure, avoid `class=beast` unless the task really needs 48xlarge-class CPU. A `beast` request starts at 192 vCPUs and is the easiest way to trip regional EC2 Spot or On-Demand Standard quota. The repo-owned `.crabbox.yaml` defaults to `class: standard`, on-demand market, and `capacity.hints: true` so brokered AWS leases print selected region/market, quota pressure, Spot fallback, and high-pressure class warnings. Use `fast` for heavier broad checks, `large` only after standard/fast are not enough, and `beast` only for exceptional CPU-bound lanes such as full-suite or all-plugin Docker matrices, explicit release/blocker validation, or high-core performance profiling. Do not use `beast` for `pnpm check:changed`, focused tests, docs-only work, ordinary lint/typecheck, small E2E repros, or Blacksmith outage triage. Use `--market on-demand` for capacity diagnosis so Spot market churn is not mixed into the signal.

`.crabbox.yaml` owns provider, sync, and GitHub Actions hydration defaults. Crabbox sync never transfers `.git`, so the hydrated Actions checkout keeps its own remote Git metadata instead of syncing maintainer-local remotes and object stores, and the repo config additionally excludes local runtime/build artifacts (such as `.artifacts` and test reports) that should never be transferred. `.github/workflows/crabbox-hydrate.yml` owns checkout, Node/pnpm setup, `origin/main` fetch, and the non-secret environment handoff for owned-cloud `crabbox run --id <cbx_id>` commands.

## Related

- [Install overview](/install)
- [Development channels](/install/development-channels)
