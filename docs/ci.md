---
summary: "CI job graph, scope gates, and local command equivalents"
title: CI pipeline
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only unrelated areas changed. Manual `workflow_dispatch` runs intentionally bypass smart scoping and fan out the full normal CI graph for release candidates or broad validation.

`Full Release Validation` is the manual umbrella workflow for "run everything
before release." It accepts a branch, tag, or full commit SHA, dispatches the
manual `CI` workflow with that target, and dispatches `OpenClaw Release Checks`
for install smoke, package acceptance, Docker release-path suites, live/E2E,
OpenWebUI, QA Lab parity, Matrix, and Telegram lanes. It can also run the
post-publish `NPM Telegram Beta E2E` workflow when a published package spec is
provided. `release_profile=minimum|stable|full` controls the live/provider
breadth passed into release checks: `minimum` keeps the fastest OpenAI/core
release-critical lanes, `stable` adds the stable provider/backend set, and
`full` runs the broad advisory provider/media matrix. The umbrella records the
dispatched child run ids, and the final `Verify full validation` job re-checks
the current child run conclusions and appends slowest-job tables for each child
run. If a child workflow is rerun and turns green, rerun only the parent
verifier job to refresh the umbrella result and timing summary.

For recovery, `Full Release Validation` and `OpenClaw Release Checks` both
accept `rerun_group`. Use `all` for a release candidate, `ci` for only the
normal full CI child, `release-checks` for every release child, or a narrower
release group: `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa`,
`qa-parity`, `qa-live`, or `npm-telegram` on the umbrella. This keeps a failed
release box rerun bounded after a focused fix.

The release live/E2E child keeps broad native `pnpm test:live` coverage, but it
runs it as named shards (`native-live-src-agents`,
`native-live-src-gateway-core`, provider-filtered
`native-live-src-gateway-profiles` jobs,
`native-live-src-gateway-backends`, `native-live-test`,
`native-live-extensions-a-k`, `native-live-extensions-l-n`,
`native-live-extensions-openai`, `native-live-extensions-o-z-other`,
`native-live-extensions-xai`, split media audio/video shards, and
provider-filtered music shards) through `scripts/test-live-shard.mjs` instead
of one serial job. That keeps the same file coverage while making slow live
provider failures easier to rerun and diagnose. The aggregate
`native-live-extensions-o-z`, `native-live-extensions-media`, and
`native-live-extensions-media-music` shard names remain valid for manual
one-shot reruns.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the selected
ref once into a `release-package-under-test` tarball, then passes that artifact
to both the live/E2E release-path Docker workflow and the package acceptance
shard. That keeps the package bytes consistent across release boxes and avoids
repacking the same candidate in multiple child jobs.

`Package Acceptance` is the side-run workflow for validating a package artifact
without blocking the release workflow. It resolves one candidate from a
published npm spec, a trusted `package_ref` built with the selected
`workflow_ref` harness, an HTTPS tarball URL with SHA-256, or a tarball artifact
from another GitHub Actions run, uploads it as `package-under-test`, then reuses
the Docker release/E2E scheduler with that tarball instead of repacking the
workflow checkout. Profiles cover smoke, package, product, full, and custom
Docker lane selections. The `package` profile uses offline plugin coverage so
published-package validation is not gated on live ClawHub availability. The
optional Telegram lane reuses the
`package-under-test` artifact in the `NPM Telegram Beta E2E` workflow, with the
published npm spec path kept for standalone dispatches.

## Package acceptance

Use `Package Acceptance` when the question is "does this installable OpenClaw
package work as a product?" It is different from normal CI: normal CI validates
the source tree, while package acceptance validates a single tarball through the
same Docker E2E harness users exercise after install or update.

The workflow has four jobs:

1. `resolve_package` checks out `workflow_ref`, resolves one package candidate,
   writes `.artifacts/docker-e2e-package/openclaw-current.tgz`, writes
   `.artifacts/docker-e2e-package/package-candidate.json`, uploads both as the
   `package-under-test` artifact, and prints the source, workflow ref, package
   ref, version, SHA-256, and profile in the GitHub step summary.
2. `docker_acceptance` calls
   `openclaw-live-and-e2e-checks-reusable.yml` with `ref=workflow_ref` and
   `package_artifact_name=package-under-test`. The reusable workflow downloads
   that artifact, validates the tarball inventory, prepares package-digest
   Docker images when needed, and runs the selected Docker lanes against that
   package instead of packing the workflow checkout. When a profile selects
   multiple targeted `docker_lanes`, the reusable workflow prepares the package
   and shared images once, then fans those lanes out as parallel targeted Docker
   jobs with unique artifacts.
3. `package_telegram` optionally calls `NPM Telegram Beta E2E`. It runs when
   `telegram_mode` is not `none` and installs the same `package-under-test`
   artifact when Package Acceptance resolved one; standalone Telegram dispatch
   can still install a published npm spec.
4. `summary` fails the workflow if package resolution, Docker acceptance, or
   the optional Telegram lane failed.

Candidate sources:

- `source=npm`: accepts only `openclaw@beta`, `openclaw@latest`, or an exact
  OpenClaw release version such as `openclaw@2026.4.27-beta.2`. Use this for
  published beta/stable acceptance.
- `source=ref`: packs a trusted `package_ref` branch, tag, or full commit SHA.
  The resolver fetches OpenClaw branches/tags, verifies the selected commit is
  reachable from repository branch history or a release tag, installs deps in a
  detached worktree, and packs it with `scripts/package-openclaw-for-docker.mjs`.
- `source=url`: downloads an HTTPS `.tgz`; `package_sha256` is required.
- `source=artifact`: downloads one `.tgz` from `artifact_run_id` and
  `artifact_name`; `package_sha256` is optional but should be supplied for
  externally shared artifacts.

Keep `workflow_ref` and `package_ref` separate. `workflow_ref` is the trusted
workflow/harness code that runs the test. `package_ref` is the source commit
that gets packed when `source=ref`. This lets the current test harness validate
older trusted source commits without running old workflow logic.

Profiles map to Docker coverage:

- `smoke`: `npm-onboard-channel-agent`, `gateway-network`, `config-reload`
- `package`: `npm-onboard-channel-agent`, `doctor-switch`,
  `update-channel-switch`, `bundled-channel-deps-compat`, `plugins-offline`,
  `plugin-update`
- `product`: `package` plus `mcp-channels`, `cron-mcp-cleanup`,
  `openai-web-search-minimal`, `openwebui`
- `full`: full Docker release-path chunks with OpenWebUI
- `custom`: exact `docker_lanes`; required when `suite_profile=custom`

Release checks call Package Acceptance with `source=ref`,
`package_ref=<release-ref>`, `workflow_ref=<release workflow ref>`,
`suite_profile=custom`,
`docker_lanes='bundled-channel-deps-compat plugins-offline'`, and
`telegram_mode=mock-openai`. The release-path Docker
chunks cover the overlapping package/update/plugin lanes, while Package
Acceptance keeps the artifact-native bundled-channel compat, offline plugin, and
Telegram proof against the same resolved package tarball.
Cross-OS release checks still cover OS-specific onboarding, installer, and
platform behavior; package/update product validation should start with Package
Acceptance. The Windows packaged and installer fresh lanes also verify that an
installed package can import a browser-control override from a raw absolute
Windows path.

Package Acceptance has bounded legacy-compatibility windows for already
published packages. Packages through `2026.4.25`, including `2026.4.25-beta.*`,
may use the compatibility path for known private QA entries in
`dist/postinstall-inventory.json` that point at tarball-omitted files,
`doctor-switch` may skip the `gateway install --wrapper` persistence subcase
when the package does not expose that flag, `update-channel-switch` may prune
missing `pnpm.patchedDependencies` from the tarball-derived fake git fixture and
may log missing persisted `update.channel`, plugin smokes may read legacy
install-record locations or accept missing marketplace install-record
persistence, and `plugin-update` may allow config metadata migration while still
requiring the install record and no-reinstall behavior to stay unchanged. The
published `2026.4.26` package may also warn for local build metadata stamp files
that were already shipped. Later packages must satisfy the modern contracts; the
same conditions fail instead of warn or skip.

Examples:

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

When debugging a failed package acceptance run, start at the `resolve_package`
summary to confirm the package source, version, and SHA-256. Then inspect the
`docker_acceptance` child run and its Docker artifacts:
`.artifacts/docker-tests/**/summary.json`, `failures.json`, lane logs, phase
timings, and rerun commands. Prefer rerunning the failed package profile or
exact Docker lanes instead of rerunning full release validation.

QA Lab has dedicated CI lanes outside the main smart-scoped workflow. The
`Parity gate` workflow runs on matching PR changes and manual dispatch; it
builds the private QA runtime and compares the mock GPT-5.5 and Opus 4.6
agentic packs. The `QA-Lab - All Lanes` workflow runs nightly on `main` and on
manual dispatch; it fans out the mock parity gate, live Matrix lane, and live
Telegram and Discord lanes as parallel jobs. The live jobs use the
`qa-live-shared` environment, and Telegram/Discord use Convex leases. Matrix
uses `--profile fast` for scheduled and release gates, adding `--fail-fast` only
when the checked-out CLI supports it. The CLI default and manual workflow input
remain `all`; manual `matrix_profile=all`
dispatch always shards full Matrix coverage into `transport`, `media`,
`e2ee-smoke`, `e2ee-deep`, and `e2ee-cli` jobs. `OpenClaw Release Checks` also
runs the release-critical QA Lab lanes before release approval; its QA parity
gate runs the candidate and baseline packs as parallel lane jobs, then downloads
both artifacts into a small report job for the final parity comparison.
Do not put the PR landing path behind `Parity gate` unless the change actually
touches QA runtime, model-pack parity, or a surface the parity workflow owns.
For normal channel, config, docs, or unit-test fixes, treat it as an optional
signal and follow the scoped CI/check evidence instead.

The `Duplicate PRs After Merge` workflow is a manual maintainer workflow for
post-land duplicate cleanup. It defaults to dry-run and only closes explicitly
listed PRs when `apply=true`. Before mutating GitHub, it verifies that the
landed PR is merged and that each duplicate has either a shared referenced issue
or overlapping changed hunks.

The `CodeQL` workflow is intentionally a narrow first-pass security scanner,
not the full repository sweep. Daily and manual runs scan Actions workflow code
plus the highest-risk JavaScript/TypeScript auth, secrets, sandbox, cron, and
gateway surfaces with high-precision security queries. macOS remains a manual
security shard so its runtime and alert quality can be tracked separately.

The `CodeQL Android Critical Security` workflow is the scheduled Android
security shard. It builds the Android app manually for CodeQL on the smallest
Blacksmith Linux runner label accepted by workflow sanity and uploads results
under the `/codeql-critical-security/android` category.

The `CodeQL Critical Quality` workflow is the matching non-security shard. It
runs only error-severity, non-security JavaScript/TypeScript quality queries
over the same narrow auth, secrets, sandbox, cron, and gateway surface. Keep it
separate from the security workflow so quality findings can be scheduled,
measured, disabled, or expanded without obscuring security signal. Swift,
Python, UI, and bundled-plugin CodeQL expansion should be added back as scoped
or sharded follow-up work only after the narrow profiles have stable runtime and
signal.

The `Docs Agent` workflow is an event-driven Codex maintenance lane for keeping
existing docs aligned with recently landed changes. It has no pure schedule: a
successful non-bot push CI run on `main` can trigger it, and manual dispatch can
run it directly. Workflow-run invocations skip when `main` has moved on or when
another non-skipped Docs Agent run was created in the last hour. When it runs, it
reviews the commit range from the previous non-skipped Docs Agent source SHA to
current `main`, so one hourly run can cover all main changes accumulated since
the last docs pass.

The `Test Performance Agent` workflow is an event-driven Codex maintenance lane
for slow tests. It has no pure schedule: a successful non-bot push CI run on
`main` can trigger it, but it skips if another workflow-run invocation already
ran or is running that UTC day. Manual dispatch bypasses that daily activity
gate. The lane builds a full-suite grouped Vitest performance report, lets Codex
make only small coverage-preserving test performance fixes instead of broad
refactors, then reruns the full-suite report and rejects changes that reduce the
passing baseline test count. If the baseline has failing tests, Codex may fix
only obvious failures and the after-agent full-suite report must pass before
anything is committed. When `main` advances before the bot push lands, the lane
rebases the validated patch, reruns `pnpm check:changed`, and retries the push;
conflicting stale patches are skipped. It uses GitHub-hosted Ubuntu so the Codex
action can keep the same drop-sudo safety posture as the docs agent.

```bash
gh workflow run duplicate-after-merge.yml \
  -f landed_pr=70532 \
  -f duplicate_prs='70530,70592' \
  -f apply=true
```

## Job overview

| Job                              | Purpose                                                                                      | When it runs                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| `preflight`                      | Detect docs-only changes, changed scopes, changed extensions, and build the CI manifest      | Always on non-draft pushes and PRs |
| `security-scm-fast`              | Private key detection and workflow audit via `zizmor`                                        | Always on non-draft pushes and PRs |
| `security-dependency-audit`      | Dependency-free production lockfile audit against npm advisories                             | Always on non-draft pushes and PRs |
| `security-fast`                  | Required aggregate for the fast security jobs                                                | Always on non-draft pushes and PRs |
| `build-artifacts`                | Build `dist/`, Control UI, built-artifact checks, and reusable downstream artifacts          | Node-relevant changes              |
| `checks-fast-core`               | Fast Linux correctness lanes such as bundled/plugin-contract/protocol checks                 | Node-relevant changes              |
| `checks-fast-contracts-channels` | Sharded channel contract checks with a stable aggregate check result                         | Node-relevant changes              |
| `checks-node-extensions`         | Full bundled-plugin test shards across the extension suite                                   | Node-relevant changes              |
| `checks-node-core-test`          | Core Node test shards, excluding channel, bundled, contract, and extension lanes             | Node-relevant changes              |
| `check`                          | Sharded main local gate equivalent: prod types, lint, guards, test types, and strict smoke   | Node-relevant changes              |
| `check-additional`               | Architecture, boundary, extension-surface guards, package-boundary, and gateway-watch shards | Node-relevant changes              |
| `build-smoke`                    | Built-CLI smoke tests and startup-memory smoke                                               | Node-relevant changes              |
| `checks`                         | Verifier for built-artifact channel tests                                                    | Node-relevant changes              |
| `checks-node-compat-node22`      | Node 22 compatibility build and smoke lane                                                   | Manual CI dispatch for releases    |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                | Docs changed                       |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                       | Python-skill-relevant changes      |
| `checks-windows`                 | Windows-specific process/path tests plus shared runtime import specifier regressions         | Windows-relevant changes           |
| `macos-node`                     | macOS TypeScript test lane using the shared built artifacts                                  | macOS-relevant changes             |
| `macos-swift`                    | Swift lint, build, and tests for the macOS app                                               | macOS-relevant changes             |
| `android`                        | Android unit tests for both flavors plus one debug APK build                                 | Android-relevant changes           |
| `test-performance-agent`         | Daily Codex slow-test optimization after trusted activity                                    | Main CI success or manual dispatch |

Manual CI dispatches run the same job graph as normal CI but force every
scoped lane on: Linux Node shards, bundled-plugin shards, channel contracts,
Node 22 compatibility, `check`, `check-additional`, build smoke, docs checks,
Python skills, Windows, macOS, Android, and Control UI i18n. Manual runs use a
unique concurrency group so a release-candidate full suite is not cancelled by
another push or PR run on the same ref. The optional `target_ref` input lets a
trusted caller run that graph against a branch, tag, or full commit SHA while
using the workflow file from the selected dispatch ref.

```bash
gh workflow run ci.yml --ref release/YYYY.M.D
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha>
gh workflow run full-release-validation.yml --ref main -f ref=<branch-or-sha>
```

## Fail-fast order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs.
2. `security-scm-fast`, `security-dependency-audit`, `security-fast`, `check`, `check-additional`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
3. `build-artifacts` overlaps with the fast Linux lanes so downstream consumers can start as soon as the shared build is ready.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-channels`, `checks-node-extensions`, `checks-node-core-test`, `checks`, `checks-windows`, `macos-node`, `macos-swift`, and `android`.

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.
Manual dispatch skips changed-scope detection and makes the preflight manifest
act as if every scoped area changed.
CI workflow edits validate the Node CI graph plus workflow linting, but do not force Windows, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
CI routing-only edits, selected cheap core-test fixture edits, and narrow plugin contract helper/test-routing edits use a fast Node-only manifest path: preflight, security, and a single `checks-fast-core` task. That path avoids build artifacts, Node 22 compatibility, channel contracts, full core shards, bundled-plugin shards, and additional guard matrices when the changed files are limited to the routing or helper surfaces that the fast task exercises directly.
Windows Node checks are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes so they do not reserve a 16-vCPU Windows worker for coverage that is already exercised by the normal test shards.
The separate `install-smoke` workflow reuses the same scope script through its own `preflight` job. It splits smoke coverage into `run_fast_install_smoke` and `run_full_install_smoke`. Pull requests run the fast path for Docker/package surfaces, bundled plugin package/manifest changes, and core plugin/channel/gateway/Plugin SDK surfaces that the Docker smoke jobs exercise. Source-only bundled plugin changes, test-only edits, and docs-only edits do not reserve Docker workers. The fast path builds the root Dockerfile image once, checks the CLI, runs the agents delete shared-workspace CLI smoke, runs the container gateway-network e2e, verifies a bundled extension build arg, and runs the bounded bundled-plugin Docker profile under a 240-second aggregate command timeout with each scenario's Docker run capped separately. The full path keeps QR package install and installer Docker/update coverage for nightly scheduled runs, manual dispatches, workflow-call release checks, and pull requests that truly touch installer/package/Docker surfaces. `main` pushes, including merge commits, do not force the full path; when changed-scope logic would request full coverage on a push, the workflow keeps the fast Docker smoke and leaves the full install smoke to nightly or release validation. The slow Bun global install image-provider smoke is separately gated by `run_bun_global_install_smoke`; it runs on the nightly schedule and from the release checks workflow, and manual `install-smoke` dispatches can opt into it, but pull requests and `main` pushes do not run it. QR and installer Docker tests keep their own install-focused Dockerfiles. Local `test:docker:all` prebuilds one shared live-test image, packs OpenClaw once as an npm tarball, and builds two shared `scripts/e2e/Dockerfile` images: a bare Node/Git runner for installer/update/plugin-dependency lanes and a functional image that installs the same tarball into `/app` for normal functionality lanes. Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mjs`, planner logic lives in `scripts/lib/docker-e2e-plan.mjs`, and the runner only executes the selected plan. The scheduler selects the image per lane with `OPENCLAW_DOCKER_E2E_BARE_IMAGE` and `OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`, then runs lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1`; tune the default main-pool slot count of 10 with `OPENCLAW_DOCKER_ALL_PARALLELISM` and the provider-sensitive tail-pool slot count of 10 with `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM`. Heavy lane caps default to `OPENCLAW_DOCKER_ALL_LIVE_LIMIT=9`, `OPENCLAW_DOCKER_ALL_NPM_LIMIT=10`, and `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT=7` so npm install and multi-service lanes do not overcommit Docker while lighter lanes still fill available slots. A single lane heavier than the effective caps can still start from an empty pool, then runs alone until it releases capacity. Lane starts are staggered by 2 seconds by default to avoid local Docker daemon create storms; override with `OPENCLAW_DOCKER_ALL_START_STAGGER_MS=0` or another millisecond value. The local aggregate preflights Docker, removes stale OpenClaw E2E containers, emits active-lane status, persists lane timings for longest-first ordering, and supports `OPENCLAW_DOCKER_ALL_DRY_RUN=1` for scheduler inspection. It stops scheduling new pooled lanes after the first failure by default, and each lane has a 120-minute fallback timeout overrideable with `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`; selected live/tail lanes use tighter per-lane caps. `OPENCLAW_DOCKER_ALL_LANES=<lane[,lane]>` runs exact scheduler lanes, including release-only lanes such as `install-e2e` and split bundled update lanes such as `bundled-channel-update-acpx`, while skipping the cleanup smoke so agents can reproduce one failed lane. The reusable live/E2E workflow asks `scripts/test-docker-all.mjs --plan-json` which package, image kind, live image, lane, and credential coverage is required, then `scripts/docker-e2e.mjs` converts that plan into GitHub outputs and summaries. It either packs OpenClaw through `scripts/package-openclaw-for-docker.mjs`, downloads a current-run package artifact, or downloads a package artifact from `package_artifact_run_id`; validates the tarball inventory; builds and pushes package-digest-tagged bare/functional GHCR Docker E2E images through Blacksmith's Docker layer cache when the plan needs package-installed lanes; and reuses provided `docker_e2e_bare_image`/`docker_e2e_functional_image` inputs or existing package-digest images instead of rebuilding. The `Package Acceptance` workflow is the high-level package gate: it resolves a candidate from npm, a trusted `package_ref`, an HTTPS tarball plus SHA-256, or a prior workflow artifact, then passes that single `package-under-test` artifact into the reusable Docker E2E workflow. It keeps `workflow_ref` separate from `package_ref` so current acceptance logic can validate older trusted commits without checking out old workflow code. Release checks run a custom Package Acceptance delta for the target ref: bundled-channel compat, offline plugin fixtures, and Telegram package QA against the resolved tarball. The release-path Docker suite runs smaller chunked jobs with `OPENCLAW_SKIP_DOCKER_BUILD=1` so each chunk pulls only the image kind it needs and executes multiple lanes through the same weighted scheduler (`OPENCLAW_DOCKER_ALL_PROFILE=release-path`, `OPENCLAW_DOCKER_ALL_CHUNK=core|package-update-openai|package-update-anthropic|package-update-core|plugins-runtime-plugins|plugins-runtime-services|plugins-runtime-install-a|plugins-runtime-install-b|plugins-runtime-install-c|plugins-runtime-install-d|bundled-channels`). OpenWebUI is folded into `plugins-runtime-services` when full release-path coverage requests it, and keeps a standalone `openwebui` chunk only for OpenWebUI-only dispatches. The legacy aggregate chunk names `package-update`, `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` still work for manual reruns, but the release workflow uses the split chunks so installer E2E and bundled plugin install/uninstall sweeps do not dominate the critical path. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes. The `bundled-channels` chunk runs split `bundled-channel-*` and `bundled-channel-update-*` lanes rather than the serial all-in-one `bundled-channel-deps` lane. Each chunk uploads `.artifacts/docker-tests/` with lane logs, timings, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, slow-lane tables, and per-lane rerun commands. The workflow `docker_lanes` input runs selected lanes against the prepared images instead of the chunk jobs, which keeps failed-lane debugging bounded to one targeted Docker job and prepares, downloads, or reuses the package artifact for that run; if a selected lane is a live Docker lane, the targeted job builds the live-test image locally for that rerun. Generated per-lane GitHub rerun commands include `package_artifact_run_id`, `package_artifact_name`, and prepared image inputs when those values exist, so a failed lane can reuse the exact package and images from the failed run. Use `pnpm test:docker:rerun <run-id>` to download Docker artifacts from a GitHub run and print combined/per-lane targeted rerun commands; use `pnpm test:docker:timings <summary.json>` for slow-lane and phase critical-path summaries. The scheduled live/E2E workflow runs the full release-path Docker suite daily. The bundled update matrix is split by update target so repeated npm update and doctor repair passes can shard with other bundled checks.

Current release Docker chunks are `core`, `package-update-openai`, `package-update-anthropic`, `package-update-core`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a`, `plugins-runtime-install-b`, `plugins-runtime-install-c`, `plugins-runtime-install-d`, `bundled-channels-core`, `bundled-channels-update-a`, `bundled-channels-update-b`, and `bundled-channels-contracts`. The aggregate `bundled-channels` chunk remains available for manual one-shot reruns, and `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases, but the release workflow uses the split chunks so channel smokes, update targets, plugin runtime checks, and bundled plugin install/uninstall sweeps can run in parallel. Targeted `docker_lanes` dispatches also split multiple selected lanes into parallel jobs after one shared package/image preparation step, and bundled-channel update lanes retry once for transient npm network failures.

Local changed-lane logic lives in `scripts/changed-lanes.mjs` and is executed by `scripts/check-changed.mjs`. That local check gate is stricter about architecture boundaries than the broad CI platform scope: core production changes run core prod and core test typecheck plus core lint/guards, core test-only changes run only core test typecheck plus core lint, extension production changes run extension prod and extension test typecheck plus extension lint, and extension test-only changes run extension test typecheck plus extension lint. Public Plugin SDK or plugin-contract changes expand to extension typecheck because extensions depend on those core contracts, but Vitest extension sweeps are explicit test work. Release metadata-only version bumps run targeted version/config/root-dependency checks. Unknown root/config changes fail safe to all check lanes.
Local changed-test routing lives in `scripts/test-projects.test-support.mjs` and
is intentionally cheaper than `check:changed`: direct test edits run themselves,
source edits prefer explicit mappings, then sibling tests and import-graph
dependents. Shared group-room delivery config is one of the explicit mappings:
changes to the group visible-reply config, source reply delivery mode, or the
message-tool system prompt route through the core reply tests plus Discord and
Slack delivery regressions so a shared default change fails before the first PR
push. Use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when the change
is harness-wide enough that the cheap mapped set is not a trustworthy proxy.

For Testbox validation, run from the repo root and prefer a fresh warmed box for
broad proof. Before spending a slow gate on a box that was reused, expired, or
just reported an unexpectedly large sync, run `pnpm testbox:sanity` inside the
box first. The sanity check fails fast when required root files such as
`pnpm-lock.yaml` disappeared or when `git status --short` shows at least 200
tracked deletions. That usually means the remote sync state is not a trustworthy
copy of the PR. Stop that box and warm a fresh one instead of debugging the
product test failure. For intentional large deletion PRs, set
`OPENCLAW_TESTBOX_ALLOW_MASS_DELETIONS=1` for that sanity run.

Manual CI dispatches run `checks-node-compat-node22` as release-candidate compatibility coverage. Normal pull requests and `main` pushes skip that lane and keep the matrix focused on the Node 24 test/channel lanes.

The slowest Node test families are split or balanced so each job stays small without over-reserving runners: channel contracts run as three weighted shards, bundled plugin tests balance across six extension workers, small core unit lanes are paired, auto-reply runs as four balanced workers with the reply subtree split into agent-runner, dispatch, and commands/state-routing shards, and agentic gateway/plugin configs are spread across the existing source-only agentic Node jobs instead of waiting on built artifacts. Broad browser, QA, media, and miscellaneous plugin tests use their dedicated Vitest configs instead of the shared plugin catch-all. Extension shard jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap so import-heavy plugin batches do not create extra CI jobs. The broad agents lane uses the shared Vitest file-parallel scheduler because it is import/scheduling dominated rather than owned by a single slow test file. `runtime-config` runs with the infra core-runtime shard to keep the shared runtime shard from owning the tail. Include-pattern shards record timing entries using the CI shard name, so `.artifacts/vitest-shard-timings.json` can distinguish a whole config from a filtered shard. `check-additional` keeps package-boundary compile/canary work together and separates runtime topology architecture from gateway watch coverage; the boundary guard shard runs its small independent guards concurrently inside one job. Gateway watch, channel tests, and the core support-boundary shard run concurrently inside `build-artifacts` after `dist/` and `dist-runtime/` are already built, keeping their old check names as lightweight verifier jobs while avoiding two extra Blacksmith workers and a second artifact-consumer queue.
Android CI runs both `testPlayDebugUnitTest` and `testThirdPartyDebugUnitTest`, then builds the Play debug APK. The third-party flavor has no separate source set or manifest; its unit-test lane still compiles that flavor with the SMS/call-log BuildConfig flags, while avoiding a duplicate debug APK packaging job on every Android-relevant push.
GitHub may mark superseded jobs as `cancelled` when a newer push lands on the same PR or `main` ref. Treat that as CI noise unless the newest run for the same ref is also failing. Aggregate shard checks use `!cancelled() && always()` so they still report normal shard failures but do not queue after the whole workflow has already been superseded.
The automatic CI concurrency key is versioned (`CI-v7-*`) so a GitHub-side zombie in an old queue group cannot indefinitely block newer main runs. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs.

## Runners

| Runner                           | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                   | `preflight`, fast security jobs and aggregates (`security-scm-fast`, `security-dependency-audit`, `security-fast`), fast protocol/contract/bundled checks, sharded channel contract checks, `check` shards except lint, `check-additional` shards and aggregates, Node test aggregate verifiers, docs checks, Python skills, workflow-sanity, labeler, auto-response; install-smoke preflight also uses GitHub-hosted Ubuntu so the Blacksmith matrix can queue earlier |
| `blacksmith-8vcpu-ubuntu-2404`   | `build-artifacts`, build-smoke, Linux Node test shards, bundled plugin test shards, `android`                                                                                                                                                                                                                                                                                                                                                                           |
| `blacksmith-16vcpu-ubuntu-2404`  | `check-lint`, which remains CPU-sensitive enough that 8 vCPU cost more than it saved; install-smoke Docker builds, where 32-vCPU queue time cost more than it saved                                                                                                                                                                                                                                                                                                     |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-6vcpu-macos-latest`  | `macos-node` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blacksmith-12vcpu-macos-latest` | `macos-swift` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                 |

## Local equivalents

```bash
pnpm changed:lanes   # inspect the local changed-lane classifier for origin/main...HEAD
pnpm check:changed   # smart local check gate: changed typecheck/lint/guards by boundary lane
pnpm check          # fast local gate: production tsgo + sharded lint + parallel fast guards
pnpm check:test-types
pnpm check:timed    # same gate with per-stage timings
pnpm build:strict-smoke
pnpm check:architecture
pnpm test:gateway:watch-regression
pnpm test           # vitest tests
pnpm test:changed   # cheap smart changed Vitest targets
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs     # docs format + lint + broken links
pnpm build          # build dist when CI artifact/build-smoke lanes matter
pnpm ci:timings                               # summarize the latest origin/main push CI run
pnpm ci:timings:recent                        # compare recent successful main CI runs
node scripts/ci-run-timings.mjs <run-id>      # summarize wall time, queue time, and slowest jobs
node scripts/ci-run-timings.mjs --latest-main # ignore issue/comment noise and choose origin/main push CI
node scripts/ci-run-timings.mjs --recent 10   # compare recent successful main CI runs
pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json
pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json
```

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
