---
summary: "CI job graph, scope gates, release umbrellas, and local command equivalents"
title: "CI pipeline"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging a failing GitHub Actions check
  - You are coordinating a release validation run or rerun
  - You are changing ClawSweeper dispatch or GitHub activity forwarding
---

OpenClaw CI runs on every push to `main` and every pull request. The `preflight` job classifies the diff and turns expensive lanes off when only unrelated areas changed. Manual `workflow_dispatch` runs intentionally bypass smart scoping and fan out the full graph for release candidates and broad validation. Android lanes stay opt-in through `include_android`. Release-only plugin coverage lives in the separate [`Plugin Prerelease`](#plugin-prerelease) workflow and only runs from [`Full Release Validation`](#full-release-validation) or an explicit manual dispatch.

## Pipeline overview

| Job                              | Purpose                                                                                                             | When it runs                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `preflight`                      | Detect docs-only changes, changed scopes, changed extensions, and build the CI manifest                             | Always on non-draft pushes and PRs |
| `security-scm-fast`              | Private key detection and workflow audit via `zizmor`                                                               | Always on non-draft pushes and PRs |
| `security-dependency-audit`      | Dependency-free production lockfile audit against npm advisories                                                    | Always on non-draft pushes and PRs |
| `security-fast`                  | Required aggregate for the fast security jobs                                                                       | Always on non-draft pushes and PRs |
| `check-dependencies`             | Production Knip dependency-only pass plus the unused-file allowlist guard                                           | Node-relevant changes              |
| `build-artifacts`                | Build `dist/`, Control UI, built-artifact checks, and reusable downstream artifacts                                 | Node-relevant changes              |
| `checks-fast-core`               | Fast Linux correctness lanes such as bundled/plugin-contract/protocol checks                                        | Node-relevant changes              |
| `checks-fast-contracts-channels` | Sharded channel contract checks with a stable aggregate check result                                                | Node-relevant changes              |
| `checks-node-core-test`          | Core Node test shards, excluding channel, bundled, contract, and extension lanes                                    | Node-relevant changes              |
| `check`                          | Sharded main local gate equivalent: prod types, lint, guards, test types, and strict smoke                          | Node-relevant changes              |
| `check-additional`               | Architecture, boundary, prompt snapshot drift, extension-surface guards, package-boundary, and gateway-watch shards | Node-relevant changes              |
| `build-smoke`                    | Built-CLI smoke tests and startup-memory smoke                                                                      | Node-relevant changes              |
| `checks`                         | Verifier for built-artifact channel tests                                                                           | Node-relevant changes              |
| `checks-node-compat-node22`      | Node 22 compatibility build and smoke lane                                                                          | Manual CI dispatch for releases    |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                                       | Docs changed                       |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                                              | Python-skill-relevant changes      |
| `checks-windows`                 | Windows-specific process/path tests plus shared runtime import specifier regressions                                | Windows-relevant changes           |
| `macos-node`                     | macOS TypeScript test lane using the shared built artifacts                                                         | macOS-relevant changes             |
| `macos-swift`                    | Swift lint, build, and tests for the macOS app                                                                      | macOS-relevant changes             |
| `android`                        | Android unit tests for both flavors plus one debug APK build                                                        | Android-relevant changes           |
| `test-performance-agent`         | Daily Codex slow-test optimization after trusted activity                                                           | Main CI success or manual dispatch |
| `openclaw-performance`           | Daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.4 live lanes           | Scheduled and manual dispatch      |

## Fail-fast order

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs.
2. `security-scm-fast`, `security-dependency-audit`, `security-fast`, `check`, `check-additional`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
3. `build-artifacts` overlaps with the fast Linux lanes so downstream consumers can start as soon as the shared build is ready.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-channels`, `checks-node-core-test`, `checks`, `checks-windows`, `macos-node`, `macos-swift`, and `android`.

GitHub may mark superseded jobs as `cancelled` when a newer push lands on the same PR or `main` ref. Treat that as CI noise unless the newest run for the same ref is also failing. Aggregate shard checks use `!cancelled() && always()` so they still report normal shard failures but do not queue after the whole workflow has already been superseded. The automatic CI concurrency key is versioned (`CI-v7-*`) so a GitHub-side zombie in an old queue group cannot indefinitely block newer main runs. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs.

## Scope and routing

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`. Manual dispatch skips changed-scope detection and makes the preflight manifest act as if every scoped area changed.

- **CI workflow edits** validate the Node CI graph plus workflow linting, but do not force Windows, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
- **CI routing-only edits, selected cheap core-test fixture edits, and narrow plugin contract helper/test-routing edits** use a fast Node-only manifest path: `preflight`, security, and a single `checks-fast-core` task. That path skips build artifacts, Node 22 compatibility, channel contracts, full core shards, bundled-plugin shards, and additional guard matrices when the change is limited to the routing or helper surfaces the fast task exercises directly.
- **Windows Node checks** are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes.

The slowest Node test families are split or balanced so each job stays small without over-reserving runners: channel contracts run as three weighted shards, small core unit lanes are paired, auto-reply runs as four balanced workers (with the reply subtree split into agent-runner, dispatch, and commands/state-routing shards), and agentic gateway/plugin configs are spread across the existing source-only agentic Node jobs instead of waiting on built artifacts. Broad browser, QA, media, and miscellaneous plugin tests use their dedicated Vitest configs instead of the shared plugin catch-all. Include-pattern shards record timing entries using the CI shard name, so `.artifacts/vitest-shard-timings.json` can distinguish a whole config from a filtered shard. `check-additional` keeps package-boundary compile/canary work together and separates runtime topology architecture from gateway watch coverage; the boundary guard shard runs its small independent guards concurrently inside one job, including `pnpm prompt:snapshots:check` so Codex runtime happy-path prompt drift is pinned to the PR that caused it. Gateway watch, channel tests, and the core support-boundary shard run concurrently inside `build-artifacts` after `dist/` and `dist-runtime/` are already built.

Android CI runs both `testPlayDebugUnitTest` and `testThirdPartyDebugUnitTest` and then builds the Play debug APK. The third-party flavor has no separate source set or manifest; its unit-test lane still compiles the flavor with the SMS/call-log BuildConfig flags, while avoiding a duplicate debug APK packaging job on every Android-relevant push.

The `check-dependencies` shard runs `pnpm deadcode:dependencies` (a production Knip dependency-only pass pinned to the latest Knip version, with pnpm's minimum release age disabled for the `dlx` install) and `pnpm deadcode:unused-files`, which compares Knip's production unused-file findings against `scripts/deadcode-unused-files.allowlist.mjs`. The unused-file guard fails when a PR adds a new unreviewed unused file or leaves a stale allowlist entry, while preserving intentional dynamic plugin, generated, build, live-test, and package bridge surfaces that Knip cannot resolve statically.

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

Manual CI dispatches run the same job graph as normal CI but force every non-Android scoped lane on: Linux Node shards, bundled-plugin shards, channel contracts, Node 22 compatibility, `check`, `check-additional`, build smoke, docs checks, Python skills, Windows, macOS, and Control UI i18n. Standalone manual CI dispatches run Android only with `include_android=true`; the full release umbrella enables Android by passing `include_android=true`. Plugin prerelease static checks, the release-only `agentic-plugins` shard, the full extension batch sweep, and plugin prerelease Docker lanes are excluded from CI. The Docker prerelease suite runs only when `Full Release Validation` dispatches the separate `Plugin Prerelease` workflow with the release-validation gate enabled.

Manual runs use a unique concurrency group so a release-candidate full suite is not cancelled by another push or PR run on the same ref. The optional `target_ref` input lets a trusted caller run that graph against a branch, tag, or full commit SHA while using the workflow file from the selected dispatch ref.

```bash
gh workflow run ci.yml --ref release/YYYY.M.D
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha> -f include_android=true
gh workflow run full-release-validation.yml --ref main -f ref=<branch-or-sha>
```

## Runners

| Runner                           | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                   | `preflight`, fast security jobs and aggregates (`security-scm-fast`, `security-dependency-audit`, `security-fast`), fast protocol/contract/bundled checks, sharded channel contract checks, `check` shards except lint, `check-additional` shards and aggregates, Node test aggregate verifiers, docs checks, Python skills, workflow-sanity, labeler, auto-response; install-smoke preflight also uses GitHub-hosted Ubuntu so the Blacksmith matrix can queue earlier |
| `blacksmith-4vcpu-ubuntu-2404`   | `CodeQL Critical Quality`, lower-weight extension shards, `checks-fast-core`, `checks-node-compat-node22`, `check-prod-types`, and `check-test-types`                                                                                                                                                                                                                                                                                                                   |
| `blacksmith-8vcpu-ubuntu-2404`   | `build-artifacts`, build-smoke, Linux Node test shards, bundled plugin test shards, `android`                                                                                                                                                                                                                                                                                                                                                                           |
| `blacksmith-16vcpu-ubuntu-2404`  | `check-lint` (CPU-sensitive enough that 8 vCPU cost more than they saved); install-smoke Docker builds (32-vCPU queue time cost more than it saved)                                                                                                                                                                                                                                                                                                                     |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-6vcpu-macos-latest`  | `macos-node` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blacksmith-12vcpu-macos-latest` | `macos-swift` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                 |

## Local equivalents

```bash
pnpm changed:lanes                            # inspect the local changed-lane classifier for origin/main...HEAD
pnpm check:changed                            # smart local check gate: changed typecheck/lint/guards by boundary lane
pnpm check                                    # fast local gate: prod tsgo + sharded lint + parallel fast guards
pnpm check:test-types
pnpm check:timed                              # same gate with per-stage timings
pnpm build:strict-smoke
pnpm check:architecture
pnpm test:gateway:watch-regression
pnpm test                                     # vitest tests
pnpm test:changed                             # cheap smart changed Vitest targets
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs                               # docs format + lint + broken links
pnpm build                                    # build dist when CI artifact/build-smoke lanes matter
pnpm ci:timings                               # summarize the latest origin/main push CI run
pnpm ci:timings:recent                        # compare recent successful main CI runs
node scripts/ci-run-timings.mjs <run-id>      # summarize wall time, queue time, and slowest jobs
node scripts/ci-run-timings.mjs --latest-main # ignore issue/comment noise and choose origin/main push CI
node scripts/ci-run-timings.mjs --recent 10   # compare recent successful main CI runs
pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json
pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json
pnpm perf:kova:summary --report .artifacts/kova/reports/mock-provider/report.json --output .artifacts/kova/summary.md
```

## OpenClaw Performance

`OpenClaw Performance` is the product/runtime performance workflow. It runs daily on `main` and can be dispatched manually:

```bash
gh workflow run openclaw-performance.yml --ref main -f profile=diagnostic -f repeat=3
gh workflow run openclaw-performance.yml --ref main -f profile=smoke -f repeat=1 -f deep_profile=true -f live_gpt54=true
```

The workflow installs OCM from a pinned release and Kova from the pinned `kova_ref` input, then runs three lanes:

- `mock-provider`: Kova diagnostic scenarios against a local-build runtime with deterministic fake OpenAI-compatible auth.
- `mock-deep-profile`: CPU/heap/trace profiling for startup, gateway, and agent-turn hotspots.
- `live-gpt54`: a real OpenAI `openai/gpt-5.4` agent turn, skipped when `OPENAI_API_KEY` is unavailable.

The mock-provider lane also runs OpenClaw-native source probes after the Kova pass: gateway boot timing and memory across default, hook, and 50-plugin startup cases; repeated mock-OpenAI `channel-chat-baseline` hello loops; and CLI startup commands against the booted gateway. The source probe Markdown summary lives at `source/index.md` in the report bundle, with raw JSON beside it.

Every lane uploads GitHub artifacts. When `CLAWGRIT_REPORTS_TOKEN` is configured, the workflow also commits `report.json`, `report.md`, bundles, `index.md`, and source-probe artifacts into `openclaw/clawgrit-reports` under `openclaw-performance/<ref>/<run-id>-<attempt>/<lane>/`. The current branch pointer is written as `openclaw-performance/<ref>/latest-<lane>.json`.

## Full Release Validation

`Full Release Validation` is the manual umbrella workflow for "run everything before release." It accepts a branch, tag, or full commit SHA, dispatches the manual `CI` workflow with that target, dispatches `Plugin Prerelease` for release-only plugin/package/static/Docker proof, and dispatches `OpenClaw Release Checks` for install smoke, package acceptance, Docker release-path suites, live/E2E, OpenWebUI, QA Lab parity, Matrix, and Telegram lanes. With `rerun_group=all` and `release_profile=full`, it also runs `NPM Telegram Beta E2E` against the `release-package-under-test` artifact from release checks. After publishing, pass `npm_telegram_package_spec` to rerun the same Telegram package lane against the published npm package.

See [Full release validation](/reference/full-release-validation) for the
stage matrix, exact workflow job names, profile differences, artifacts, and
focused rerun handles.

`OpenClaw Release Publish` is the manual mutating release workflow. Dispatch it
from `release/YYYY.M.D` or `main` after the release tag exists and after the
OpenClaw npm preflight has succeeded. It verifies `pnpm plugins:sync:check`,
dispatches `Plugin NPM Release` for all publishable plugin packages, dispatches
`Plugin ClawHub Release` for the same release SHA, and only then dispatches
`OpenClaw NPM Release` with the saved `preflight_run_id`.

```bash
gh workflow run openclaw-release-publish.yml \
  --ref release/YYYY.M.D \
  -f tag=vYYYY.M.D-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f npm_dist_tag=beta
```

For pinned commit proof on a fast-moving branch, use the helper instead of
`gh workflow run ... --ref main -f ref=<sha>`:

```bash
pnpm ci:full-release --sha <full-sha>
```

GitHub workflow dispatch refs must be branches or tags, not raw commit SHAs. The
helper pushes a temporary `release-ci/<sha>-...` branch at the target SHA,
dispatches `Full Release Validation` from that pinned ref, verifies every child
workflow `headSha` matches the target, and deletes the temporary branch when the
run completes. The umbrella verifier also fails if any child workflow ran at a
different SHA.

`release_profile` controls live/provider breadth passed into release checks. The
manual release workflows default to `stable`; use `full` only when you
intentionally want the broad advisory provider/media matrix.

- `minimum` keeps the fastest OpenAI/core release-critical lanes.
- `stable` adds the stable provider/backend set.
- `full` runs the broad advisory provider/media matrix.

The umbrella records the dispatched child run ids, and the final `Verify full validation` job re-checks current child run conclusions and appends slowest-job tables for each child run. If a child workflow is rerun and turns green, rerun only the parent verifier job to refresh the umbrella result and timing summary.

For recovery, both `Full Release Validation` and `OpenClaw Release Checks` accept `rerun_group`. Use `all` for a release candidate, `ci` for only the normal full CI child, `plugin-prerelease` for only the plugin prerelease child, `release-checks` for every release child, or a narrower group: `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa`, `qa-parity`, `qa-live`, or `npm-telegram` on the umbrella. This keeps a failed release box rerun bounded after a focused fix.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the selected ref once into a `release-package-under-test` tarball, then passes that artifact to both the live/E2E release-path Docker workflow and the package acceptance shard. That keeps the package bytes consistent across release boxes and avoids repacking the same candidate in multiple child jobs.

Duplicate `Full Release Validation` runs for `ref=main` and `rerun_group=all`
supersede the older umbrella. The parent monitor cancels any child workflow it
has already dispatched when the parent is cancelled, so newer main validation
does not sit behind a stale two-hour release-check run. Release branch/tag
validation and focused rerun groups keep `cancel-in-progress: false`.

## Live and E2E shards

The release live/E2E child keeps broad native `pnpm test:live` coverage, but it runs it as named shards through `scripts/test-live-shard.mjs` instead of one serial job:

- `native-live-src-agents`
- `native-live-src-gateway-core`
- provider-filtered `native-live-src-gateway-profiles` jobs
- `native-live-src-gateway-backends`
- `native-live-test`
- `native-live-extensions-a-k`
- `native-live-extensions-l-n`
- `native-live-extensions-openai`
- `native-live-extensions-o-z-other`
- `native-live-extensions-xai`
- split media audio/video shards and provider-filtered music shards

That keeps the same file coverage while making slow live provider failures easier to rerun and diagnose. The aggregate `native-live-extensions-o-z`, `native-live-extensions-media`, and `native-live-extensions-media-music` shard names remain valid for manual one-shot reruns.

The native live media shards run in `ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, built by the `Live Media Runner Image` workflow. That image preinstalls `ffmpeg` and `ffprobe`; media jobs only verify the binaries before setup. Keep Docker-backed live suites on normal Blacksmith runners — container jobs are the wrong place to launch nested Docker tests.

Docker-backed live model/backend shards use a separate shared `ghcr.io/openclaw/openclaw-live-test:<sha>` image per selected commit. The live release workflow builds and pushes that image once, then the Docker live model, provider-sharded gateway, CLI backend, ACP bind, and Codex harness shards run with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Gateway Docker shards carry explicit script-level `timeout` caps below the workflow job timeout so a stuck container or cleanup path fails fast instead of consuming the whole release-check budget. If those shards rebuild the full source Docker target independently, the release run is misconfigured and will waste wall clock on duplicate image builds.

## Package Acceptance

Use `Package Acceptance` when the question is "does this installable OpenClaw package work as a product?" It is different from normal CI: normal CI validates the source tree, while package acceptance validates a single tarball through the same Docker E2E harness users exercise after install or update.

### Jobs

1. `resolve_package` checks out `workflow_ref`, resolves one package candidate, writes `.artifacts/docker-e2e-package/openclaw-current.tgz`, writes `.artifacts/docker-e2e-package/package-candidate.json`, uploads both as the `package-under-test` artifact, and prints the source, workflow ref, package ref, version, SHA-256, and profile in the GitHub step summary.
2. `docker_acceptance` calls `openclaw-live-and-e2e-checks-reusable.yml` with `ref=workflow_ref` and `package_artifact_name=package-under-test`. The reusable workflow downloads that artifact, validates the tarball inventory, prepares package-digest Docker images when needed, and runs the selected Docker lanes against that package instead of packing the workflow checkout. When a profile selects multiple targeted `docker_lanes`, the reusable workflow prepares the package and shared images once, then fans those lanes out as parallel targeted Docker jobs with unique artifacts.
3. `package_telegram` optionally calls `NPM Telegram Beta E2E`. It runs when `telegram_mode` is not `none` and installs the same `package-under-test` artifact when Package Acceptance resolved one; standalone Telegram dispatch can still install a published npm spec.
4. `summary` fails the workflow if package resolution, Docker acceptance, or the optional Telegram lane failed.

### Candidate sources

- `source=npm` accepts only `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release version such as `openclaw@2026.4.27-beta.2`. Use this for published prerelease/stable acceptance.
- `source=ref` packs a trusted `package_ref` branch, tag, or full commit SHA. The resolver fetches OpenClaw branches/tags, verifies the selected commit is reachable from repository branch history or a release tag, installs deps in a detached worktree, and packs it with `scripts/package-openclaw-for-docker.mjs`.
- `source=url` downloads an HTTPS `.tgz`; `package_sha256` is required.
- `source=artifact` downloads one `.tgz` from `artifact_run_id` and `artifact_name`; `package_sha256` is optional but should be supplied for externally shared artifacts.

Keep `workflow_ref` and `package_ref` separate. `workflow_ref` is the trusted workflow/harness code that runs the test. `package_ref` is the source commit that gets packed when `source=ref`. This lets the current test harness validate older trusted source commits without running old workflow logic.

### Suite profiles

- `smoke` — `npm-onboard-channel-agent`, `gateway-network`, `config-reload`
- `package` — `npm-onboard-channel-agent`, `doctor-switch`, `update-channel-switch`, `upgrade-survivor`, `published-upgrade-survivor`, `plugins-offline`, `plugin-update`
- `product` — `package` plus `mcp-channels`, `cron-mcp-cleanup`, `openai-web-search-minimal`, `openwebui`
- `full` — full Docker release-path chunks with OpenWebUI
- `custom` — exact `docker_lanes`; required when `suite_profile=custom`

The `package` profile uses offline plugin coverage so published-package validation is not gated on live ClawHub availability. The optional Telegram lane reuses the `package-under-test` artifact in `NPM Telegram Beta E2E`, with the published npm spec path kept for standalone dispatches.

For the dedicated update and plugin testing policy, including local commands,
Docker lanes, Package Acceptance inputs, release defaults, and failure triage,
see [Testing updates and plugins](/help/testing-updates-plugins).

Release checks call Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, `docker_lanes='doctor-switch update-channel-switch upgrade-survivor published-upgrade-survivor plugins-offline plugin-update'`, `published_upgrade_survivor_baselines=all-since-2026.4.23`, `published_upgrade_survivor_scenarios=reported-issues`, and `telegram_mode=mock-openai`. This keeps package migration, update, stale-plugin-dependency cleanup, configured-plugin install repair, offline plugin, plugin-update, and Telegram proof on the same resolved package tarball. Set `package_acceptance_package_spec` on Full Release Validation or OpenClaw Release Checks to run that same matrix against a shipped npm package instead of the SHA-built artifact. Cross-OS release checks still cover OS-specific onboarding, installer, and platform behavior; package/update product validation should start with Package Acceptance. The `published-upgrade-survivor` Docker lane validates one published package baseline per run. In Package Acceptance, the resolved `package-under-test` tarball is always the candidate and `published_upgrade_survivor_baseline` selects the fallback published baseline, defaulting to `openclaw@latest`; failed-lane rerun commands preserve that baseline. Set `published_upgrade_survivor_baselines=all-since-2026.4.23` to expand Full Release CI across every stable npm release from `2026.4.23` through `latest`; `release-history` remains available for manual wider sampling with the older pre-date anchor. Set `published_upgrade_survivor_scenarios=reported-issues` to expand the same baselines across issue-shaped fixtures for Feishu config, preserved bootstrap/persona files, configured OpenClaw plugin installs, tilde log paths, and stale legacy plugin dependency roots. The separate `Update Migration` workflow uses the `update-migration` Docker lane with `all-since-2026.4.23` and `plugin-deps-cleanup` when the question is exhaustive published update cleanup, not normal Full Release CI breadth. Local aggregate runs can pass exact package specs with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, keep a single lane with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC` such as `openclaw@2026.4.15`, or set `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` for the scenario matrix. The published lane configures the baseline with a baked `openclaw config set` command recipe, records recipe steps in `summary.json`, and probes `/healthz`, `/readyz`, plus RPC status after Gateway start. The Windows packaged and installer fresh lanes also verify that an installed package can import a browser-control override from a raw absolute Windows path. The OpenAI cross-OS agent-turn smoke defaults to `OPENCLAW_CROSS_OS_OPENAI_MODEL` when set, otherwise `openai/gpt-5.4`, so the install and gateway proof stays on a GPT-5 test model while avoiding GPT-4.x defaults.

### Legacy compatibility windows

Package Acceptance has bounded legacy-compatibility windows for already-published packages. Packages through `2026.4.25`, including `2026.4.25-beta.*`, may use the compatibility path:

- known private QA entries in `dist/postinstall-inventory.json` may point at tarball-omitted files;
- `doctor-switch` may skip the `gateway install --wrapper` persistence subcase when the package does not expose that flag;
- `update-channel-switch` may prune missing `pnpm.patchedDependencies` from the tarball-derived fake git fixture and may log missing persisted `update.channel`;
- plugin smokes may read legacy install-record locations or accept missing marketplace install-record persistence;
- `plugin-update` may allow config metadata migration while still requiring the install record and no-reinstall behavior to stay unchanged.

The published `2026.4.26` package may also warn for local build metadata stamp files that were already shipped. Later packages must satisfy the modern contracts; the same conditions fail instead of warn or skip.

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

# Pack and validate a release branch with the current harness.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=release/YYYY.M.D \
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

The separate `Install Smoke` workflow reuses the same scope script through its own `preflight` job. It splits smoke coverage into `run_fast_install_smoke` and `run_full_install_smoke`.

- **Fast path** runs for pull requests touching Docker/package surfaces, bundled plugin package/manifest changes, or core plugin/channel/gateway/Plugin SDK surfaces that the Docker smoke jobs exercise. Source-only bundled plugin changes, test-only edits, and docs-only edits do not reserve Docker workers. The fast path builds the root Dockerfile image once, checks the CLI, runs the agents delete shared-workspace CLI smoke, runs the container gateway-network e2e, verifies a bundled extension build arg, and runs the bounded bundled-plugin Docker profile under a 240-second aggregate command timeout (each scenario's Docker run capped separately).
- **Full path** keeps QR package install and installer Docker/update coverage for nightly scheduled runs, manual dispatches, workflow-call release checks, and pull requests that truly touch installer/package/Docker surfaces. In full mode, install-smoke prepares or reuses one target-SHA GHCR root Dockerfile smoke image, then runs QR package install, root Dockerfile/gateway smokes, installer/update smokes, and the fast bundled-plugin Docker E2E as separate jobs so installer work does not wait behind the root image smokes.

`main` pushes (including merge commits) do not force the full path; when changed-scope logic would request full coverage on a push, the workflow keeps the fast Docker smoke and leaves the full install smoke to nightly or release validation.

The slow Bun global install image-provider smoke is separately gated by `run_bun_global_install_smoke`. It runs on the nightly schedule and from the release checks workflow, and manual `Install Smoke` dispatches can opt into it, but pull requests and `main` pushes do not. QR and installer Docker tests keep their own install-focused Dockerfiles.

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
| `OPENCLAW_DOCKER_ALL_NPM_LIMIT`        | 10      | Concurrent npm install lane cap.                                                              |
| `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT`    | 7       | Concurrent multi-service lane cap.                                                            |
| `OPENCLAW_DOCKER_ALL_START_STAGGER_MS` | 2000    | Stagger between lane starts to avoid Docker daemon create storms; set `0` for no stagger.     |
| `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`  | 7200000 | Per-lane fallback timeout (120 minutes); selected live/tail lanes use tighter caps.           |
| `OPENCLAW_DOCKER_ALL_DRY_RUN`          | unset   | `1` prints the scheduler plan without running lanes.                                          |
| `OPENCLAW_DOCKER_ALL_LANES`            | unset   | Comma-separated exact lane list; skips cleanup smoke so agents can reproduce one failed lane. |

A lane heavier than its effective cap can still start from an empty pool, then runs alone until it releases capacity. The local aggregate preflights Docker, removes stale OpenClaw E2E containers, emits active-lane status, persists lane timings for longest-first ordering, and stops scheduling new pooled lanes after the first failure by default.

### Reusable live/E2E workflow

The reusable live/E2E workflow asks `scripts/test-docker-all.mjs --plan-json` which package, image kind, live image, lane, and credential coverage is required. `scripts/docker-e2e.mjs` then converts that plan into GitHub outputs and summaries. It either packs OpenClaw through `scripts/package-openclaw-for-docker.mjs`, downloads a current-run package artifact, or downloads a package artifact from `package_artifact_run_id`; validates the tarball inventory; builds and pushes package-digest-tagged bare/functional GHCR Docker E2E images through Blacksmith's Docker layer cache when the plan needs package-installed lanes; and reuses provided `docker_e2e_bare_image`/`docker_e2e_functional_image` inputs or existing package-digest images instead of rebuilding. Docker image pulls are retried with a bounded 180-second per-attempt timeout so a stuck registry/cache stream retries quickly instead of consuming most of the CI critical path.

### Release-path chunks

Release Docker coverage runs smaller chunked jobs with `OPENCLAW_SKIP_DOCKER_BUILD=1` so each chunk pulls only the image kind it needs and executes multiple lanes through the same weighted scheduler:

- `OPENCLAW_DOCKER_ALL_PROFILE=release-path`
- `OPENCLAW_DOCKER_ALL_CHUNK=core | package-update-openai | package-update-anthropic | package-update-core | plugins-runtime-plugins | plugins-runtime-services | plugins-runtime-install-a..h`

Current release Docker chunks are `core`, `package-update-openai`, `package-update-anthropic`, `package-update-core`, `plugins-runtime-plugins`, `plugins-runtime-services`, and `plugins-runtime-install-a` through `plugins-runtime-install-h`. `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes.

OpenWebUI is folded into `plugins-runtime-services` when full release-path coverage requests it, and keeps a standalone `openwebui` chunk only for OpenWebUI-only dispatches. Bundled-channel update lanes retry once for transient npm network failures.

Each chunk uploads `.artifacts/docker-tests/` with lane logs, timings, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, slow-lane tables, and per-lane rerun commands. The workflow `docker_lanes` input runs selected lanes against the prepared images instead of the chunk jobs, which keeps failed-lane debugging bounded to one targeted Docker job and prepares, downloads, or reuses the package artifact for that run; if a selected lane is a live Docker lane, the targeted job builds the live-test image locally for that rerun. Generated per-lane GitHub rerun commands include `package_artifact_run_id`, `package_artifact_name`, and prepared image inputs when those values exist, so a failed lane can reuse the exact package and images from the failed run.

```bash
pnpm test:docker:rerun <run-id>      # download Docker artifacts and print combined/per-lane targeted rerun commands
pnpm test:docker:timings <summary>   # slow-lane and phase critical-path summaries
```

The scheduled live/E2E workflow runs the full release-path Docker suite daily.

## Plugin Prerelease

`Plugin Prerelease` is more expensive product/package coverage, so it is a separate workflow dispatched by `Full Release Validation` or by an explicit operator. Normal pull requests, `main` pushes, and standalone manual CI dispatches keep that suite off. It balances bundled plugin tests across eight extension workers; those extension shard jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap so import-heavy plugin batches do not create extra CI jobs. The release-only Docker prerelease path batches targeted Docker lanes in small groups to avoid reserving dozens of runners for one-to-three-minute jobs.

## QA Lab

QA Lab has dedicated CI lanes outside the main smart-scoped workflow. Agentic parity is nested under the broad QA and release harnesses, not a standalone PR workflow. Use `Full Release Validation` with `rerun_group=qa-parity` when parity should ride with a broad validation run.

- The `QA-Lab - All Lanes` workflow runs nightly on `main` and on manual dispatch; it fans out the mock parity lane, live Matrix lane, and live Telegram and Discord lanes as parallel jobs. Live jobs use the `qa-live-shared` environment, and Telegram/Discord use Convex leases.

Release checks run Matrix and Telegram live transport lanes with the deterministic mock provider and mock-qualified models (`mock-openai/gpt-5.5` and `mock-openai/gpt-5.5-alt`) so the channel contract is isolated from live model latency and normal provider-plugin startup. The live transport gateway disables memory search because QA parity covers memory behavior separately; provider connectivity is covered by the separate live model, native provider, and Docker provider suites.

Matrix uses `--profile fast` for scheduled and release gates, adding `--fail-fast` only when the checked-out CLI supports it. The CLI default and manual workflow input remain `all`; manual `matrix_profile=all` dispatch always shards full Matrix coverage into `transport`, `media`, `e2ee-smoke`, `e2ee-deep`, and `e2ee-cli` jobs.

`OpenClaw Release Checks` also runs the release-critical QA Lab lanes before release approval; its QA parity gate runs the candidate and baseline packs as parallel lane jobs, then downloads both artifacts into a small report job for the final parity comparison.

For normal PRs, follow scoped CI/check evidence instead of treating parity as a required status.

## CodeQL

The `CodeQL` workflow is intentionally a narrow first-pass security scanner, not the full repository sweep. Daily, manual, and non-draft pull request guard runs scan Actions workflow code plus the highest-risk JavaScript/TypeScript surfaces with high-confidence security queries filtered to high/critical `security-severity`.

The pull request guard stays light: it only starts for changes under `.github/actions`, `.github/codeql`, `.github/workflows`, `packages`, or `src`, and it runs the same high-confidence security matrix as the scheduled workflow. Android and macOS CodeQL stay out of PR defaults.

### Security categories

| Category                                          | Surface                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/codeql-security-high/core-auth-secrets`         | Auth, secrets, sandbox, cron, and gateway baseline                                                                                  |
| `/codeql-security-high/channel-runtime-boundary`  | Core channel implementation contracts plus the channel plugin runtime, gateway, Plugin SDK, secrets, audit touchpoints              |
| `/codeql-security-high/network-ssrf-boundary`     | Core SSRF, IP parsing, network guard, web-fetch, and Plugin SDK SSRF policy surfaces                                                |
| `/codeql-security-high/mcp-process-tool-boundary` | MCP servers, process execution helpers, outbound delivery, and agent tool-execution gates                                           |
| `/codeql-security-high/plugin-trust-boundary`     | Plugin install, loader, manifest, registry, package-manager install, source-loading, and Plugin SDK package contract trust surfaces |

### Platform-specific security shards

- `CodeQL Android Critical Security` — scheduled Android security shard. Builds the Android app manually for CodeQL on the smallest Blacksmith Linux runner accepted by workflow sanity. Uploads under `/codeql-critical-security/android`.
- `CodeQL macOS Critical Security` — weekly/manual macOS security shard. Builds the macOS app manually for CodeQL on Blacksmith macOS, filters dependency build results out of uploaded SARIF, and uploads under `/codeql-critical-security/macos`. Kept outside daily defaults because macOS build dominates runtime even when clean.

### Critical Quality categories

`CodeQL Critical Quality` is the matching non-security shard. It runs only error-severity, non-security JavaScript/TypeScript quality queries over narrow high-value surfaces on the smaller Blacksmith Linux runner. Its pull request guard is intentionally smaller than the scheduled profile: non-draft PRs only run the matching `agent-runtime-boundary`, `config-boundary`, `core-auth-secrets`, `channel-runtime-boundary`, `gateway-runtime-boundary`, `memory-runtime-boundary`, `mcp-process-runtime-boundary`, `provider-runtime-boundary`, `session-diagnostics-boundary`, `plugin-boundary`, `plugin-sdk-package-contract`, and `plugin-sdk-reply-runtime` shards for agent command/model/tool execution and reply dispatch code, config schema/migration/IO code, auth/secrets/sandbox/security code, core channel and bundled channel plugin runtime, gateway protocol/server-method, memory runtime/SDK glue, MCP/process/outbound delivery, provider runtime/model catalog, session diagnostics/delivery queues, plugin loader, Plugin SDK/package-contract, or Plugin SDK reply runtime changes. CodeQL config and quality workflow changes run all twelve PR quality shards.

Manual dispatch accepts:

```
profile=all|agent-runtime-boundary|config-boundary|core-auth-secrets|channel-runtime-boundary|gateway-runtime-boundary|memory-runtime-boundary|mcp-process-runtime-boundary|plugin-boundary|plugin-sdk-package-contract|plugin-sdk-reply-runtime|provider-runtime-boundary|session-diagnostics-boundary
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

The `Test Performance Agent` workflow is an event-driven Codex maintenance lane for slow tests. It has no pure schedule: a successful non-bot push CI run on `main` can trigger it, but it skips if another workflow-run invocation already ran or is running that UTC day. Manual dispatch bypasses that daily activity gate. The lane builds a full-suite grouped Vitest performance report, lets Codex make only small coverage-preserving test performance fixes instead of broad refactors, then reruns the full-suite report and rejects changes that reduce the passing baseline test count. If the baseline has failing tests, Codex may fix only obvious failures and the after-agent full-suite report must pass before anything is committed. When `main` advances before the bot push lands, the lane rebases the validated patch, reruns `pnpm check:changed`, and retries the push; conflicting stale patches are skipped. It uses GitHub-hosted Ubuntu so the Codex action can keep the same drop-sudo safety posture as the docs agent.

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

Run Testbox from the repo root and prefer a fresh warmed box for broad proof. Before spending a slow gate on a box that was reused, expired, or just reported an unexpectedly large sync, run `pnpm testbox:sanity` inside the box first.

The sanity check fails fast when required root files such as `pnpm-lock.yaml` disappeared or when `git status --short` shows at least 200 tracked deletions. That usually means the remote sync state is not a trustworthy copy of the PR; stop that box and warm a fresh one instead of debugging the product test failure. For intentional large-deletion PRs, set `OPENCLAW_TESTBOX_ALLOW_MASS_DELETIONS=1` for that sanity run.

`pnpm testbox:run` also terminates a local Blacksmith CLI invocation that stays in the sync phase for more than five minutes without post-sync output. Set `OPENCLAW_TESTBOX_SYNC_TIMEOUT_MS=0` to disable that guard, or use a larger millisecond value for unusually large local diffs.

Crabbox is the repo-owned second remote-box path for Linux proof when Blacksmith is unavailable or when owned cloud capacity is preferable. Warm a box, hydrate it through the project workflow, then run commands through the Crabbox CLI:

```bash
pnpm crabbox:warmup -- --idle-timeout 90m
pnpm crabbox:hydrate -- --id <cbx_id>
pnpm crabbox:run -- --id <cbx_id> --shell "OPENCLAW_TESTBOX=1 pnpm check:changed"
pnpm crabbox:stop -- <cbx_id>
```

`.crabbox.yaml` owns provider, sync, and GitHub Actions hydration defaults. It excludes local `.git` so the hydrated Actions checkout keeps its own remote Git metadata instead of syncing maintainer-local remotes and object stores, and it excludes local runtime/build artifacts that should never be transferred. `.github/workflows/crabbox-hydrate.yml` owns checkout, Node/pnpm setup, `origin/main` fetch, and the non-secret environment handoff that later `crabbox run --id <cbx_id>` commands source.

## Related

- [Install overview](/install)
- [Development channels](/install/development-channels)
