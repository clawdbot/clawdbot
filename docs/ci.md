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
at the trigger), on non-draft pull requests (CHANGELOG-only diffs are ignored),
and on manual dispatch. Canonical `main` pushes first pass through a 90-second
hosted-runner admission window; the `CI` concurrency group cancels that waiting
run when a newer commit lands, so sequential merges do not each register a full
Blacksmith matrix. Pull requests and manual dispatches skip the wait. The
`preflight` job then classifies the diff and turns expensive lanes off when
only unrelated areas changed. Manual `workflow_dispatch` runs intentionally
bypass smart scoping and fan out the full graph for release candidates and
broad validation. Android lanes stay opt-in through `include_android` (or the
`release_gate` input). Release-only plugin coverage lives in the separate
[`Plugin Prerelease`](#plugin-prerelease) workflow and only runs from
[`Full Release Validation`](#full-release-validation) or an explicit manual
dispatch.

## Pipeline overview

| Job                                | Purpose                                                                                                                                                                                                               | When it runs                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `preflight`                        | Detect docs-only changes, changed scopes, changed extensions, and build the CI manifest                                                                                                                               | Always on non-draft pushes and PRs                  |
| `runner-admission`                 | Hosted 90-second debounce for canonical `main` pushes before Blacksmith work is registered                                                                                                                            | Every CI run; sleep only on canonical `main` pushes |
| `security-fast`                    | Private key detection, changed-workflow audit via `zizmor`, and production lockfile audit                                                                                                                             | Always on non-draft pushes and PRs                  |
| `pnpm-store-warmup`                | Warm the lockfile-pinned pnpm store cache without blocking Linux Node shards                                                                                                                                          | Node or docs-check lanes selected                   |
| `build-artifacts`                  | Build `dist/`, Control UI, built-CLI smoke checks, startup memory, and embedded built-artifact checks                                                                                                                 | Node-relevant changes                               |
| `checks-fast-core`                 | Fast Linux correctness lanes: bundled + protocol, Bun launcher, and the CI-routing fast task                                                                                                                          | Node-relevant changes                               |
| `qa-smoke-ci-profile`              | Two self-contained balanced parts of the bounded automatic QA Smoke representative set; full taxonomy coverage remains available through explicit QA profiles                                                         | Node-relevant changes                               |
| `checks-fast-contracts-plugins-*`  | Two weighted plugin contract shards                                                                                                                                                                                   | Node-relevant changes                               |
| `checks-fast-contracts-channels-*` | Two weighted channel contract shards                                                                                                                                                                                  | Node-relevant changes                               |
| `checks-node-*`                    | Core Node test shards, excluding channel, bundled, contract, and extension lanes                                                                                                                                      | Node-relevant changes                               |
| `check-*`                          | Sharded main local gate equivalent: guards, shrinkwrap, bundled-channel config metadata, prod types, lint, dependencies, test types                                                                                   | Node-relevant changes                               |
| `check-additional-*`               | Boundary check stripes (including prompt snapshot drift), session accessor/transcript reader/SQLite transaction boundaries, extension lint groups, package boundary compile/canary, and runtime topology architecture | Node-relevant changes                               |
| `checks-node-compat-node22`        | Node 22 compatibility build and smoke lane                                                                                                                                                                            | Manual CI dispatch for releases                     |
| `check-docs`                       | Docs formatting, lint, and broken-link checks                                                                                                                                                                         | Docs changed (PRs and manual dispatch)              |
| `native-i18n`                      | Native app, Android, and Apple i18n inventory checks                                                                                                                                                                  | Native i18n-relevant changes                        |
| `skills-python`                    | Ruff + pytest for Python-backed skills                                                                                                                                                                                | Python-skill-relevant changes                       |
| `checks-windows`                   | Windows-specific process/path tests plus shared runtime import specifier regressions                                                                                                                                  | Windows-relevant changes                            |
| `macos-node`                       | Focused macOS TypeScript tests: launchd, Homebrew, runtime paths, packaging scripts, process-group wrapper                                                                                                            | macOS-relevant changes                              |
| `macos-swift`                      | Swift lint, build, and tests for the macOS app                                                                                                                                                                        | macOS-relevant changes                              |
| `ios-build`                        | Xcode project generation plus the iOS app simulator build                                                                                                                                                             | iOS app, shared app kit, or Swabble changes         |
| `android`                          | Android unit tests for both flavors plus one debug APK build                                                                                                                                                          | Android-relevant changes                            |
| `test-performance-agent`           | Separate workflow: daily Codex slow-test optimization after trusted activity                                                                                                                                          | Main CI success or manual dispatch                  |
| `openclaw-performance`             | Separate workflow: daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.6 live lanes                                                                                          | Scheduled and manual dispatch                       |

## Fail-fast order

1. `runner-admission` waits only for canonical `main` pushes; a newer push cancels the run before Blacksmith registration.
2. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs.
3. `security-fast`, `check-*`, `check-additional-*`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
4. `build-artifacts` overlaps with the fast Linux lanes so downstream consumers can start as soon as the shared build is ready.
5. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-plugins-*`, `checks-fast-contracts-channels-*`, `checks-node-*`, `checks-windows`, `macos-node`, `macos-swift`, `ios-build`, and `android`.

GitHub may mark superseded jobs as `cancelled` when a newer push lands on the same PR or `main` ref. Treat that as CI noise unless the newest run for the same ref is also failing. Matrix jobs use `fail-fast: false`, and `build-artifacts` reports embedded channel, core-support-boundary, and gateway-watch failures directly instead of queuing tiny verifier jobs. The automatic CI concurrency key is versioned (`CI-v7-*`) so a GitHub-side zombie in an old queue group cannot indefinitely block newer main runs. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs. The plugin-list startup-memory guard keeps a 350 MiB ceiling on self-hosted Blacksmith Linux and allows 425 MiB on GitHub-hosted Linux, whose RSS baseline is higher for the same built CLI.

Use `pnpm ci:timings`, `pnpm ci:timings:recent`, or `node scripts/ci-run-timings.mjs <run-id>` to summarize wall time, queue time, slowest jobs, failures, and the `pnpm-store-warmup` fanout barrier from GitHub Actions. The in-workflow `ci-timings-summary` job exists in `ci.yml` but is currently disabled (`if: false`); run the timing helper locally instead. For build timing, check the `build-artifacts` job's `Build dist` step: `pnpm build:ci-artifacts` prints `[build-all] phase timings:` and includes `ui:build`; the job also uploads the `startup-memory` artifact.

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

## Scope and routing

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`. Manual dispatch skips changed-scope detection and makes the preflight manifest act as if every scoped area changed.

- **CI workflow edits** validate the Node CI graph, workflow linting, and the Windows lane (`ci.yml` executes it), but do not force iOS, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
- **Workflow Sanity** runs `actionlint`, `zizmor` over all workflow YAML files, the composite-action interpolation guard, and the conflict-marker guard. The PR-scoped `security-fast` job also runs `zizmor` over changed workflow files so workflow security findings fail early in the main CI graph.
- **Docs on `main` pushes** are checked by the standalone `Docs` workflow with the same ClawHub docs mirror used by CI, so mixed code+docs pushes do not also queue the CI `check-docs` shard. Pull requests and manual CI still run `check-docs` from CI when docs changed.
- **TUI PTY** runs in the `checks-node-core-runtime-tui-pty` Linux Node shard for TUI changes. The shard runs `test/vitest/vitest.tui-pty.config.ts` with `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1`, so it covers both the deterministic `TuiBackend` fixture lane and the slower `tui --local` smoke that mocks only the external model endpoint.
- **CI routing-only edits, the small set of core-test fixtures the fast task runs directly, and narrow plugin contract helper edits** use a fast Node-only manifest path: `preflight`, `security-fast`, and only the fast lanes the change touches — a single `checks-fast-core` CI-routing task, the two plugin contract shards, or both. That path skips build artifacts, Node 22 compatibility, channel contracts, full core shards, bundled-plugin shards, and additional guard matrices.
- **Windows Node checks** are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes.

The slowest Node test families are split or balanced so each job stays small without over-reserving runners:

- Plugin contracts and channel contracts each run as two weighted Blacksmith-backed shards with the standard GitHub runner fallback.
- Core unit fast/support lanes run separately; core runtime infra splits into process, shared, hooks, secrets, and three cron domain shards.
- Auto-reply runs as balanced workers, with the reply subtree split into agent-runner, commands, dispatch, session, and state-routing shards.
- Agentic gateway/server (control-plane) configs split across chat, auth, model, HTTP/plugin, runtime, and startup lanes instead of waiting on built artifacts.
- Normal CI packs only isolated infra include-pattern shards into deterministic bundles of at most 64 test files, reducing the Node matrix without merging non-isolated command/cron, stateful agents-core, or gateway/server suites. Heavy fixed suites stay on 8 vCPU while the bundled and lower-weight lanes use 4 vCPU.
- Pull requests on the canonical repository use a compact admission plan: the same per-config groups run in isolated subprocesses, currently 19 Node test jobs instead of the 74-job full matrix. A single whole-config batch is spread across existing same-runner compact jobs while retaining its 120-minute timeout, and the serial tooling config is striped across three PR-only groups; `main` pushes, manual dispatches, and release gates retain the full matrix.
- Broad browser, QA, media, and miscellaneous plugin tests use their dedicated Vitest configs instead of the shared plugin catch-all. Include-pattern shards record timing entries using the CI shard name, so `.artifacts/vitest-shard-timings.json` can distinguish a whole config from a filtered shard.
- `check-additional-*` stripes the supplemental boundary guard list (`scripts/run-additional-boundary-checks.mjs`) into one prompt-heavy shard (`check-additional-boundaries-a`, which includes the Codex prompt snapshot drift check) and one combined shard for the remaining stripes (`check-additional-boundaries-bcd`), each running independent guards concurrently and printing per-check timings. Package-boundary compile/canary work stays together, and runtime topology architecture runs separately from the gateway watch coverage embedded in `build-artifacts`.
- Gateway watch, channel tests, and the core support-boundary shard run concurrently inside `build-artifacts` after `dist/` and `dist-runtime/` are already built.

Once admitted, canonical Linux CI permits up to 28 concurrent Node test jobs and
12 for the smaller fast/check lanes; Windows and Android stay at two because
those runner pools are narrower. Compact whole-config batches run with a
120-minute batch timeout, while include-pattern groups share the same bounded
job budget.

Android CI runs both `testPlayDebugUnitTest` and `testThirdPartyDebugUnitTest` and then builds the Play debug APK. The third-party flavor has no separate source set or manifest; its unit-test lane still compiles the flavor with the SMS/call-log BuildConfig flags, while avoiding a duplicate debug APK packaging job on every Android-relevant push.

The `check-dependencies` shard runs `pnpm deadcode:dependencies` (a production Knip dependency-only pass pinned to an exact Knip version, with pnpm's minimum release age disabled for the `dlx` install) and `pnpm deadcode:unused-files`, which compares Knip's production unused-file findings against `scripts/deadcode-unused-files.allowlist.mjs`, plus an advisory `pnpm deadcode:report:ci:ts-unused` report uploaded as the `deadcode-reports` artifact. The unused-file guard fails when a PR adds a new unreviewed unused file or leaves a stale allowlist entry, while preserving intentional dynamic plugin, generated, build, live-test, and package bridge surfaces that Knip cannot resolve statically.

## ClawSweeper activity forwarding

`.github/workflows/clawsweeper-dispatch.yml` is the target-side bridge from OpenClaw repository activity into ClawSweeper. It does not check out or execute untrusted pull request code. The workflow creates a GitHub App token from `CLAWSWEEPER_APP_PRIVATE_KEY`, then dispatches compact `repository_dispatch` payloads to `openclaw/clawsweeper`.

The workflow has four lanes:

- `clawsweeper_item` for exact issue and pull request review requests;
- `clawsweeper_comment` for explicit ClawSweeper commands in issue comments;
- `clawsweeper_commit_review` for commit-level review requests on `main` pushes;
- `github_activity` for general GitHub activity that the ClawSweeper agent may inspect.

The `github_activity` lane forwards normalized metadata only: event type, action, actor, repository, item number, URL, title, state, and short excerpts for comments or reviews when present. It intentionally avoids forwarding the full webhook body. The receiving workflow in `openclaw/clawsweeper` is `.github/workflows/github-activity.yml`, which posts the normalized event to the OpenClaw Gateway hook for the ClawSweeper agent.

General activity is observation, not delivery-by-default. The ClawSweeper agent receives the Discord target in its prompt and should post to `#clawsweeper` only when the event is surprising, actionable, risky, or operationally useful. Routine opens, edits, bot churn, duplicate webhook noise, and normal review traffic should result in `NO_REPLY`.

Treat GitHub titles, comments, bodies, review text, branch names, and commit messages as untrusted data throughout this path. They are input for summarization and triage, not instructions for the workflow or agent runtime.

## Manual dispatches

Manual CI dispatches run the same job graph as normal CI but force every non-Android scoped lane on: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, iOS build, and Control UI i18n. Standalone manual CI dispatches run Android only with `include_android=true` (the `release_gate` input also forces Android); the full release umbrella enables Android by passing `include_android=true`. Plugin prerelease static checks, the release-only `agentic-plugins` shard, the full extension batch sweep, and plugin prerelease Docker lanes are excluded from CI. The Docker prerelease suite runs only when `Full Release Validation` dispatches the separate `Plugin Prerelease` workflow with the release-validation gate enabled.

Manual runs use a unique concurrency group so a release-candidate full suite is not cancelled by another push or PR run on the same ref. The optional `target_ref` input lets a trusted caller run that graph against a branch, tag, or full commit SHA while using the workflow file from the selected dispatch ref. The `release_gate` input is an exact-SHA maintainer fallback for capacity-stalled PR CI: it requires `target_ref` to be a full commit SHA that matches the dispatched branch head.

```bash
gh workflow run ci.yml --ref release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha> -f include_android=true
gh workflow run full-release-validation.yml --ref main -f ref=<branch-or-sha>
```

The monthly npm-only extended-stable path is the exception: dispatch both `OpenClaw NPM
Release` preflight and `Full Release Validation` from the exact
`extended-stable/YYYY.M.33` branch, preserve their run IDs, and pass both IDs to the
direct npm publish run. See [Monthly npm-only extended-stable
publication](/reference/RELEASING#monthly-npm-only-extended-stable-publication) for
the commands, exact identity requirements, registry readback, and selector
repair procedure. This path does not dispatch plugin, macOS, Windows, GitHub
Release, private dist-tag, or other platform publication.

## Runners

| Runner                          | Jobs                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                  | Manual CI dispatch and non-canonical repository fallbacks, the QA Smoke aggregate, CodeQL security and quality scans, workflow-sanity, labeler, auto-response, the standalone Docs workflow, and the whole Install Smoke workflow                                                                  |
| `blacksmith-4vcpu-ubuntu-2404`  | `preflight`, `security-fast`, `pnpm-store-warmup`, `native-i18n`, `checks-fast-core` except QA Smoke CI, plugin/channel contract shards, most bundled/lower-weight Linux Node shards, `check-*` lanes except `check-lint`, selected `check-additional-*` shards, `check-docs`, and `skills-python` |
| `blacksmith-8vcpu-ubuntu-2404`  | Retained heavy Linux Node suites, boundary/extension-heavy `check-additional-*` shards, and `android`                                                                                                                                                                                              |
| `blacksmith-16vcpu-ubuntu-2404` | Automatic QA Smoke CI shards, `build-artifacts` in CI and Testbox, and `check-lint` (CPU-sensitive enough that 8 vCPU cost more than they saved)                                                                                                                                                   |
| `blacksmith-8vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                   |
| `blacksmith-6vcpu-macos-15`     | `macos-node` on `openclaw/openclaw`; forks fall back to `macos-15`                                                                                                                                                                                                                                 |
| `blacksmith-12vcpu-macos-26`    | `macos-swift` and `ios-build` on `openclaw/openclaw`; forks fall back to `macos-26`                                                                                                                                                                                                                |

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

Canonical-repo CI keeps Blacksmith as the default runner path for normal push and pull-request runs. `workflow_dispatch` and non-canonical repository runs use GitHub-hosted runners, but normal canonical runs do not currently probe Blacksmith queue health or automatically fall back to GitHub-hosted labels when Blacksmith is unavailable.

## Local equivalents

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
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs                               # docs format + lint + broken links
pnpm build                                    # build dist when CI artifact/smoke checks matter
pnpm ios:build                                # generate and build the iOS app project
pnpm ci:timings                               # summarize the latest origin/main push CI run
pnpm ci:timings:recent                        # compare recent successful main CI runs
node scripts/ci-run-timings.mjs <run-id>      # summarize wall time, queue time, and slowest jobs
node scripts/ci-run-timings.mjs --latest-main # ignore issue/comment noise and choose origin/main push CI
node scripts/ci-run-timings.mjs --recent 10   # compare recent successful main CI runs
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

`Full Release Validation` is the manual umbrella workflow for "run everything before release." It accepts a branch, tag, or full commit SHA, dispatches the manual `CI` workflow with that target (including Android), dispatches `Plugin Prerelease` for release-only plugin/package/static/Docker proof, dispatches `OpenClaw Performance` against the target SHA, and dispatches `OpenClaw Release Checks` for install smoke, package acceptance, cross-OS package checks, QA Lab parity, Matrix, and Telegram lanes (advisory maturity scorecard rendering is opt-in via `run_maturity_scorecard`). Stable and full profiles always include exhaustive live/E2E and Docker release-path soak coverage; the beta profile can opt in with `run_release_soak=true`. The canonical package Telegram E2E runs inside Package Acceptance, so a full candidate does not start a duplicate live poller. After publishing, pass `release_package_spec` to reuse the shipped npm package across release checks, Package Acceptance, Docker, cross-OS, and Telegram without rebuilding. Use `npm_telegram_package_spec` only for a focused published-package Telegram rerun. The Codex plugin live package lane uses the same selected state by default: published `release_package_spec=openclaw@<tag>` derives `codex_plugin_spec=npm:@openclaw/codex@<tag>`, while SHA/artifact runs pack `extensions/codex` from the selected ref. Set `codex_plugin_spec` explicitly for custom plugin sources such as `npm:`, `npm-pack:`, or `git:` specs.

See [Full release validation](/reference/full-release-validation) for the
stage matrix, exact workflow job names, profile differences, artifacts, and
focused rerun handles.

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
pnpm ci:full-release --sha <full-sha>
```

GitHub workflow dispatch refs must be branches or tags, not raw commit SHAs. The
helper pushes a temporary `release-ci/<sha>-...` branch at a trusted `main`
workflow SHA, passes the requested target SHA through the workflow `ref` input,
reuses strict exact-target evidence when available, verifies every child
workflow `headSha` matches the trusted workflow SHA, and deletes the temporary
branch when the run completes. Pass `-f reuse_evidence=false` to force fresh
validation. The umbrella verifier also fails if any child workflow ran at a
different workflow SHA.

`release_profile` controls live/provider breadth passed into release checks. The
manual release workflows default to `stable`; use `full` only when you
intentionally want the broad advisory provider/media matrix. Stable and full
release checks always run the exhaustive live/E2E and Docker release-path soak;
the beta profile can opt in with `run_release_soak=true`.

- `minimum` keeps the fastest OpenAI/core release-critical lanes.
- `stable` adds the stable provider/backend set.
- `full` runs the broad advisory provider/media matrix.

The umbrella records the dispatched child run ids, and the final `Verify full validation` job re-checks current child run conclusions and appends slowest-job tables for each child run. If a child workflow is rerun and turns green, rerun only the parent verifier job to refresh the umbrella result and timing summary.

For recovery, both `Full Release Validation` and `OpenClaw Release Checks` accept `rerun_group`. Use `all` for a release candidate, `ci` for only the normal full CI child, `plugin-prerelease` for only the plugin prerelease child, `performance` for only the OpenClaw Performance child, `release-checks` for every release child, or a narrower group: `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa`, `qa-parity`, `qa-live`, or `npm-telegram` on the umbrella. This keeps a failed release box rerun bounded after a focused fix. For one failed cross-OS lane, combine `rerun_group=cross-os` with `cross_os_suite_filter`, for example `windows/packaged-upgrade`; long cross-OS commands emit heartbeat lines and packaged-upgrade summaries include per-phase timings. QA release-check lanes are advisory except the standard runtime tool coverage gate, which blocks when required OpenClaw dynamic tools drift or disappear from the standard tier summary.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the selected ref once into a `release-package-under-test` tarball, then passes that artifact to cross-OS checks and Package Acceptance, plus the live/E2E release-path Docker workflow when soak coverage runs. That keeps the package bytes consistent across release boxes and avoids repacking the same candidate in multiple child jobs. For the Codex npm-plugin live lane, release checks either pass a matching published plugin spec derived from `release_package_spec`, pass the operator-supplied `codex_plugin_spec`, or leave the input blank so the Docker script packs the selected checkout's Codex plugin.

Duplicate `Full Release Validation` runs for `ref=main` and `rerun_group=all`
supersede the older umbrella. The parent monitor cancels any child workflow it
has already dispatched when the parent is cancelled, so newer main validation
does not sit behind a stale two-hour release-check run. Release branch/tag
validation and focused rerun groups keep `cancel-in-progress: false`.

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

The native live media shards run in `ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, built by the `Live Media Runner Image` workflow. That image preinstalls `ffmpeg` and `ffprobe`; media jobs only verify the binaries before setup. Keep Docker-backed live suites on normal Blacksmith runners — container jobs are the wrong place to launch nested Docker tests.

Docker-backed live model/backend shards use a separate shared `ghcr.io/openclaw/openclaw-live-test:<sha>-<extensions>` image per selected commit. The live release workflow builds and pushes that image once, then the Docker live model, provider-sharded gateway, CLI backend, ACP bind, and Codex harness shards run with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Gateway Docker shards carry explicit script-level `timeout` caps below the workflow job timeout so a stuck container or cleanup path fails fast instead of consuming the whole release-check budget. If those shards rebuild the full source Docker target independently, the release run is misconfigured and will waste wall clock on duplicate image builds.

## Package Acceptance

Use `Package Acceptance` when the question is "does this installable OpenClaw package work as a product?" It is different from normal CI: normal CI validates the source tree, while package acceptance validates a single tarball through the same Docker E2E harness users exercise after install or update.

### Jobs

1. `resolve_package` checks out `workflow_ref`, resolves one package candidate, writes `.artifacts/docker-e2e-package/openclaw-current.tgz`, writes `.artifacts/docker-e2e-package/package-candidate.json`, uploads both as the `package-under-test` artifact, and prints the source, workflow ref, package ref, version, SHA-256, and profile in the GitHub step summary.
2. `package_integrity` downloads the `package-under-test` artifact and enforces the public package tarball contract with `scripts/check-openclaw-package-tarball.mjs`.
3. `docker_acceptance` calls `openclaw-live-and-e2e-checks-reusable.yml` with the resolved package source SHA (falling back to `workflow_ref`) and `package_artifact_name=package-under-test`. The reusable workflow downloads that artifact, validates the tarball inventory, prepares package-digest Docker images when needed, and runs the selected Docker lanes against that package instead of packing the workflow checkout. When a profile selects multiple targeted `docker_lanes`, the reusable workflow prepares the package and shared images once, then fans those lanes out as parallel targeted Docker jobs with unique artifacts.
4. `package_telegram` optionally calls `NPM Telegram Beta E2E`. It runs when `telegram_mode` is not `none` and installs the same `package-under-test` artifact when Package Acceptance resolved one; standalone Telegram dispatch can still install a published npm spec.
5. `summary` fails the workflow if package resolution, integrity, Docker acceptance, or the optional Telegram lane failed. The `advisory` input downgrades acceptance failures to warnings for advisory callers.

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

The `published-upgrade-survivor` Docker lane validates one published package baseline per run in the blocking release path. In Package Acceptance, the resolved `package-under-test` tarball is always the candidate and `published_upgrade_survivor_baseline` selects the fallback published baseline, defaulting to `openclaw@latest`; failed-lane rerun commands preserve that baseline. Full Release Validation with `run_release_soak=true` or `release_profile=full` sets `published_upgrade_survivor_baselines='last-stable-4 2026.4.23 2026.5.2 2026.4.15'` and `published_upgrade_survivor_scenarios=reported-issues` to expand across the four latest stable npm releases plus pinned plugin-compatibility boundary releases and issue-shaped fixtures for Feishu config, preserved bootstrap/persona files, configured OpenClaw plugin installs, tilde log paths, and stale legacy plugin dependency roots. Multi-baseline published-upgrade survivor selections are sharded by baseline into separate targeted Docker runner jobs. The separate `Update Migration` workflow uses the `update-migration` Docker lane with `all-since-2026.4.23` baselines and `plugin-deps-cleanup` scenarios when the question is exhaustive published update cleanup, not normal Full Release CI breadth. Local aggregate runs can pass exact package specs with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, keep a single lane with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC` such as `openclaw@2026.4.15`, or set `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` for the scenario matrix. The published lane configures the baseline with a baked `openclaw config set` command recipe, records recipe steps in `summary.json`, and probes `/healthz`, `/readyz`, plus RPC status after Gateway start. The Windows packaged and installer fresh lanes also verify that an installed package can import a browser-control override from a raw absolute Windows path. The OpenAI cross-OS agent-turn smoke defaults to `OPENCLAW_CROSS_OS_OPENAI_MODEL` when set, otherwise `openai/gpt-5.6-luna`, so the install and gateway proof uses the lower-cost GPT-5.6 test tier.

### Legacy compatibility windows

Package Acceptance has bounded legacy-compatibility windows for already-published packages. Packages through `2026.4.25`, including `2026.4.25-beta.*`, may use the compatibility path:

- known private QA entries in `dist/postinstall-inventory.json` may point at tarball-omitted files;
- `doctor-switch` may skip the `gateway install --wrapper` persistence subcase when the package does not expose that flag;
- `update-channel-switch` may prune missing pnpm `patchedDependencies` from the tarball-derived fake git fixture and may log missing persisted `update.channel`;
- plugin smokes may read legacy install-record locations or accept missing marketplace install-record persistence;
- `plugin-update` may allow config metadata migration while still requiring the install record and no-reinstall behavior to stay unchanged.

The published `2026.4.26` package may also warn for local build metadata stamp files that were already shipped, and packages through `2026.5.20` may warn instead of fail when `npm-shrinkwrap.json` is missing. Later packages must satisfy the modern contracts; the same conditions fail instead of warn or skip.

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

The slow Bun global install image-provider smoke is separately gated by `run_bun_global_install_smoke`. It runs on the nightly schedule, defaults on for workflow calls from release checks, and manual `Install Smoke` dispatches can opt into it. Normal PR CI still runs the fast Bun launcher regression lane for Node-relevant changes. QR and installer Docker tests keep their own install-focused Dockerfiles.

## Local Docker E2E

`pnpm test:docker:all` prebuilds one shared live-test image, packs OpenClaw once as an npm tarball, and builds two shared `scripts/e2e/Dockerfile` images:

- a bare Node/Git runner for installer/update/plugin-dependency lanes;
- a functional image that installs the same tarball into `/app` for normal functionality lanes.

Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mjs`, planner logic lives in `scripts/lib/docker-e2e-plan.mjs`, and the runner only executes the selected plan. The scheduler selects the image per lane with `OPENCLAW_DOCKER_E2E_BARE_IMAGE` and `OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`, then runs lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1`.

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

Current release Docker chunks are `core`, `package-update-openai`, `package-update-anthropic`, `package-update-core`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`. `package-update-openai` includes the live Codex plugin package lane, which installs the candidate OpenClaw package, installs the Codex plugin from `codex_plugin_spec` or a same-ref tarball with explicit Codex CLI install approval, runs Codex CLI preflight, then runs multiple same-session OpenClaw agent turns against OpenAI. `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes.

OpenWebUI runs as a standalone `openwebui` chunk on a dedicated large-disk Blacksmith runner whenever stable or full release-path coverage requests it, even when the reusable workflow routes supported jobs to GitHub-hosted runners. Keeping the external image pull separate prevents the large image from competing with the shared package and plugin images in `plugins-runtime-services`; legacy aggregate plugin/runtime chunks still include OpenWebUI for compatible manual reruns. Bundled-channel update lanes retry once for transient npm network failures.

Each chunk uploads `.artifacts/docker-tests/` with lane logs, timings, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, slow-lane tables, and per-lane rerun commands. The workflow `docker_lanes` input runs selected lanes against images prepared for that run instead of the chunk jobs, which keeps failed-lane debugging bounded to one targeted Docker job; if a selected lane is a live Docker lane, the targeted job builds the live-test image locally for that rerun. The rerun helper validates the failure artifact's exact selected target SHA and manual dispatch repacks that ref, because the internal reusable-workflow package tuple is not part of the `workflow_dispatch` schema. Generated commands include prepared image inputs and `shared_image_policy=existing-only` only when those inputs are GHCR-backed; runner-local artifact tags are omitted so a fresh runner rebuilds them. An explicit target override drops recovered GHCR image refs unless the artifact proves they match the override. Artifact-generated workflow-definition refs are also omitted because full-release temporary branches are deleted; dispatch uses the repository default branch unless the operator explicitly overrides it.

```bash
pnpm test:docker:rerun <run-id>      # download Docker artifacts and print combined/per-lane targeted rerun commands
pnpm test:docker:timings <summary>   # slow-lane and phase critical-path summaries
```

The scheduled live/E2E workflow runs the full release-path Docker suite daily and, after it succeeds, invokes the explicit publisher for the exact tested image artifacts.

## Plugin Prerelease

`Plugin Prerelease` is more expensive product/package coverage, so it is a separate workflow dispatched by `Full Release Validation` or by an explicit operator. Normal pull requests, `main` pushes, and standalone manual CI dispatches keep that suite off. It balances bundled plugin tests across eight extension workers; those extension shard jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap so import-heavy plugin batches do not create extra CI jobs. The release-only Docker prerelease path (enabled by the `full_release_validation` input) batches targeted Docker lanes in groups of four to avoid reserving dozens of runners for one-to-three-minute jobs. The workflow also uploads an informational `plugin-inspector-advisory` artifact from `@openclaw/plugin-inspector`; inspector findings are triage input and do not change the blocking Plugin Prerelease gate.

## QA Lab

QA Lab has dedicated CI lanes outside the main smart-scoped workflow. Agentic parity is nested under the broad QA and release harnesses, not a standalone PR workflow. Use `Full Release Validation` with `rerun_group=qa-parity` when parity should ride with a broad validation run.

- The `QA-Lab - All Lanes` workflow runs nightly on `main` and on manual dispatch; it fans out the mock parity lane, live Matrix lane, and live Telegram and Discord lanes as parallel jobs. Live jobs use the `qa-live-shared` environment, and Telegram/Discord use Convex leases.

Release checks run Matrix and Telegram live transport lanes with the deterministic mock provider and mock-qualified models (`mock-openai/gpt-5.6-luna` and `mock-openai/gpt-5.6-luna-alt`) so the channel contract is isolated from live model latency and normal provider-plugin startup. The live transport gateway disables memory search because QA parity covers memory behavior separately; provider connectivity is covered by the separate live model, native provider, and Docker provider suites.

Matrix uses `--profile fast` for scheduled and release gates, adding `--fail-fast` only when the checked-out CLI supports it. The CLI default and manual workflow input remain `all`; manual `matrix_profile=all` dispatch always shards full Matrix coverage into `transport`, `media`, `e2ee-smoke`, `e2ee-deep`, and `e2ee-cli` jobs.

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

The `Docs Agent` workflow is an event-driven Codex maintenance lane for keeping existing docs aligned with recently landed changes. It has no pure schedule: a successful non-bot push CI run on `main` can trigger it, and manual dispatch can run it directly. Workflow-run invocations skip when `main` has moved on or when another non-skipped Docs Agent run was created in the last hour. When it runs, it reviews the commit range from the previous non-skipped Docs Agent source SHA to current `main`, so one hourly run can cover all main changes accumulated since the last docs pass.

### Test Performance Agent

The `Test Performance Agent` workflow is an event-driven Codex maintenance lane for slow tests. It has no pure schedule: a successful non-bot push CI run on `main` can trigger it, but it skips if another workflow-run invocation already ran or is running that UTC day. Manual dispatch bypasses that daily activity gate. The lane builds a full-suite grouped Vitest performance report, lets Codex make only small coverage-preserving test performance fixes instead of broad refactors, then reruns the full-suite report and rejects changes that reduce the passing baseline test count. The grouped report records per-config wall time and max RSS on Linux and macOS, so the before/after comparison surfaces test memory deltas beside duration deltas. If the baseline has failing tests, Codex may fix only obvious failures and the after-agent full-suite report must pass before anything is committed. When `main` advances before the bot push lands, the lane rebases the validated patch, reruns `pnpm check:changed`, and retries the push; conflicting stale patches are skipped. It uses GitHub-hosted Ubuntu so the Codex action can keep the same drop-sudo safety posture as the docs agent.

### Duplicate PRs After Merge

The `Duplicate PRs After Merge` workflow is a manual maintainer workflow for post-land duplicate cleanup. It defaults to dry-run and only closes explicitly listed PRs when `apply=true`. Before mutating GitHub, it verifies that the landed PR is merged and that each duplicate has either a shared referenced issue or overlapping changed hunks.

```bash
gh workflow run duplicate-after-merge.yml \
  -f landed_pr=70532 \
  -f duplicate_prs='70530,70592' \
  -f apply=true
```

## Local check gates and changed routing

Local changed-lane logic lives in `scripts/changed-lanes.mjs` and is executed by `scripts/check-changed.mjs`. That local check gate is stricter about architecture boundaries than the broad CI platform scope:

- core production changes run core prod and core test typecheck plus core lint/guards;
- core test-only changes run only core test typecheck plus core lint;
- extension production changes run extension prod and extension test typecheck plus extension lint;
- extension test-only changes run extension test typecheck plus extension lint;
- public Plugin SDK or plugin-contract changes expand to extension typecheck because extensions depend on those core contracts (Vitest extension sweeps stay explicit test work);
- release metadata-only version bumps run targeted version/config/root-dependency checks;
- unknown root/config changes fail safe to all check lanes.

Local changed-test routing lives in `scripts/test-projects.test-support.mjs` and is intentionally cheaper than `check:changed`: direct test edits run themselves, source edits prefer explicit mappings, then sibling tests and import-graph dependents. Shared group-room delivery config is one of the explicit mappings: changes to the group visible-reply config, source reply delivery mode, or the message-tool system prompt route through the core reply tests plus Discord and Slack delivery regressions so a shared default change fails before the first PR push. Use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when the change is harness-wide enough that the cheap mapped set is not a trustworthy proxy.

## Testbox validation

Crabbox is the repo-owned remote-box wrapper for maintainer Linux proof. Agent
sessions use it by default for tests and computationally intensive work,
including builds, typechecks, lint fan-out, Docker, package lanes, E2E, live
proof, and CI parity. Trusted maintainer code defaults to
`blacksmith-testbox`, and `.crabbox.yaml` now defaults to it. Its configured
workflow hydrates provider and agent credentials, so untrusted contributor or
fork code must use secretless fork CI or sanitized direct AWS Crabbox instead.
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

At the start of a trusted code task likely to need tests or heavy proof, agents
should pre-warm immediately in a background command session, continue
inspection and editing while hydration runs, reuse the returned `tbx_...` id,
sync the current checkout on every run, and stop it before handoff:

```bash
node scripts/crabbox-wrapper.mjs warmup --provider blacksmith-testbox --keep --timing-json
```

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
pnpm crabbox:run -- --help | sed -n '1,120p'
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

The `blacksmith:` block in `.crabbox.yaml` already pins the org, workflow, job, and ref defaults, so the explicit flags below are optional. Changed gate:

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

Focused test rerun:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm test <path-or-filter>"
```

Full suite:

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
