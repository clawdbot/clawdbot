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
heads, and manual dispatches use isolated groups. `preflight` classifies the
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

| Job                                | Purpose                                                                                                                                                                                                                                                                                                  | When it runs                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `preflight`                        | Detect changed scopes and build the CI manifest; on canonical Node-relevant `main` and same-repo PRs, publish or restore the exact dependency cache before fanout                                                                                                                                        | Always on non-draft pushes and PRs                     |
| `security-fast`                    | Private key detection, changed-workflow audit via `zizmor`, and production lockfile audit                                                                                                                                                                                                                | Always on non-draft pushes and PRs                     |
| `pnpm-store-warmup`                | Warm the lockfile-pinned Actions cache for fork PRs, manual runs, and same-repo docs-only PRs                                                                                                                                                                                                            | Node or docs-check lanes without an exact-cache writer |
| `build-artifacts`                  | Build `dist/`, Control UI, built-CLI smoke checks, startup memory, and embedded built-artifact checks                                                                                                                                                                                                    | Node-relevant changes                                  |
| `control-ui-i18n`                  | Verify generated Control UI locale bundles, metadata, and translation memory; advisory on automatic runs, blocking on manual release CI                                                                                                                                                                  | Control UI i18n-relevant changes and manual CI         |
| `checks-fast-core`                 | Fast Linux correctness lanes: environment-variable, max-lines, and assertion-safety baseline ratchets, bundled + protocol, Bun launcher, and the CI-routing fast task                                                                                                                                    | Node-relevant changes                                  |
| `qa-smoke-ci-profile`              | Self-contained balanced parts of the automatic QA Smoke coverage set; one private-overlay build per part (the smoke set has no docker-lane or Control UI scenarios; the run step fails closed if one returns)                                                                                            | Pushes and manual runs; PRs only on QA-owned surfaces  |
| `checks-fast-contracts-plugins-*`  | Two weighted plugin contract shards                                                                                                                                                                                                                                                                      | Node-relevant changes                                  |
| `checks-fast-contracts-channels-*` | Two weighted channel contract shards                                                                                                                                                                                                                                                                     | Node-relevant changes                                  |
| `checks-node-*`                    | Changed-target Node tests on pull requests; compact integration shards on `main`; metadata-complete compact fallback on broad PRs; full named shards on manual and release runs                                                                                                                          | Node-relevant changes                                  |
| `docker-seed-e2e`                  | One Docker scheduler job for the executable `mcp-channels`, `cron-mcp-cleanup`, `mcp-code-mode-gateway`, and `update-channel-switch` owner lanes                                                                                                                                                         | PR changes to their E2E helpers or CI gate owners      |
| `check-*`                          | Sharded main local gate equivalent: guards, transient npm-lock validation, bundled-channel config metadata, prod types, lint, dependencies, test types                                                                                                                                                   | Node-relevant changes                                  |
| `check-additional-*`               | Boundary check stripes (including prompt snapshot drift), session accessor/transcript reader/SQLite transaction boundaries, extension lint groups, package boundary compile/canary, and runtime topology architecture; the pure-reporting plugin SDK API diff runs on manual and release dispatches only | Node-relevant changes                                  |
| `checks-node-compat-node22`        | Node 22 compatibility build and smoke lane                                                                                                                                                                                                                                                               | Full Release Validation and manual dispatches only     |
| `check-docs`                       | Docs formatting, lint, and broken-link checks                                                                                                                                                                                                                                                            | Docs changed (PRs and manual dispatch)                 |
| `native-i18n`                      | Verify native source extraction and localization safety on source PRs and release gates; enforce generated parity on generated PRs, generated-scope release gates, and ordinary manual CI                                                                                                                | Native i18n-relevant changes                           |
| `skills-python`                    | Ruff + pytest for Python-backed skills                                                                                                                                                                                                                                                                   | Python-skill-relevant changes                          |
| `checks-windows`                   | Windows-specific process/path tests plus shared runtime import specifier regressions                                                                                                                                                                                                                     | Windows-relevant changes                               |
| `macos-node`                       | Focused macOS TypeScript tests: launchd, Homebrew, runtime paths, packaging scripts, process-group wrapper                                                                                                                                                                                               | macOS-relevant changes                                 |
| `macos-swift`                      | Swift lint and build for the macOS app, plus tests for the app and shared OpenClawKit package                                                                                                                                                                                                            | macOS-relevant changes                                 |
| `ios-build`                        | Swift lint, Debug and Release builds, and focused simulator lifecycle tests                                                                                                                                                                                                                              | iOS/capture changes                                    |
| `ios-screenshot-shard`             | Two device-family shards using the locked Ruby/Fastlane bundle: iPhone plus Watch in one job, and 13-inch iPad in the other; scenarios stay serial within each device                                                                                                                                    | Screenshot-risk changes and manual CI                  |
| `ios-screenshot-evidence`          | Hosted reducer that verifies exact artifact/family topology, digests, every OpenClaw-managed capture-attempt outcome (including failed invocations without an xcresult), and run provenance before publishing the canonical release screenshot artifact                                                  | After both screenshot shards                           |
| `android`                          | Android unit tests for both flavors plus one debug APK build                                                                                                                                                                                                                                             | Android-relevant changes                               |
| `openclaw/ci-gate`                 | Final aggregate: requires preflight and security; accepts skips only for manifest-disabled downstream lanes                                                                                                                                                                                              | Every non-draft CI run                                 |
| `openclaw-performance`             | Separate workflow: daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.6 live lanes                                                                                                                                                                             | Scheduled and manual dispatch                          |

The rare path-triggered `docker-seed-e2e` job selects only the executable
owners of changed E2E helpers and runs them through one scheduler invocation.
Trusted same-repository pull requests use one 16-vCPU Blacksmith runner with
main and tail parallelism set to 3; GitHub-hosted, fork, and retry paths run the
same selected lanes serially. The job is part of `openclaw/ci-gate`. It adds at
most one runner registration during an affected pull-request window and adds no
registrations for unrelated pull requests.

Standalone Periphery workflows enforce zero dead-code findings for the iOS and macOS apps. The shared OpenClawKit workflow scans both consumers in parallel and reports a declaration only when Periphery emits the same Swift USR from both builds. Its generated `OpenClawProtocol/GatewayModels.swift` schema contract is retained as generator-owned code rather than treated as app-local dead code.

All four scans use `scripts/install-periphery.sh` to install the checksum-pinned Periphery 3.8.0 OSS release, including its adjacent `libIndexStore.dylib`, in a dedicated runner-temporary directory. The installer rejects download, checksum, and version failures without falling back to Homebrew. Installer changes select all three native workflows.

[Upstream archived the OSS project](https://github.com/peripheryapp/periphery/commit/56a0eb6fb97b785c8fbc1044ccbc7b5d9f06ebec). The pin is a maintainer-owned bridge for the workflows' Xcode 26.6 toolchain, not a claim of ongoing upstream support. Native CI maintainers must revalidate both app scans and both shared consumers before changing Xcode, the pinned release, or the analyzer; retain the zero-findings policy and exact-USR intersection rather than adding a baseline or a weaker fallback.

## Fail-fast order

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs. Canonical `main` starts immediately in one of two parity slots; each slot admits one complete run and coalesces later pushes into its newest pending tip. On Node-relevant canonical `main` pushes and same-repository pull requests, preflight is the sole exact dependency-cache writer; downstream jobs wait for it, then restore the immutable archive or fall back to the ordinary pnpm-store cache on a miss.
2. `security-fast`, `check-*`, `check-additional-*`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
3. `build-artifacts` and the locale checks overlap with the fast Linux lanes. Control UI and native app source PRs exclude generated locale snapshots/resources; their serialized refresh workflows repair and auto-merge isolated generated PRs in the background. Source CI still blocks stale source inventories and unsafe localization calls. Generated PRs, manual CI, and release prep enforce full translated/platform-generated parity. Canonical `release/YYYY.M.PATCH` branches may include release-prep locale repairs with the other generated release output.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-plugins-*`, `checks-fast-contracts-channels-*`, `checks-node-*`, `checks-windows`, `macos-node`, `macos-swift`, `ios-build`, the screenshot shards, and `android`.
5. `openclaw/ci-gate` waits for every selected lane. Preflight and security must succeed; downstream jobs may skip only when the manifest did not select them. A failed or canceled selected lane fails the aggregate.

The merge coordinator may reuse an authenticated successful `openclaw/ci-gate`
for the same pull-request head for up to 24 hours. This avoids rewriting a
contributor branch after unrelated `main` changes. The reusable result does not
replace the separate strict, App-owned test-merge check against current `main`.
A later pending or failed rerun does not erase an earlier successful result for
that unchanged head during the freshness window.

The default-branch ruleset requires the GitHub Actions-owned `openclaw/ci-gate` check. Repository maintainers and admins have an audited break-glass bypass intended only for signed direct fast-forward landings; the organization ruleset still blocks deletion and non-fast-forward updates. Normal pull-request merges should continue to use the gate rather than bypass failed CI. The separate strict App-owned test-merge check still binds the head to current `main`.

GitHub may mark superseded pull-request jobs as `cancelled` when a newer head lands. Treat that as CI noise unless the newest run for the same PR is also failing. Canonical `main` runs are not canceled after admission; each of the two parity slots replaces only its older pending run with the newest tip. Matrix jobs use `fail-fast: false`, and `build-artifacts` reports embedded channel, core-support-boundary, and gateway-watch failures directly instead of queuing tiny verifier jobs. The canonical-main CI concurrency key is versioned (`CI-v8-*`) so GitHub-side zombies in the old group cannot block the two-slot pipeline; other automatic groups remain on `CI-v7-*`. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs. The plugin-list startup-memory guard keeps a 400 MiB ceiling on self-hosted Blacksmith Linux and allows 425 MiB on GitHub-hosted Linux, whose RSS baseline is higher for the same built CLI. The startup-memory check finishes alone before other built-artifact checks start on every runner, so concurrent verifiers do not perturb the RSS measurement. The Doctor plugin-index proof and singleton smoke then share the selected artifact-check wave on Blacksmith; hosted 4-core runners serialize those two verifiers first. That wave step is unconditional because the verifiers always run, while each artifact check keeps its own selection gate.

Use `pnpm ci:timings`, `pnpm ci:timings:recent`, or `node scripts/ci-run-timings.mjs <run-id>` to summarize wall time, start delay, slowest jobs, failures, and the `pnpm-store-warmup` fanout barrier from GitHub Actions. Use `pnpm ci:timings:trend` for a 72-hour baseline and a latest-12-hours versus prior-12-hours comparison. Trend mode includes every main push outcome, cancellation/pass rates, and successful-run wall time, then loads a balanced latest/prior sample of at most 100 successful runs by default. Its detailed sample separates workflow admission, job dependency/gate delay (`job.created_at` minus the first job's creation), runner queue/start latency (`job.started_at` minus `job.created_at`), and execution; it also reports critical-path ownership and the actual GitHub API request count. Reruns use attempt-specific jobs and are excluded from run-level wall/admission distributions because GitHub retains the original workflow creation time. Raise or lower the detailed-run selection cap with `--detail-runs` (a run with more than 100 jobs requires multiple requests), emit JSON to stdout with `--json`, or save the same report with `--output .artifacts/ci-timings/trend.json`; missing output directories are created automatically. The baseline must cover at least two comparison windows.

Run the timing helper locally; there is no in-workflow timing-summary job (a permanently disabled one was removed once the local helper became the tool everyone actually used). For build timing, check the `build-artifacts` job's `Build dist` step: `pnpm build:ci-artifacts` prints `[build-all] phase timings:` and includes `ui:build`; the job also uploads the `startup-memory` artifact.

Node test shards that need a built CLI use the same `build:ci-artifacts` profile
before starting Vitest. It builds the runtime, Control UI, and scoped plugin SDK
declarations without repeating global declaration emission in each shard.
Private QA shards retain their private runtime build selection. Release package
builds still generate the full declarations.

Local `pnpm build:ci-artifacts` uses the same memory admission as full and package
builds. The orchestrator passes the resolved heap budget to every child process,
including the SDK declaration writer, so local builds do not depend on CI's
`NODE_OPTIONS` setting. The existing policy accounts for host and cgroup limits
and reserves native-memory headroom. If the default budget cannot fit the build,
it stops before build steps or cache restoration; `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB`
remains the explicit operator override for attempting a different budget.

## Watching pull request CI

From a source checkout with an authenticated `gh` CLI, wait for one exact
pull-request head:

```bash
node scripts/watch-pr-ci.mjs <pr-number> <full-head-sha>
```

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
For missing CI, follow the verifier's `scripts/pr ci-dispatch <pr-number>` recovery
guidance when available. Malformed required-check evidence and cancelled required
checks also stop verification. Server-enforced publisher binding and the final
pinned-head merge request remain intact. Hosted mode adds no bypass.

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

The shared Linux Node checkout (`linux_node_checkout_step`) and shared Windows/macOS/iOS checkout (`platform_checkout_step`) use one process owner for every Git command within those anchors. Linux allows five whole-checkout attempts, clearing the workspace before each attempt, with 120-second candidate and trusted workflow-harness fetch deadlines and an increasing five-second backoff. Windows, macOS, and iOS retain 90-second fetch deadlines, three candidate fetch attempts on timeout only, five-second backoff, and one harness fetch attempt. Candidate and harness revisions remain separately pinned; Linux also fetches the optional ratchet base at depth one.

The sole maintained owner is `.github/actions/git-owner/owner.py`. `pnpm ci:git-owner:gen` projects it into the one pre-checkout Python heredoc in `ci.yml`; `pnpm ci:git-owner:check`, workflow checks, and the Git boundary test lane reject drift. The standalone composite action copies its own trusted bytes into a unique runner temporary directory and publishes `owner-path` and `CI_GIT_OWNER`. Neither bootstrap loads an owner from the selected candidate. Both use isolated Python (`-I -S`) and only its standard library, without a Git or network bootstrap.

Timeout, cancellation, and leader exit drain the owned POSIX process group or Windows Job Object before workspace deletion, another Git command, or step completion. Cleanup has a ten-second allowance, separate from the operation deadline. POSIX cleanup uses a checked process census to distinguish terminated zombies from live writers. A denied group signal can be accepted only when that census proves there are no live members; live or unknown state still fails closed. After inspection failure, KILL is followed by group-disappearance observation within the remaining cleanup allowance; waiting for the leader alone is insufficient. Failed inspection or cleanup closes the owner and exits with code 125; later calls in the same policy cannot launch Git. Once cleanup succeeds, cancellation takes precedence over timeout or ordinary Git failure, including cancellation received during draining. A fetch timeout alone does not explain why transport stalled.

Straight-line callers use `--git <seconds> <args>`; zero means no operation deadline. Recovery policies use `--policy <trusted-python-file>` or `--policy -` (trusted source on stdin) in the same Python process and import `run_git`, `git_output`, `GitFailure`, and `FetchTimeout` from `ci_git_owner`. Policies catch only ordinary Git failures and operation timeouts. Ordinary Git exits 125 and 143 remain distinct from ownership failure and cancellation inside that typed boundary; shell exit codes alone cannot distinguish them. Generic Git and policy invocations require no GitHub or runner environment. `run_git` accepts output streams and command-local environment overrides without persisting Git configuration; cleanup always uses the shared ten-second allowance. Git stdin is always `DEVNULL`. `git_output` returns exact UTF-8 text with surrogate escapes for undecodable bytes, preserving whitespace and NUL separators; only checkout ref resolution trims output. Inline policy lets a running workflow supply its own trusted policy to a pinned owner without importing code from the selected checkout.

Preflight, manual security, Python skills, ClawHub docs source, and Android reuse that owner. Preflight and Python skills retain three timeout-only depth-one fetch attempts; manual security keeps depth two and its unavailable-target fallback. Preflight separately retries depth-two blobless parent metadata on any Git failure and verifies exact requested SHAs even when an event ref moves. ClawHub and Android retain five whole-checkout attempts: only the ClawHub source directory is cleared for docs, while Android clears its candidate workspace and requires an executable Gradle wrapper. The preflight and Android trusted-harness checkouts remain separate.

Direct supplemental fetches in `ci.yml` use the same workflow-owned bootstrap from the runner temporary directory, never a helper from the selected candidate. Scan history retains its PR-count-derived depth; release-gate ratchets retain six merge-snapshot attempts; npm-lock history failures still select a full sweep, but cleanup uncertainty or cancellation stops instead of launching a consumer. Existing deadlines and the unbounded protocol-baseline fetch remain unchanged. All six preflight `ls-remote` calls also use this owner with no operation deadline (`None`), preserving their output, exact-SHA checks, and successful-empty-only annotated-to-lightweight tag fallback.

Lock reclamation is separate from process ownership. The checkout and base-fetch policies pass `reclaim_locks=True` only for their exclusively owned checkout; supplemental CI fetches select the equivalent `--checkout-git <seconds> <args>` entrypoint. After a failed or terminated fetch and verified process-tree extinction, the owner removes newly created locks in physical Git metadata; pre-existing locks and linked metadata remain untouched. Generic Git calls do not claim metadata, so read-only commands also work in linked worktrees.

The shared `ensure-base-commit` action resolves the adjacent owner from its own action package and runs its availability/recovery policy in process. It retains 30-second fetch deadlines: exact SHA at depth one, then deepen by 25, 100, and 300, then a plain ref fetch (not `--unshallow`). Availability is checked after successful fetches and ordinary failures, but never after cancellation or unverified cleanup.

Workflow Sanity is the first external pinned typed-policy adopter: after Python 3.12 setup, it prepares `git-owner@dd4528b6393e7d00063067a080ca7241b48ce475` and supplies the trusted audit-config policy inline. An already-present base commit skips transport. Otherwise, its exclusively owned checkout enables lock reclamation while retaining 30-second fetch deadlines, at most three attempts per ref, and five-second cancellation-aware backoff only between timeout or ordinary Git 124/137 retries. Ordinary exact-SHA failure or retry exhaustion permits branch fallback; ownership failure or cancellation does not. Each config independently selects the exact SHA or existing remote branch with unbounded local reads, and the environment path is published only after both configs and the Zizmor path rewrite succeed.

QA Profile Evidence is another pinned terminal adopter of `git-owner@dd4528b6393e7d00063067a080ca7241b48ce475`. Each Git-using job prepares the owner outside later checkouts using the established system Python bootstrap. Its four validation/protocol fetches retain 120-second operation deadlines; its six trusted-harness and selected-source bootstrap fetches retain no operation deadline. All ten use straight-line `--checkout-git` calls with one attempt, so ownership failure or cancellation stops before downstream checkout, readback, or publication. Called-workflow identity and selected-source trust classification remain separate and unchanged.

Mantis ref validation uses the same pinned owner. The shared `mantis-validate-trusted-ref` action owns one unbounded main fetch, even with both baseline and candidate refs. Discord smoke validation owns two fetch sites with 120-second deadlines: main, then the exact release branch when needed. Each fetch has one attempt and must drain before trust probes or outputs. The validators retain distinct trust policies and output contracts; a Discord release-branch mismatch never falls through to PR lookup.

Mantis installers and worktree preparation also use that pinned owner, prepared immediately after the harness checkout in each run job. Discord status reactions and thread attachment retain their two depth-one Crabbox clones with 120-second deadlines through `--git 120`. Slack desktop retains init, remote-add, one depth-one fetch of `main`, and detached `FETCH_HEAD` checkout; only its fetch has a 120-second deadline. All six worktree additions across status reactions, thread attachment, Slack desktop, and Web UI chat proof use `--checkout-git 0` from the harness checkout. Local init, remote-add, checkout, and worktree operations have no operation deadline. Ownership failure or cancellation is terminal before subsequent Git operations, Go/pnpm builds, probes, or outputs. No current Mantis Git invocation uses GNU `timeout`.

Docs Sync Publish Repo prepares the same pinned owner after the source and ClawHub checkouts, using system Python before Node setup. Its inline typed policies own clone and the connected publication chain. Clone and both fetch sites retain 120-second operation deadlines; clone and publication retain five attempts with 2/4/6/8/10-second backoffs, including the final failed attempt. Only ordinary Git failure or `FetchTimeout` permits retry after verified cleanup. The advisory pre-commit fetch may fail and safely continue to commit; publication failure first attempts an owned rebase abort. Rebase, push, local reads, and config/add/commit remain unbounded. ClawHub HEAD must complete through the owner before the sync script consumes it. Cleanup uncertainty, setup failure, or cancellation is terminal before retry, abort, another deletion, or consumption. Only the fixed publish path is replaced, without following its symlink; exclusive publish operations reclaim newly created locks while preserving existing locks. Queue concurrency, stale-source checks, and no-change success remain unchanged.

To use the standalone action from another workflow, pin `openclaw/openclaw/.github/actions/git-owner@<full-40-character-commit-SHA>` to a reviewed revision containing the action. Supply policy from the trusted workflow inline or from the same trusted action package, never from the selected candidate. Within `ci.yml`, the existing bundled-protocol and CI-routing matrix tasks smoke-test the action from the separately pinned `.ci-harness` checkout before Node setup, compare its output and copied bytes, and run owned `git --version` without network access. Other workflows' direct Git commands remain outside this ownership coverage until they adopt it.

## Scope and routing

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`. Ordinary manual dispatch skips changed-scope detection and makes the preflight manifest act as if every scoped area changed. The exact-head `release_gate` exception evaluates the fetched pull request merge tree and retains its macOS, iOS-build, screenshot-risk, and generated-native-locale decisions while still verifying native sources.

Release screenshot routing is deliberately conservative because an app change can break deterministic App Store capture without breaking compilation. Pull requests and exact-head release gates run the full iPhone, iPad, and Watch matrix when the diff touches `apps/ios/**`, linked OpenClawKit or Swabble code, Apple Swift configuration, or the scripts used by screenshot capture. The two device shards start alongside `ios-build`, because each owns its simulator build and consumes no output from that job. CI keeps scenarios serial within each device and captures Watch evidence in the iPhone shard. The final gate independently requires the build and both screenshot shards. A hosted reducer verifies the exact evidence union before publishing the sole canonical artifact consumed by `openclaw/ci-gate`. Ordinary manual CI and Full Release Validation always run that matrix. The screenshot decision is independent of macOS routing; a pure iOS app change does not select macOS jobs by itself.

Separate iOS and macOS Periphery workflows enforce a zero-findings dead-code policy. Each runs only when a non-draft pull request touches its native scan scope, or when manually dispatched.

- **CI workflow edits** validate the Node CI graph, workflow linting, and the Windows lane (`ci.yml` executes it), but do not force iOS, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
- **Git-owner changes** to its action, base-commit policy, projection generator, lifecycle tests and support, or named owner-adopting workflows such as Workflow Sanity, QA Profile Evidence, Mantis ref validation/installers/worktrees, and Docs Sync Publish Repo select the existing `macos-node` and Windows lanes. These run native checkout ownership proof without selecting Swift, iOS, or Android jobs; Mac app and shared-native changes retain their existing Mac lanes.
- **macOS Swift runner budgets** are 20 minutes on Blacksmith and 30 minutes on every GitHub-hosted route, including first-attempt pull requests from untrusted contributors.
- **Workflow Sanity** runs `actionlint`, `zizmor` over all workflow YAML files, the composite-action interpolation guard, and the conflict-marker guard. The PR-scoped `security-fast` job also runs `zizmor` over changed workflow files so workflow security findings fail early in the main CI graph.
- **Docs on `main` pushes** are checked by the standalone `Docs` workflow with the same ClawHub docs mirror used by CI, so mixed code+docs pushes do not also queue the CI `check-docs` shard. Pull requests and manual CI still run `check-docs` from CI when docs changed.
- **TUI PTY** splits by proof ownership. The dedicated `core-runtime-tui-pty` Node shard owns the full real-backend suite against the exact-head built CLI in metadata-complete pull request fallbacks plus manual and release runs; routine `main` push compacts omit that serial shard. The `build-artifacts` job keeps a local model roundtrip and a real Gateway connection canary on every artifact boundary without duplicating the full serial suite inside the build job.
- **SQLite session lifecycle** runs the built-CLI migration, restart, compaction, cleanup, and session RPC proof only when the diff touches its direct storage/session owners or a reachable session path in the embedded runner. The dedicated `check-sqlite-session-lifecycle` job downloads the exact runtime produced by `build-artifacts`; manual and release dispatches always select it when the target contains the proof.
- **CI routing-only edits, the small set of core-test fixtures the fast task runs directly, and narrow plugin contract helper edits** use a fast Node-only manifest path: `preflight`, `security-fast`, and only the fast lanes the change touches — a single `checks-fast-core` CI-routing task, the two plugin contract shards, or both. That path skips build artifacts, Node 22 compatibility, channel contracts, full core shards, bundled-plugin shards, and additional guard matrices.
- **QA Smoke on pull requests** runs only when the diff touches a QA-owned surface: the qa-lab harness, `qa/` scenario data, the matrix/telegram channels the smoke profile drives, the docker packaging scripts, or the gate's own orchestration. Broad runtime changes (src, ui, packages, dependency manifests) no longer select the six-part smoke matrix per PR; every canonical `main` push and release validation still runs the full profile set, so runtime regressions surface one push after merge instead of taxing every PR with roughly five extra hosted-runner minutes.
- **Windows Node checks** are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes.

The slowest Node test families are split or balanced so each job stays small without over-reserving runners:

- Plugin contracts and channel contracts each run as two weighted Blacksmith-backed shards with the standard GitHub runner fallback.
- Core unit fast/support lanes run separately; unit-src, Control UI, and gateway-core each use three deterministic file-weighted stripes, while the security and media/UI companion configs retain their scoped whole-config support groups; core runtime infra splits into process, shared, hooks, secrets, and three cron domain shards.
- Auto-reply runs as balanced workers, with the reply subtree split into agent-runner, commands, dispatch, session, and state-routing shards; dispatch further isolates core, delivery, and lifecycle entrypoints.
- Agentic gateway/server (control-plane) configs split across chat, auth, model, HTTP/plugin, runtime, and startup lanes instead of waiting on built artifacts.
- Normal CI packs only isolated infra include-pattern shards into deterministic bundles of at most 64 test files, reducing the Node matrix without merging non-isolated command/cron, stateful agents-core, or gateway/server suites. Heavy fixed suites stay on 8 vCPU while most bundled and lower-weight lanes use 4 vCPU. Compact-small bins 2, 5, and 8 use existing 8-vCPU capacity because recent hosted runs showed they repeatedly owned the critical path while the 4-vCPU queue was materially longer; routing happens after packing, so group ownership, coverage, and the existing registration count do not change.
- Pull requests on the canonical repository reuse the changed-test resolver against the synthetic merged-tree diff. Precise changes run one targeted Node job; each selected test file gets its own process so stateful suite isolation remains intact. The planner combines sibling tests with import-graph dependents and falls back to a metadata-complete compact plan for workspace package, package/lockfile, shared harness, split-config, renamed, or deleted changes, public extension-contract changes, tests with special shard setup, partially resolved or empty targets, oversized path or target plans, and planner errors. Nondist descriptors run as Node jobs; dist descriptors fold into the built-artifact boundary. The number of compact jobs follows the current measured weights. That PR fallback retains all seven tooling stripes, the isolated tooling shard, and the TUI PTY shard because scripts and PTY owners intentionally require their Go, dist, and environment metadata. Those timing-sensitive groups remain isolated in concurrency-one exclusive bins. Targeted plans always retain the full boundary gate because its repository scanners cannot be derived from imports.
- When canonical pull requests fall back to compact planning, directly changed, existing tests owned by the release-only plugin shard remain as exact-file selections in the existing compact jobs. Canonical Vitest routing keeps unit-fast, contract, bundled, and E2E tests with their own suites; source files, directories, deleted tests, and live tests do not widen plugin coverage. The broad `agentic-plugins` sweep remains release-only, and push and manual CI plans are unchanged.
- Canonical `main` pushes use a Blacksmith integration compact with nondist Node jobs plus the dist boundary descriptor. Former multi-config walls (CLI plus CLI-process, isolated plus fake-timers unit fast, and the logging/process/runtime-config trio) are split into per-config shards so no single group floors a lane. They omit the low-signal-per-push tooling and TUI PTY groups while retaining all product-runtime groups, including three file-weighted stripes apiece for unit-src, Control UI, and gateway-core. The Blacksmith 8-vCPU admission target is 200 seconds; the small-runner class retains its measured 276-second admission to balance runner registrations against group work. Manual dispatches and Full Release Validation retain the full named per-shard matrix. No scheduled workflow currently runs that full Node suite; this is a known coverage-timing gap, not coverage supplied by this compact plan.
- The full Node matrix admits the consistently slow serial tooling, auto-reply command shards, and broad core-fast cache writer first. This keeps the 28-job concurrency cap while preventing critical-path work and the next run's transform seed from slipping into a later wave.
- Serial Control UI browser shards greedily pack discovered test files using committed per-file timings, then cold-start basename hints, then source byte size. A measured per-file overhead accounts for fork, import, and setup time. Timing keys supply weights only: discovery still determines the complete test inventory, including new files and files without measurements.
- Broad browser, QA, media, and miscellaneous plugin tests use their dedicated Vitest configs instead of the shared plugin catch-all. Include-pattern shards record timing entries using the CI shard name, so `.artifacts/vitest-shard-timings.json` can distinguish a whole config from a filtered shard.
- The browser native-host launch test is a separate POSIX E2E case. Linux `build-artifacts` runs it explicitly after building or restoring dist, using `OPENCLAW_E2E_USE_PREBUILT_DIST=1` so the test cannot start another build. Its JSON report must contain exactly the named passing assertion in the expected file, with one passed test and zero failures, pending tests, or todos; missing artifacts, skipped tests, and absent results fail. The workflow step skips only when a frozen historical checkout lacks the test file: that is unavailable historical proof, not coverage. Current checkouts with a missing file still fail. Changes to the case, its installation fixture, or its relay-key fixture select the artifact job even on test-only diffs; unrelated browser unit tests stay build-free. Manual CI uses the same artifact step, independently of the release-only plugin sweep.
- Linux Node shard jobs persist Vitest's experimental filesystem module cache through the upstream Actions cache API, which Blacksmith transparently accelerates on its runners. Blacksmith CI shards are restore-only and unpack the protected seed into isolated runner-local roots. While the GitHub-hosted outage backend is active, every `checks-node-*` test shard, `check-sqlite-session-lifecycle`, `checks-ui`, the ordinary sharded `checks-ui-e2e` job, both fast contract matrices, and the Vitest-running `checks-fast-core` tasks restore that same immutable transform seed. The composite action's single default-off `restore-test-caches` input keeps the expansion easy to disable without changing cache keys or writer policy; mixed fast-core rows enable it only for tasks that invoke Vitest. The small real-Gateway UI job stays cold because its two targeted files do not justify the archive restore, while native and Control UI i18n lanes do not invoke Vitest. The hybrid planner profile restores the same seeds: attempt-1 Blacksmith rows read the archives through Blacksmith's Actions-cache proxy and hosted retries read them directly. The planner still elects exactly one Node shard to restore and save the shared transform archive so hosted runs can recover a cold cache without waiting for the daily warmer; every other job remains restore-only. The non-cancelling warmer runs daily, accepts manual or repository dispatch, follows `OPENCLAW_CI_RUNNER_BACKEND`, and serializes per ref, so maintainers can rebuild both the Vitest transform cache and test-scope Node compile cache on hosted runners without canceling a main writer. The warmer launches each selected shard/config envelope in a fresh child process with concurrency one, preserving its include patterns and environment while reusing the same serial cache leaf. It finishes every selected envelope and saves the content-keyed transform and compile caches even when a test fails, then reports the test failure after the cache saves; ordinary CI shard execution remains fail-fast. This prevents config-global state from leaking, avoids expanding filtered shards into whole configs, and retains transforms produced by the previous child. A transform-input fingerprint clears incompatible lockfile, package, tsconfig, and Vitest-config generations. Each writer scans and prunes its restored cache to 75% after it exceeds 2 GiB. Vitest hashes module id, source content, environment, and resolved transform config, so ordinary partial source changes keep unchanged entries warm while changed modules miss safely. Coarse restore prefixes bridge workflow runs; normal Actions cache LRU and inactivity eviction bound old immutable archives.
- Trusted Blacksmith Linux Node jobs restore root `node_modules`, workspace importer trees (including plugin-local versions and links), and the workspace-local pnpm store from one immutable upstream Actions cache, which Blacksmith transparently serves from its colocated backend. Pnpm imports with hard links where the filesystem permits, and keeping the complete installed tree and store in one archive preserves those links. Source postinstall and build preparation leave pnpm-owned dependency trees intact. The key includes an explicit archive format, runner OS and architecture, the exact Node patch, and the semantic install-input fingerprint; there are no stale-prefix fallbacks. Manifests are canonicalized before hashing. The repository-owned `openclaw` metadata block and non-install scripts are excluded because pnpm and the audited direct root hooks do not read them, so runtime schema, publication metadata, formatting, and ordinary test/build script edits keep the dependency tree warm; unaudited lifecycle-hook drift fails closed until its source inputs join the fingerprint contract. Dependency, package-manager, hook-source, and lockfile changes always select a new immutable archive. Every exact restore runs frozen offline pnpm reconciliation, so an unchanged archive validates without registry access or importer relinking. If reconciliation fails, setup first clears every importer tree and rebuilds it offline from the restored store, then clears both modules and store and retries from the network rather than serving a partial tree. Setup then disables pnpm's redundant pre-run dependency check so install and frozen reconciliation remain the only dependency writers; shard commands must not launch concurrent implicit installs. Preflight is the sole writer and saves immediately after a successful deterministic install: canonical `main` publishes the default-branch seed, while same-repo pull requests publish only into their merge-ref scope before their dependent jobs fan out. Consumers are restore-only; an exact miss automatically falls back to the coarser pnpm store cache. Manual dispatches, fork pull requests, and hosted retries use only that store cache, and the separate store-warmer is skipped when preflight already owns either exact-cache write. Cache restore/save failures are optimization misses rather than correctness failures, and normal branch scoping, LRU, and inactivity eviction bound obsolete archives. The former mutable dependency StickyDisk path was retired after repeated successful writers acknowledged commits that later runs still restored as empty filesystems.
- Node shard and build-artifact jobs also restore Node's portable on-disk compile cache through immutable Actions caches. In GitHub-hosted outage mode, the hosted Vitest lane set above restores the same test-scope archive alongside the transform seed. Independent `test` and `build` namespaces prevent their writers from replacing each other's archives: the scheduled test warmer owns the protected test seed, while `build-artifacts` may publish at most one protected build archive per UTC day from trusted `main` pushes. PR and ordinary test jobs only read protected snapshots, so feature-branch bytecode never enters the shared seed and PR traffic creates no cache archives. This reuses V8 bytecode for Node-loaded orchestration, build tooling, and external dependencies across different checkout paths, including when only part of the source graph changes. A maximum-size 2 GiB transform archive costs roughly 15–20 seconds to restore at about 125 MB/s; measured fast-contract transforms are roughly 21 seconds against an approximately 8-second restore, and broader cold imports reach roughly 100–143 seconds. The optimization should be reverted if measured savings fall below restore cost. Vitest child processes disable an inherited compile cache because coverage can be enabled inside dynamic configs and V8 coverage can lose source-position precision when scripts are deserialized from bytecode.
- Hosted `check-lint` restores and saves the same content-keyed extension package-boundary archive as the dedicated boundary lane before rebuilding any missing declarations; Blacksmith keeps its read-only sticky-disk fast path. The Control UI and UI E2E jobs share a Linux Playwright Chromium archive keyed by the exact pinned Playwright version. `macos-node` saves the pnpm store after an exact miss, allowing both hosted and Blacksmith macOS runners to seed the cache they already restore.
- The build-artifact job also persists content-fingerprinted `build-all` step outputs. The `ciArtifacts` profile skips global declaration emission, then stages the canonical public/private `tsdown` SDK declaration groups through `scripts/write-plugin-sdk-entry-dts.ts`. It publishes declarations to `dist/` only after both groups succeed and all relative declaration references resolve within the staged output. This step has no separate declaration cache and writes no workspace forwarding bridges. Local plugin lint and package-boundary compilation use independent native declaration trees, not packaged declarations; see [declaration ownership](/reference/test#shared-test-state-and-process-helpers). The built Doctor plugin-index proof reuses that exact `dist/` output instead of invoking the E2E harness's fallback TypeScript build a second time.
- Full and package builds cache declarations at the AI, workspace-package, and unified `build-all` step boundaries. The unified step emits one base declaration group, public/private SDK groups, and five plugin groups; these partitions share one unified cache snapshot rather than separate caches. On cache hits, each step still rebuilds runtime JavaScript before restoring declarations. Core or plugin changes therefore invalidate only the unified snapshot, while workspace-package changes conservatively invalidate every dependent declaration cache. Public full builds generally use an immutable Actions cache; coarse restore keys seed partial changes, per-step content fingerprints reject stale data, and GitHub's cache quota evicts old generations. The weekly Node 22 lane instead publishes a 14-day artifact after successful `main` runs and restores only artifacts whose immutable producer identity resolves to that workflow on `main`, avoiding quota churn without allowing PR code to write a shared cache. Private-QA declarations are never persisted in Actions caches because cache namespaces are not confidentiality boundaries.
- `check-additional-*` stripes the supplemental boundary guard list (`scripts/run-additional-boundary-checks.mts`) into one prompt-heavy shard (`check-additional-boundaries-a`, which includes the Codex prompt snapshot drift check) and one combined shard for the remaining stripes (`check-additional-boundaries-bcd`), each running independent guards concurrently and printing per-check timings. Package-boundary compile/canary work stays together, and runtime topology architecture runs separately from the gateway watch coverage embedded in `build-artifacts`.
- On the 32-vCPU self-hosted build runner, Gateway watch, channel tests, and the core support-boundary shard start together inside `build-artifacts` after `dist/` and `dist-runtime/` are already built. GitHub-hosted fallback runs keep Gateway watch serial so low-core contention cannot consume its readiness deadline. Full Node builds then verify Discord component attachment filenames through a serial public Gateway message action, checking the built revision and retaining the named-test JSON result; frozen targets that predate the case explicitly report unavailable proof. Both paths then run the two built TUI PTY artifact canaries alone; the pull request fallback plus manual and release full matrices own the dedicated full serial shard.

Once admitted, canonical Linux CI permits up to 28 concurrent Node test jobs with
the all-Blacksmith planner and 96 with the `github` or `hybrid` planner profile. The smaller
fast/check lanes remain capped at 12 in both modes; Windows is capped at two
and Android at two because those runner pools are narrower. Compact whole-config batches run
with a 120-minute batch timeout, while include-pattern groups share the same
bounded job budget.

Android CI runs both `testPlayDebugUnitTest` and `testThirdPartyDebugUnitTest` and then builds the Play debug APK. The third-party flavor has no separate source set or manifest; its unit-test lane still compiles the flavor with the SMS/call-log BuildConfig flags, while avoiding a duplicate debug APK packaging job on every Android-relevant push. Each current Gradle task has one protected sticky disk; PR jobs use disposable clones, while protected runs refresh content-addressed Gradle entries in place.

Robolectric resolves Android SDK artifacts outside Gradle's dependency cache, so every Android `test-*` task receives a workflow-owned Gradle init script that points test JVMs at a dedicated Maven-local repository. Actions cache restores are task-, platform-, and Android-contract-scoped; a prefix restore can seed a changed contract, but only a successful trusted run may publish the completed exact cache after a miss. Cold runs may download missing SDK artifacts, while warm runs reuse the exact archive. Build and lint tasks do not receive the Robolectric init script.

Remaining Blacksmith sticky-disk keys are deliberately bounded by supported task dimensions, never PR number, commit, run, branch, or dependency hash. Dependency, runtime transform, and compile caches use Actions cache instead because immutable archives expose verifiable restore/save results and avoid mutable snapshot-promotion failures. After a sticky key-version migration, add only the exact obsolete key, architecture, and region identities to `.github/retired-sticky-disks.json`, dispatch `Sticky Disk Cleanup` from `main` with the same dimensions and confirmation, verify deletion, then remove those entries. The workflow routes ARM identities to an ARM runner, rejects runner-region mismatches, uses Blacksmith's exact-key deletion action, and never deletes Docker builder caches or wildcard prefixes. Actions cache archives use normal LRU and inactivity eviction.

The `check-dependencies` shard runs Knip dependency, unused-file, and unused-export checks. Both guards enforce zero findings across production and full-tree scans, with no unused-file allowlist. The export guard also audits script entry exports. Production excludes test-support consumers; the full-tree and script scans include tests as consumers. Model intentional dynamic consumers in `config/knip.config.ts`, `config/knip.all-exports.config.ts`, or `config/knip.scripts-exports.config.ts` as appropriate. Each guard reports every scan outcome and fails if any scan fails. Historical targets run the export guard when they provide it and retain their older dead-code fallback otherwise.

## Measured shard weights

`config/ci-test-timings.json` records CI measurements for UI E2E files and compact
Node groups. Both packers prefer these weights over their in-source cold-start
tables. UI E2E keys are repo-relative paths, including tests under `ui/src/pages/`,
and every file estimate includes the measured fork, import, and setup overhead.
Compact groups have separate Blacksmith and GitHub-hosted measurements, selected
from jobs API runner labels (`blacksmith-*` versus hosted `ubuntu-24.04`); hybrid
and large-group stripe adjustments continue to use their existing policies.
Compact `[shard:x] begin` to `end` wall time includes contention from the other
group running under `PLAN_CONCURRENCY = 2`. This is intentional: the packer
predicts the same two-up jobs, and `COMPACT_LARGE_NODE_TEST_JOB_SECONDS` /
`COMPACT_SMALL_NODE_TEST_JOB_SECONDS` were fitted against those contended walls.
Switching to isolated group timings would invalidate those admission caps.

The compact plan is built once in preflight. UI E2E shards build their partitions
independently, so they must read the same committed file from the checkout. They
never download timing artifacts or consult restored timing caches. Missing or
invalid timing files, or `OPENCLAW_CI_TEST_TIMINGS=0`, use the cold-start estimates
for the entire file; stale keys cannot change the discovered test inventory.

With an authenticated `gh` CLI, run `pnpm ci:timings:refit` to regenerate the file
from all attempts of the last five successful `ci.yml` push runs on `main`. The
refit validates each run's event, branch, and head SHA before reading job logs;
manual dispatches are rejected even when launched from `main`. Use `--runs <n>` to change
the sample window, `--repo <owner/repo>` to select a repository, `--out <path>` to
write elsewhere, or `--dry-run` to print changed entries without writing.
Measurements come only from successful UI E2E and compact jobs; compact groups
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

Ordinary manual CI dispatches run the same job graph as normal CI but force every non-Android scoped lane on: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, iOS build, and Control UI/native app i18n. Their logical runner profile is always `github`, independent of the physical fallback selected by `runs-on`. Node 22 compatibility runs in Full Release Validation and manual dispatches only; push and pull request CI skip it. The exact-head `release_gate` fallback instead keeps the pull request's macOS, iOS, and generated-native-locale scope, including conservative release screenshot capture for screenshot-pipeline owners. Automatic source PRs and release gates verify native extraction inventory and Android/Apple localization safety without requiring translated or platform-generated output in the same PR. The serialized Native App Locale Refresh workflow rebuilds those artifacts in one isolated PR and enables exact-head auto-merge after required checks pass. Full native parity remains blocking for generated-artifact PRs, generated-scope release gates, ordinary manual CI, Full Release Validation, and release prep. Control UI locale parity remains advisory on automatic PR and `main` runs and blocking on manual/release CI. Standalone manual CI dispatches run Android only with `include_android=true` (the `release_gate` input also forces Android); the full release umbrella enables Android by passing `include_android=true` without setting `release_gate`. Plugin prerelease static checks, the full `agentic-plugins` sweep, the full extension batch sweep, and plugin prerelease Docker lanes are excluded from CI. The Docker prerelease suite runs only when `Full Release Validation` dispatches the separate `Plugin Prerelease` workflow with the release-validation gate enabled.

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

## Runners

Runner choice follows contributor trust, not whether a pull request came from a fork. Every `runs-on` expression admits Blacksmith only when `github.event.pull_request.author_association` is `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR`, so a fork pull request from someone who has already landed a commit is routed exactly like a maintainer pull request. `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, and `MANNEQUIN` stay on GitHub-hosted runners, which are free for public repositories, so an unreviewed author cannot spend Blacksmith capacity. Maintainers report `CONTRIBUTOR` here because org membership is concealed; keep `CONTRIBUTOR` in that list or maintainer pull requests lose Blacksmith. Pushes and manual dispatches are unaffected. Cache trust is a separate, stricter boundary: the exact dependency cache stays gated on the pull request coming from `openclaw/openclaw`, so a fork run never writes an archive a trusted run later restores.

| Runner                          | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                  | `security-fast`, manual CI dispatch and non-canonical repository fallbacks, CodeQL security and quality scans, workflow-sanity, labeler, auto-response, the standalone Docs workflow, the whole Install Smoke workflow, all configurable CI jobs in `github` mode, and the remaining light lanes plus rerun Blacksmith lanes in `hybrid` mode. The GitHub/hybrid planner profile expands the Node matrix, QA Smoke to six parts, core oxlint across five stripes, and the core test-type graphs across five stripes while leaving extension/scripts lint plus optional UI and format checks in the existing `check-lint` row and the extensions/root/scripts type tail in the `check-test-types` row. |
| `blacksmith-4vcpu-ubuntu-2404`  | `preflight`, `pnpm-store-warmup`, `native-i18n`, `checks-fast-core` except QA Smoke CI, plugin/channel contract shards, most bundled/lower-weight Linux Node shards, `check-*` lanes except `check-lint`, selected `check-additional-*` shards, `check-docs`, and `skills-python`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `blacksmith-8vcpu-ubuntu-2404`  | Retained heavy Linux Node suites, compact-small queue-tail bins 2, 5, and 8, first-attempt same-repo `checks-ui-e2e` rows, boundary/extension-heavy `check-additional-*` shards including runtime topology architecture, `check-sqlite-session-lifecycle`, and `android`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `blacksmith-16vcpu-ubuntu-2404` | Automatic QA Smoke CI shards, `check-test-types`, and first-attempt same-repo pull requests and pushes for `checks-ui-e2e-real-gateway`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `blacksmith-32vcpu-ubuntu-2404` | `build-artifacts`, `check-lint`, `check-dependencies`, and `check-additional-extension-package-boundary`; these lanes are CPU-sensitive enough that smaller runners extend the critical path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `blacksmith-8vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `blacksmith-6vcpu-macos-15`     | `macos-node` on `openclaw/openclaw`; untrusted authors fall back to `macos-15`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-12vcpu-macos-26`    | `macos-swift`, `ios-build`, and the two `ios-screenshot-shard` rows on `openclaw/openclaw`; untrusted authors fall back to `macos-26`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The Node test planner marks only shards that run the real native grep fixture.
Those Linux jobs install the `ripgrep` package when the selected runner image
does not provide it. Other Node shards do not pay that setup cost.

### Runner backend modes

The `macos-swift` lane builds Swift tests once and runs each test once per job. The ordinary suite retains default-profile behavior; AppState isolation tests run in a separate named-profile process through the same resource-owning launcher. Each launch owns a private home and disposable, unlocked default Keychain until the test process group and output pipes close. HOME and profile markers do not isolate macOS services; both partitions run only on the disposable credentialless macOS worker. Automatic first attempts use parallel execution; manual dispatches and rerun attempts use serial execution. A failing test fails the job without an in-job retry. See [native test safety](/platforms/mac/dev-setup#run-native-tests-safely).

The repository variable `OPENCLAW_CI_RUNNER_BACKEND` controls the runner backend for `ci.yml`:

| Value                 | Light lanes                                                                                    | Heavy lanes                                                            | Rerun behavior                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| unset or `blacksmith` | Blacksmith-first, with the existing manual-dispatch and fork fallbacks                         | Blacksmith-first, with the existing manual-dispatch and fork fallbacks | Existing behavior is unchanged                                                       |
| `github`              | GitHub-hosted                                                                                  | GitHub-hosted                                                          | Every configurable job remains hosted                                                |
| `hybrid`              | Selected critical-path plateaus use Blacksmith on attempt 1; remaining light lanes stay hosted | Blacksmith on attempt 1; GitHub-hosted on `github.run_attempt > 1`     | Rerunning a failed or stuck Blacksmith job automatically moves it to hosted capacity |

Heavy lanes are `build-artifacts`, `check-sqlite-session-lifecycle`, `android`, `macos-node`, `macos-swift`, `ios-build`, and `ios-screenshot-shard`. Hybrid also sends the compact Node matrix, up to 96 rows, fourteen-row hosted-planner `checks-ui-e2e` matrix, the `checks-ui-e2e-real-gateway` lane that shares its serial Chromium workload, six-row QA Smoke matrix, the two-part Windows matrix, `checks-ui`, `check-lint`, `check-test-types`, the five `check-test-types-core-*` stripes, `check-dependencies`, `check-additional-extension-package-boundary`, `check-additional-runtime-topology-architecture`, and `report-plugin-sdk-api-diff` to Blacksmith on attempt 1. Compact-small rows use `blacksmith-4vcpu-ubuntu-2404`, compact-large rows use `blacksmith-8vcpu-ubuntu-2404`, and the planner's measured small queue-tail promotions retain their 8-vCPU labels. Every other configurable `ci.yml` lane stays hosted in hybrid, including preflight, the five core-lint stripes, the remaining lint/check rows, docs, and Python skills. Separate Opengrep workflows remain GitHub-hosted.

Hybrid is the normal degraded-capacity mode. If Blacksmith is down: rerun the failed or stuck heavy job; it lands on hosted automatically. During a full Blacksmith outage, `github` remains the repository-wide circuit breaker:

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body github
```

Hosted paths use the same setup exercised by manual dispatches and fork pull requests. Fork PRs are forced into the logical `github` planner profile even when repository variables are unavailable, so core lint and test types retain their hosted stripes instead of falling back to the oversized all-in-one jobs. Frozen targets opt into this event-aware profile through `hosted-runner-profile-contract-v1`; targets without the marker retain their historical workload shape. Blacksmith-only Docker and sticky-disk steps are skipped, dependency setup uses the ordinary Actions pnpm-store cache, and low-memory Android builds use separate Gradle processes. Hybrid attempt-1 Node and plateau lanes deliberately keep this backend-neutral Actions-cache profile when they run on Blacksmith because preflight remains hosted. The exact workspace dependency cache intentionally stays off when preflight is hosted: GitHub can roll the runner image and Node patch between preflight and fanout in one workflow, while the safe exact key then misses; the ordinary store archive is only slightly smaller and pnpm's measured relink is already single-digit seconds. The Node toolchain itself is also cached through that API: Blacksmith's image tracks an older runner-images snapshot whose toolcache Node patches (measured 2026-08-16: 20.20.0, 22.22.0, 24.13.0) sit just under this repo's `engines` floor, so every job otherwise re-downloads Node from nodejs.org. Restores are prefix-keyed and saves carry the resolved patch, because an exact-key hit suppresses the post-job save and would pin the first payload forever once the floor advanced past it. A restored payload below the floor is rejected, pruned, and replaced. Vitest transform and Node compile caches still use the upstream Actions cache API, which Blacksmith proxies; their Linux-only `runner.os != 'Windows'` conditions do not exclude Blacksmith labels, and the planner still elects one semantic transform-cache writer. Core oxlint splits into five deterministic hosted stripes, with extension/scripts lint and optional UI and format checks in the existing `check-lint` row. The 15 serial core test-type graphs, with UI pages and E2E tests in separate graphs to preserve the 720-root cap, likewise split into five `check-test-types-core-*` stripes (two overlapped graphs per stripe), leaving the extensions/root/scripts type tail in the `check-test-types` row; targets without stripe support keep the whole lane in that row.

The compact Node planner keeps separate Blacksmith and standard 4-core hosted timing ownership. The `github` profile targets 90/95 seconds of serial group work for the hosted large/small source runner classes and applies a 1.6x median scaling fallback only to unmeasured groups. Hybrid keeps the expanded topology and hosted-derived splitting for groups above the unchanged 150-second ceiling, so hosted retries do not inherit an indivisible hosted wall pole. Its attempt-1 packing applies the existing 0.87 scale to Blacksmith estimates, using committed measurements before the cold-start hints. Refits can change the number and composition of compact jobs without changing runner policy. Direct sampled hints cover the doctor and cron-service outliers, while a 140-second floor and singleton bin protect the observed `agentic-gateway-core-3` tail. During rebalance, native hybrid groups use scaled Blacksmith stripe hints; only synthesized hosted stripes retain their divided parent weight. Failed and timeout-and-retry samples are excluded from refreshes. Whole-config groups with registered file listers (agent support, gateway methods, runtime config, isolated unit fast) split into file-weighted hosted stripes. The hosted agent-chat split also carries direct successful-run hints for its two longest files so they cannot land in the same stripe. The subprocess-heavy tooling family uses seven balanced stripes projecting to roughly 115 hosted seconds per stripe.

Compact descriptor counts and predicted maxima vary with the committed measurements; the serial TUI PTY dist descriptor keeps its indivisible measured wall. In `github` mode compact jobs run hosted; hybrid attempt 1 uses each row's 4-vCPU or 8-vCPU Blacksmith label, while hybrid retries use hosted runners. Control UI E2E expands from the unchanged all-Blacksmith shape of three Vitest shards plus one browser-extension shard to thirteen Vitest shards plus one browser-extension shard for the `github` and `hybrid` planner profiles. QA Smoke similarly expands from four parts to six. Hybrid attempt 1 runs those expanded matrices on Blacksmith; `github` mode and hybrid retries use hosted runners. QA's planner reserves the final part's observed roughly two-minute Matrix rider before greedily assigning primary scenarios, keeping that separate run from becoming the tail. Windows runs two jobs with disjoint, project-aligned explicit test lists on every backend. This partitions the complete Windows-specific inventory without applying Vitest `--shard` to project-local single-file selections, which Vitest rejects. The split width is pinned to two because `blacksmith-8vcpu-windows-2025` admits exactly two concurrent jobs (measured on run 31865243804): a third part queues behind a finished one, while a single lane serialized the whole 226-second body onto the wall and made Windows the slowest job in every run that scheduled it. The two parts are balanced by measured per-project wall time at roughly 108 and 112 seconds. A hybrid retry reruns both parts on hosted `windows-2025`, slower but bounded. Expect slower individual builds on standard 4-core hosted runners. Blacksmith's runner-registration budget is irrelevant for hosted jobs, but GitHub-hosted concurrency limits apply.

Restore all-Blacksmith routing after an outage by deleting the variable:

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

The changed-target PR plan uses one Node test registration. Broad-risk PRs retain the metadata-complete compact fallback; canonical pushes use the integration compact. Their nondist registration counts follow the current measured weights. The `github` and `hybrid` planner profiles remain capped at 96 compact rows; `github` rows are hosted, while hybrid rows consume Blacksmith registrations on attempt 1 and move to hosted capacity on retries. Screenshot-risk runs add at most two Blacksmith registrations. Even the 96-row cap plus roughly 29 other Blacksmith lanes is about 125 registrations per full run, or 500 for four admitted runs in a five-minute window, far below the 6,000-registration operating target.

`checks-ui-e2e` is sized against its per-shard floor rather than its packing slack. The lane is serial Chromium work: roughly 2,114s of measured test body across 286 control-UI files, and a median 116s that every row pays before and around that body (about 25s checkout, about 44s Node setup dominated by `pnpm install`, about 27s of Vitest transform/import, with a p90 of 143s). Duration-weighted packing already lands the tallest row within about 10% of ideal on held-out runs, so the tallest row falls only by splitting the body further. The hosted-planner count is 14 rows — 13 control-UI shards plus the browser-extension row — which models to a 4:52 median and 5:20 p90 tallest row against 5:28/5:56 at the previous twelve. Two extra registrations per run is negligible against the operating target; the fixed floor, not the bucket, is what bounds further splitting.

Canonical-repo CI keeps Blacksmith as the default runner path for pushes and first-attempt same-repo pull-request runs when the backend is unset or `blacksmith`. Hybrid keeps the heavy set plus the named critical-path plateau lanes on Blacksmith for attempt 1; other light lanes and every rerun Blacksmith lane use GitHub-hosted capacity. Pull-request retries of both UI E2E jobs use GitHub-hosted Ubuntu in every mode; push retries remain on their normal backend unless hybrid fallback applies. Manual `workflow_dispatch` runs, including `release_gate`, and non-canonical repository runs use GitHub-hosted runners; same-repo hybrid Full Release Validation sends only frozen-candidate lint to its matrix runner. The [`github` backend](#runner-backend-modes) provides a manual repository-wide fallback; canonical runs do not probe Blacksmith queue health or mutate the variable automatically.

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
- `live-openai-candidate`: a real OpenAI `openai/gpt-5.6-luna` agent turn, skipped when `OPENAI_API_KEY` is unavailable. Runs on schedule, or on dispatch with `live_openai_candidate=true`.

The mock-provider lane also runs OpenClaw-native source probes after the Kova pass: gateway boot timing and memory across default, skipped-channel, internal-hook, and fifty-plugin startup cases; bundled plugin import RSS, repeated mock-OpenAI `channel-chat-baseline` hello loops, CLI startup commands against the booted gateway, and the SQLite state smoke performance probe. When the previous published mock-provider source report is available for the tested ref, the source summary compares current RSS and heap values against that baseline and marks large RSS increases as `watch`. The source probe Markdown summary lives at `source/index.md` in the report bundle, with raw JSON beside it.

Every lane uploads its complete GitHub artifact, including CPU, heap, trace, and compressed diagnostic bundles. A separate publisher job downloads and validates those artifacts, then mints a short-lived ClawSweeper GitHub App token scoped only to `openclaw/clawgrit-reports` contents and passes it only to the Git push step. It commits `report.json`, `report.md`, `index.md`, source-probe artifacts, and bundle metadata/checksums under `openclaw-performance/<tested-ref>/<run-id>-<attempt>/<lane>/`; the full diagnostic archive stays in the linked Actions artifact. The publisher rejects any report file over 50 MB before attempting a push. The current tested-ref pointer is `openclaw-performance/<tested-ref>/latest-<lane>.json`. Scheduled runs and `profile=release` dispatches fail if app-token creation or report publication fails. Manual non-release dispatches keep publication advisory and retain the GitHub artifacts when authentication or publishing fails. The previous source baseline is fetched anonymously from the public reports repository, so a successful baseline fetch does not prove publisher authentication.

## Full Release Validation

`Full Release Validation` is the manual release umbrella. Every run binds an
exact Validation SHA + Tooling SHA tuple and rejects an `expected_sha` mismatch
before child dispatch. Validation SHA maps to the Code SHA for product
validation or the Release SHA for changelog-only validation; it is not a third
release identity. Beta-publish maps to `release_profile=beta` with
`run_release_soak=false`; its `all` run includes normal CI, Plugin Prerelease,
package/install/cross-OS checks, performance, and QA parity, but excludes broad
live/E2E and QA-live. Postpublish-confidence uses the exact published package
with soak or explicit focused groups. Stable-publish maps to
`release_profile=stable`.

See [Full release validation](/reference/full-release-validation) for the
stage matrix, exact workflow job names, profile differences, artifacts, and
focused rerun handles.

The live/E2E selected-ref validator fetches the complete commit and ref history
with a sparse checkout. Ancestry and release-ref checks remain unchanged, while
historical file contents stay out of this metadata-only job. Build and test jobs
check out their own complete source trees.

`OpenClaw Release Publish` is the manual mutating release workflow. Dispatch
regular beta and stable publishes from trusted `main` after the release tag
exists and after the OpenClaw npm preflight has succeeded (the preflight runs
`pnpm plugins:sync:check` among its checks). The tag still selects the exact
release commit, including a commit on `release/YYYY.M.PATCH`; Tideclaw alpha
publishes keep using their matching alpha branch. It requires the saved
`preflight_run_id` and a successful
`full_release_validation_run_id` and its exact
`full_release_validation_run_attempt`, dispatches `Plugin NPM Release` for all
publishable plugin packages, dispatches `Plugin ClawHub Release` for the same
release SHA, and only then dispatches `OpenClaw NPM Release`. Stable publish also
requires an exact `windows_node_tag`; the workflow verifies the Windows source
release and compares its x64/ARM64 installers with the candidate-approved
`windows_node_installer_digests` input before any publish child, then promotes
and verifies those same pinned installer digests plus the exact companion asset
and checksum contract before publishing the GitHub release draft.
Focused plugin-only repairs use `plugin_publish_scope=selected` with a nonempty
package list. Plugin-only `all-publishable` runs require the same immutable npm
preflight and Full Release Validation evidence as a core publish.

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
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

Gateway-profile shards and shards containing the image-tool provider or OpenAI plugin live tests prepare the `sourcePerformance` build profile before starting Vitest. This supplies executable provider and agent runtime artifacts without building declarations or the Control UI. Provider requests, assertions, and test deadlines remain unchanged; gateway diagnostic environment settings apply only to gateway-profile shards. Cold source-plugin Jiti import cost remains a separate performance follow-up, not live provider latency.

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

The `published-upgrade-survivor` Docker lane validates one published package baseline per run in the blocking release path. In Package Acceptance, the resolved `package-under-test` tarball is always the candidate and `published_upgrade_survivor_baseline` selects the fallback published baseline, defaulting to `openclaw@latest`; failed-lane rerun commands preserve that baseline. Full Release Validation with `run_release_soak=true` or `release_profile=full` sets `published_upgrade_survivor_baselines='last-stable-4 2026.4.23 2026.5.2 2026.4.15'` and `published_upgrade_survivor_scenarios=reported-issues` to expand across the four latest stable npm releases plus pinned plugin-compatibility boundary releases and issue-shaped fixtures for Feishu config, preserved bootstrap/persona files, configured OpenClaw plugin installs, tilde log paths, and stale legacy plugin dependency roots. Expanded published-upgrade survivor and update-migration selections are split by baseline into groups of at most three scenarios, with at most 32 targeted Docker jobs active per matrix. Grouping shares the execution planner’s baseline-compatibility policy, so every supported scenario runs exactly once without creating empty shards for old baselines. Each scenario still owns a fresh container and the unchanged npm resource limit; package and image identities remain shared across the matrix. The separate `Update Migration` workflow uses the `update-migration` Docker lane with `all-since-2026.4.23` baselines and `plugin-deps-cleanup` scenarios when the question is exhaustive published update cleanup, not normal Full Release CI breadth. Local aggregate runs can pass exact package specs with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, keep a single lane with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC` such as `openclaw@2026.4.15`, or set `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` for the scenario matrix. The published lane configures the baseline with a baked `openclaw config set` command recipe, records recipe steps in `summary.json`, and probes `/healthz`, `/readyz`, plus RPC status after Gateway start. The Windows packaged and installer fresh lanes also verify that an installed package can import a browser-control override from a raw absolute Windows path. The OpenAI cross-OS agent-turn smoke defaults to `OPENCLAW_CROSS_OS_OPENAI_MODEL` when set, otherwise `openai/gpt-5.6-luna`, so the install and gateway proof uses the lower-cost GPT-5.6 test tier.

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

The reusable live/E2E workflow asks `scripts/test-docker-all.mjs --plan-json` which package, image kind, live image, lane, and credential coverage is required. `scripts/docker-e2e.mjs` then converts that plan into GitHub outputs and summaries. It either packs OpenClaw through `scripts/package-openclaw-for-docker.mjs`, downloads a current-run package artifact, or downloads a package artifact from `package_artifact_run_id`, then validates the tarball inventory. The default `no-push-artifact` path builds package-digest-tagged bare/functional images through Blacksmith's Docker layer cache, packs the exact image bytes into an immutable workflow artifact, and has each consumer verify and load that artifact. `existing-only` instead requires explicit `docker_e2e_bare_image`/`docker_e2e_functional_image` GHCR refs and never builds or pushes. Those registry pulls use a bounded 180-second per-attempt timeout so a stuck stream retries quickly instead of consuming most of the CI critical path. After successful scheduled validation, `openclaw-scheduled-live-checks.yml` passes the immutable tested-image manifest to the separate package-write publisher; read-only release and prerelease callers never traverse that writer.

### Release-path chunks

Release Docker coverage runs smaller chunked jobs with `OPENCLAW_SKIP_DOCKER_BUILD=1` so each chunk verifies and loads only the artifact-backed image kind it needs (or pulls it under explicit `existing-only` reuse) and executes multiple lanes through the same weighted scheduler:

- `OPENCLAW_DOCKER_ALL_PROFILE=release-path`
- `OPENCLAW_DOCKER_ALL_CHUNK=core | package-update-openai | package-update-anthropic | package-update-core | plugins-runtime-plugins | plugins-runtime-services | plugins-runtime-install-a..h | openwebui`

Current release Docker chunks are `core`, `package-update-openai`, `package-update-anthropic`, `package-update-core`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`. `package-update-openai` includes the live Codex plugin package lane, which installs the candidate OpenClaw package, installs the Codex plugin from `codex_plugin_spec` or a same-ref tarball with explicit Codex CLI install approval, runs Codex CLI preflight and same-session agent turns, then runs a zero-retry medium-thinking turn that sends progress, reads randomized workspace inputs, writes their exact artifact, and sends completion. `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes.

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
- extension production changes run extension prod and extension test typecheck plus extension lint;
- extension test-only changes run extension test typecheck plus extension lint;
- bundled channel manifests, package metadata, config schemas, UI hints, and generator owners also run the bundled channel config metadata drift check;
- public Plugin SDK or plugin-contract changes expand to extension typecheck because extensions depend on those core contracts (Vitest extension sweeps stay explicit test work);
- release metadata-only version bumps run targeted version/config/root-dependency checks;
- unknown root/config changes fail safe to all check lanes.

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
one-shot Testboxes. The built-in sync sanity check fails fast when
`git status --short` on the synced box shows at least 200 tracked deletions,
which catches disappearing root files such as `pnpm-lock.yaml`. For intentional
large-deletion PRs, set `CRABBOX_ALLOW_MASS_DELETIONS=1` for the remote command.

Crabbox also terminates a local Blacksmith CLI invocation that stays in the
sync phase for more than five minutes without post-sync output. Set
`CRABBOX_BLACKSMITH_SYNC_TIMEOUT_MS=0` to disable that guard, or use a larger
millisecond value for unusually large local diffs.

Before a first run, check the wrapper from the repo root:

```bash
node scripts/crabbox-wrapper.mjs run --help | sed -n '1,120p'
```

The repo wrapper refuses a stale Crabbox binary that does not advertise the selected provider, and Blacksmith-backed runs require Crabbox 0.22.0 or newer so the wrapper gets the current Testbox sync, queue, and cleanup behavior. In Codex worktrees or linked/sparse checkouts, avoid the local `pnpm crabbox:run` script because pnpm may reconcile dependencies before Crabbox starts; invoke the node wrapper directly instead:

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

Reuse the lease, not stale source. Omit `--no-sync` so each run uploads the
current checkout; use it only to rerun an unchanged, already-synced tree
intentionally. Untrusted contributor/fork code must use
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
