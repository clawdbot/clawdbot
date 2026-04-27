---
name: openclaw-testing
description: Choose, run, rerun, or debug OpenClaw tests, CI checks, Docker E2E lanes, release validation, and the cheapest safe verification path.
---

# OpenClaw Testing

Use this skill when deciding what to test, debugging failures, rerunning CI,
or validating a change without wasting hours.

## Read First

- `docs/reference/test.md` for local test commands.
- `docs/ci.md` for CI scope, release checks, Docker chunks, and runner behavior.
- Scoped `AGENTS.md` files before editing code under a subtree.

## Default Rule

Prove the touched surface first. Do not reflexively run the whole suite.

1. Inspect the diff and classify the touched surface:
   - source: `pnpm changed:lanes --json`, then `pnpm check:changed`
   - tests only: `pnpm test:changed`
   - one failing file: `pnpm test <path-or-filter> -- --reporter=verbose`
   - workflow-only: `git diff --check`, workflow syntax/lint (`actionlint` when available)
   - docs-only: `pnpm docs:list`, docs formatter/lint only if docs tooling changed or requested
2. Reproduce narrowly before fixing.
3. Fix root cause.
4. Rerun the same narrow proof.
5. Broaden only when the touched contract demands it.

## Guardrails

- Do not kill unrelated processes or tests. If something is running elsewhere, treat it as owned by the user or another agent.
- Do not run expensive local Docker, full release checks, full `pnpm test`, or full `pnpm check` unless the user asks or the change genuinely requires it.
- Prefer GitHub Actions for release/Docker proof when the workflow already has the prepared image and secrets.
- Use `scripts/committer "<msg>" <paths...>` when committing; stage only your files.
- If deps are missing, run `pnpm install`, retry once, then report the first actionable error.

## Local Test Shortcuts

```bash
pnpm changed:lanes --json
pnpm check:changed       # changed typecheck/lint/guards; no Vitest
pnpm test:changed        # cheap smart changed Vitest targets
OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed
pnpm test <path-or-filter> -- --reporter=verbose
OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test <path-or-filter>
```

Use targeted file paths whenever possible. Avoid raw `vitest`; use the repo
`pnpm test` wrapper so project routing, workers, and setup stay correct.

## Command Semantics

- `pnpm check` and `pnpm check:changed` do not run Vitest tests. They are for
  typecheck, lint, and guard proof.
- `pnpm test` and `pnpm test:changed` run Vitest tests.
- `pnpm test:changed` is intentionally cheap by default: direct test edits,
  sibling tests, explicit source mappings, and import-graph dependents.
- `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` is the explicit broad
  fallback for harness/config/package edits that genuinely need it.
- Do not run extension sweeps just because core changed. If a core edit is for a
  specific plugin bug, run that plugin's tests explicitly. If a public SDK or
  contract change needs consumer proof, choose the smallest representative
  plugin/contract tests first, then broaden only when the risk justifies it.
- The test wrapper prints a short `[test] passed|failed|skipped ... in ...`
  line. Vitest's own duration is still the per-shard detail.

## Routing Model

- `pnpm changed:lanes --json` answers "which check lanes does this diff touch?"
  It is used by `pnpm check:changed` for typecheck/lint/guard selection.
- `pnpm test:changed` answers "which Vitest targets are worth running now?" It
  uses the same changed path list, but applies a cheaper test-target resolver.
- Direct test edits run themselves. Source edits prefer explicit mappings,
  sibling `*.test.ts`, then import-graph dependents. Shared harness/config/root
  edits are skipped by default unless they have precise mapped tests.
- Public SDK or contract edits do not automatically run every plugin test.
  `check:changed` proves extension type contracts; the agent chooses the
  smallest plugin/contract Vitest proof that matches the actual risk.
- Use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when a harness,
  config, package, or unknown-root edit really needs the broad Vitest fallback.

## CI Debugging

Start with current run state, not logs for everything:

```bash
gh run list --branch main --limit 10
gh run view <run-id> --json status,conclusion,headSha,url,jobs
gh run view <run-id> --job <job-id> --log
```

- Check exact SHA. Ignore newer unrelated `main` unless asked.
- For cancelled same-branch runs, confirm whether a newer run superseded it.
- Fetch full logs only for failed or relevant jobs.

## GitHub Release Workflows

Use the smallest workflow that proves the current risk. The full umbrella is
available, but it is usually the last step after narrower proof, not the first
rerun after a focused patch.

### Full Release Validation

`Full Release Validation` (`.github/workflows/full-release-validation.yml`) is
the manual "everything before release" umbrella. It resolves a target ref, then
dispatches:

- manual `CI` for the full normal CI graph
- `OpenClaw Release Checks` for install smoke, cross-OS release checks, live and
  E2E checks, Docker release-path suites, OpenWebUI, QA Lab, fast Matrix, and
  Telegram release lanes
- optional post-publish Telegram E2E when a package spec is supplied

Run it only when validating an actual release candidate, after broad shared CI
or release orchestration changes, or when explicitly asked:

```bash
gh workflow run full-release-validation.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f ref=<branch-or-sha> \
  -f workflow_ref=main \
  -f provider=openai \
  -f mode=both
```

If a full run is already active on a newer `origin/main`, prefer watching that
run over dispatching a duplicate. If you accidentally dispatch a stale duplicate,
cancel it and monitor the current run.

### Release Evidence

After release-candidate validation or before a release decision, record the
important run ids in the private `openclaw/releases-private` evidence ledger.
Use the manual `OpenClaw Release Evidence`
(`openclaw-release-evidence.yml`) workflow there. It writes durable summaries
under `evidence/<release-id>/` and commits:

- `release-evidence.md`
- `release-evidence.json`
- `index.json`
- `runs/<label>.json`

Use one run per line:

```text
full-release-validation openclaw/openclaw <run-id> blocking
package-acceptance openclaw/openclaw <run-id> blocking
release-checks openclaw/openclaw <run-id> blocking
```

Store summaries, run URLs, artifact metadata, timings, pass/fail state, and
short release-manager notes there. Do not store raw logs, provider
prompts/responses, channel transcripts, signing material, or secret-bearing
config in git; raw logs stay in Actions artifacts.

When `Full Release Validation` completes and
`OPENCLAW_RELEASES_PRIVATE_DISPATCH_TOKEN` is configured in the public repo, it
requests the private `OpenClaw Release Evidence From Full Validation` workflow.
That private workflow reads the parent full-validation run, extracts the child
CI/release-checks/Telegram run ids from the parent logs, and opens the evidence
PR automatically. If the token is absent or the run predates this wiring, trigger
that private workflow manually with the full-validation run id.

### Release Checks

`OpenClaw Release Checks` (`openclaw-release-checks.yml`) is the release child
workflow. It is broader than normal CI but narrower than the umbrella because it
does not dispatch the separate full normal CI child. It runs Package Acceptance
with `telegram_mode=mock-openai`, so the release package tarball also goes
through Telegram package QA. Use it when release-path validation is needed
without rerunning the entire umbrella.

```bash
gh workflow run openclaw-release-checks.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f ref=<branch-or-sha> \
  -f provider=openai \
  -f mode=both
```

### QA Lab Matrix Profiles

`pnpm openclaw qa matrix` defaults to `--profile all`. Do not assume the CLI
default is the fast release path. Use explicit profiles:

- `--profile fast --fail-fast`: release-critical Matrix transport contract
- `--profile transport|media|e2ee-smoke|e2ee-deep|e2ee-cli`: sharded full
  Matrix proof
- `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS=3000`: CI-friendly no-reply quiet
  window when paired with fast or sharded gates

`QA-Lab - All Lanes` uses explicit fast Matrix on scheduled runs; manual
dispatch keeps `matrix_profile=all` as the default and always shards that full
Matrix selection. `OpenClaw Release Checks` uses explicit fast Matrix; run the
all-lanes workflow when release investigation needs full Matrix media/E2EE
inventory.

### Reusable Live/E2E Checks

`OpenClaw Live And E2E Checks (Reusable)`
(`openclaw-live-and-e2e-checks-reusable.yml`) is the preferred entry point for
targeted live, Docker, model, and E2E proof. Inputs let you turn off unrelated
lanes:

```bash
gh workflow run openclaw-live-and-e2e-checks-reusable.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f ref=<sha> \
  -f include_repo_e2e=false \
  -f include_release_path_suites=false \
  -f include_openwebui=false \
  -f include_live_suites=true \
  -f live_models_only=true \
  -f live_model_providers=fireworks
```

Useful knobs:

- `docker_lanes='<lane[,lane]>'`: run selected Docker scheduler lanes against
  prepared artifacts instead of the three release chunks.
- `include_live_suites=false`: skip live/provider suites when testing Docker
  scheduler or release packaging only.
- `live_models_only=true`: run only Docker live model coverage.
- `live_model_providers=fireworks` (or comma/space separated providers): run one
  targeted Docker live model job instead of the full provider matrix.
- blank `live_model_providers`: run the full live-model provider matrix.

For model-list or provider-selection fixes, use `live_models_only=true` plus the
specific `live_model_providers` allowlist. Confirm logs show the expected
`OPENCLAW_LIVE_PROVIDERS` and selected model ids before declaring proof.

## Docker

Docker is expensive. First inspect the scheduler without running Docker:

```bash
OPENCLAW_DOCKER_ALL_DRY_RUN=1 pnpm test:docker:all
OPENCLAW_DOCKER_ALL_DRY_RUN=1 OPENCLAW_DOCKER_ALL_LANES=install-e2e pnpm test:docker:all
OPENCLAW_DOCKER_ALL_LANES=install-e2e node scripts/test-docker-all.mjs --plan-json
```

Run one failed lane locally only when explicitly asked or when GitHub is not
usable:

```bash
OPENCLAW_DOCKER_ALL_LANES=<lane> \
OPENCLAW_DOCKER_ALL_BUILD=0 \
OPENCLAW_DOCKER_ALL_PREFLIGHT=0 \
OPENCLAW_SKIP_DOCKER_BUILD=1 \
OPENCLAW_DOCKER_E2E_BARE_IMAGE='<prepared-bare-image>' \
OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE='<prepared-functional-image>' \
pnpm test:docker:all
```

For release validation, prefer the reusable GitHub workflow input:

```yaml
docker_lanes: install-e2e
```

Multiple lanes are allowed:

```yaml
docker_lanes: install-e2e bundled-channel-update-acpx
```

That skips the release chunk matrix and runs one targeted Docker job against the
prepared GHCR images and the selected package artifact. Rerun commands
generated inside GitHub artifacts include `package_artifact_run_id`,
`package_artifact_name`, `docker_e2e_bare_image`, and
`docker_e2e_functional_image` when available, so failed lanes can reuse the
exact tarball and prepared images from the failed run. When the fix changes
package contents, omit those reuse inputs so the workflow packs a new tarball.
Live-only targeted reruns skip the E2E images and build only the live-test
image. Release-path normal mode remains max three Docker chunk jobs:

- `core`
- `package-update`
- `plugins-integrations`

OpenWebUI is folded into `plugins-integrations` for full release-path coverage
and keeps a standalone `openwebui` chunk only for OpenWebUI-only dispatches.
The bundled-channel runtime-dependency coverage inside `plugins-integrations`
uses the split `bundled-channel-*` and `bundled-channel-update-*` lanes rather
than the serial `bundled-channel-deps` lane, so failures produce cheap targeted
reruns for the exact channel/update scenario.

## Package Acceptance

Use the manual `Package Acceptance` workflow when the question is "does this
installable package work as a product?" rather than "does this source diff pass
Vitest?"

In release validation, treat Package Acceptance as the package-candidate shard
inside the larger release umbrella, not as a competing full-test path. Full
Release Validation and private release gauntlets should call Package Acceptance
for tarball resolution, Docker product/package proof, and optional Telegram QA
against the same resolved `package-under-test` artifact; keep orchestration,
secret policy, blocking/advisory status, and evidence rollup in the caller.

Good defaults:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=npm \
  -f workflow_ref=main \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f telegram_mode=mock-openai
```

Npm candidate selection:

- Resolve the registry immediately before dispatch:
  `npm view openclaw dist-tags --json --prefer-online --cache /tmp/openclaw-npm-cache-verify-$$`
  and `npm view openclaw@beta version dist.tarball dist.integrity --json --prefer-online --cache /tmp/openclaw-npm-cache-verify-$$`.
- If Peter asks for "latest beta", use `source=npm` with
  `package_spec=openclaw@beta`, then record the resolved version from `npm view`
  or the workflow summary.
- For reruns, release proof, or comparing one known package, prefer the exact
  immutable spec: `package_spec=openclaw@YYYY.M.D-beta.N` or
  `package_spec=openclaw@YYYY.M.D`.
- For stable package proof, use `package_spec=openclaw@latest` only when the
  question is explicitly the current stable dist-tag; otherwise pin the exact
  version.
- `source=npm` only accepts registry specs for `openclaw@beta`,
  `openclaw@latest`, or exact OpenClaw release versions. Do not pass semver
  ranges, git refs, file paths, tarball URLs, or plugin package names there.
- If the candidate is a tarball URL, use `source=url` with `package_sha256`. If
  it is an Actions tarball artifact, use `source=artifact`. If it is an
  unpublished source candidate, use `source=ref` with a trusted ref or SHA.
- Package acceptance tests exactly the selected package candidate. Do not apply
  `openclaw update --channel beta` fallback semantics here; if `beta` is absent,
  stale, older than `latest`, or points at a broken tarball, report that tag
  state instead of silently testing `latest`.

Profiles:

- `smoke`: quick confidence that the tarball installs, can onboard a channel,
  can run an agent turn, and basic gateway/config lanes work.
- `package`: release-package contract. Adds installer/update, doctor install
  switching, bundled plugin runtime deps, plugin install/update, and package
  repair lanes. This is the default native replacement for most Parallels
  package/update coverage.
- `product`: package profile plus broader product surfaces: MCP channels,
  cron/subagent cleanup, OpenAI web search, and OpenWebUI.
- `full`: split Docker release-path chunks with OpenWebUI.
- `custom`: exact `docker_lanes` list for a focused rerun.

Candidate sources:

- `source=npm`: `openclaw@beta`, `openclaw@latest`, or an exact release version.
- `source=ref`: pack `package_ref` using the trusted `workflow_ref` harness.
  This intentionally separates old package commits from new workflow/test code.
- `source=url`: HTTPS `.tgz` plus required `package_sha256`.
- `source=artifact`: download one `.tgz` from `artifact_run_id`/`artifact_name`.

Ref model:

- `gh workflow run ... --ref <workflow-ref>` selects the workflow file revision
  GitHub executes.
- `workflow_ref` is the trusted harness/script ref passed to reusable Docker
  E2E.
- `package_ref` is the source ref to build when `source=ref`. It can be an
  older branch/tag/SHA as long as it is reachable from an OpenClaw branch or
  release tag.

Example: run latest package acceptance harness against an older trusted commit:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=<branch-or-sha> \
  -f suite_profile=package \
  -f telegram_mode=mock-openai
```

Use `telegram_mode=mock-openai` or `telegram_mode=live-frontier` when the same
resolved `package-under-test` tarball should also run through the Telegram QA
workflow in the `qa-live-shared` environment. The standalone Telegram workflow
still accepts a published npm spec for post-publish checks, but Package
Acceptance passes the resolved artifact for `source=npm`, `ref`, `url`, and
`artifact`. Use `telegram_mode=none` only when intentionally skipping Telegram
credentialed package proof for a focused rerun.

Docker E2E images never copy repo sources as the app under test: the bare image
is a Node/Git runner, and the functional image installs the same prebuilt npm
tarball that bare lanes mount. `scripts/package-openclaw-for-docker.mjs` is the
single packer for local scripts and CI and validates the tarball inventory
before Docker consumes it. `scripts/test-docker-all.mjs --plan-json` is the
scheduler-owned CI plan for image kind, package, live image, lane, and
credential needs. Docker lane definitions live in the single scenario catalog
`scripts/lib/docker-e2e-scenarios.mjs`; planner logic lives in
`scripts/lib/docker-e2e-plan.mjs`. `scripts/docker-e2e.mjs` converts plan and
summary JSON into GitHub outputs and step summaries. Every scheduler run writes
`.artifacts/docker-tests/**/summary.json` plus `failures.json`. Read those
before rerunning. Lane entries include `command`, `rerunCommand`, status,
timing, timeout state, image kind, and log file path. The summary also includes
top-level phase timings for preflight, image build, package prep, lane pools,
and cleanup. Use `pnpm test:docker:timings <summary.json>` to rank slow lanes
and phases before deciding whether a broader rerun is justified.

## Cheap Docker Reruns

First derive the smallest rerun command from artifacts:

```bash
pnpm test:docker:rerun <github-run-id>
pnpm test:docker:rerun .artifacts/docker-tests/<run>/failures.json
```

The script downloads Docker E2E artifacts for a GitHub run, reads
`summary.json`/`failures.json`, and prints a combined targeted workflow command
plus per-lane commands. Prefer the combined targeted command when several lanes
failed for the same patch:

```bash
gh workflow run openclaw-live-and-e2e-checks-reusable.yml \
  -f ref=<sha> \
  -f include_repo_e2e=false \
  -f include_release_path_suites=false \
  -f include_openwebui=false \
  -f docker_lanes='install-e2e bundled-channel-update-acpx' \
  -f include_live_suites=false \
  -f live_models_only=false
```

That path still runs the prepare job, so it creates a new tarball for `<sha>`.
If the SHA-tagged GHCR bare/functional image already exists, CI skips rebuilding
that image and only uploads the fresh package artifact before the targeted lane
job. Do not rerun the full three-chunk release path unless the failed lane list
or touched surface really requires it.

## Docker Expected Timings

Treat these as ballpark. Blacksmith queue time, GHCR pull speed, provider
latency, npm cache state, and Docker daemon health can dominate.

Current local timing artifact (`.artifacts/docker-tests/lane-timings.json`) has
these rough bands:

- Tiny lanes, seconds to under 1 minute:
  `agents-delete-shared-workspace` ~3s, `plugin-update` ~7s,
  `config-reload` ~14s, `pi-bundle-mcp-tools` ~15s, `onboard` ~18s,
  `session-runtime-context` ~20s, `gateway-network` ~34s, `qr` ~44s.
- Medium deterministic lanes, ~1-5 minutes:
  `npm-onboard-channel-agent` ~96s, `openai-image-auth` ~99s,
  bundled channel/update lanes usually ~90-300s when split, `openwebui` ~225s,
  `mcp-channels` ~274s.
- Heavy deterministic lanes, ~6-10 minutes:
  `bundled-channel-root-owned` ~429s,
  `bundled-channel-setup-entry` ~420s,
  `bundled-channel-load-failure` ~383s,
  `cron-mcp-cleanup` ~567s.
- Live provider lanes, often ~15-20 minutes:
  `live-gateway` ~958s, `live-models` ~1054s.
- Installer/release lanes:
  `install-e2e` and package-update paths can vary widely with npm, provider,
  and package registry behavior. Budget tens of minutes; prefer GitHub targeted
  reruns over local repeats.

Default fallback lane timeout is 120 minutes. A timeout usually means debug the
lane log/artifacts first, not “run the whole thing again.”

## Failure Workflow

1. Identify exact failing job, SHA, lane, and artifact path.
2. Read `failures.json`, `summary.json`, and the failed lane log tail.
3. Use `pnpm test:docker:rerun <run-id|failures.json>` to generate targeted
   GitHub rerun commands.
4. If the lane has `rerunCommand`, use that only as a local starting point.
5. For Docker release failures, dispatch targeted `docker_lanes=<failed-lane>`
   on GitHub before considering local Docker.
6. Patch narrowly, then rerun the failed file/lane only.
7. Broaden to `pnpm check:changed` or CI only after the isolated proof passes.

## When To Escalate

- Public SDK/plugin contract changes: run changed gate plus relevant extension
  validation.
- Build output, lazy imports, package boundaries, or published surfaces:
  include `pnpm build`.
- Workflow edits: run `pnpm check:workflows`.
- Release branch or tag validation: use release docs and GitHub workflows; avoid
  local Docker unless Peter explicitly asks.
