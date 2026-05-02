---
summary: "Testing kit: unit/e2e/live suites, Docker runners, and what each test covers"
read_when:
  - Running tests locally or in CI
  - Adding regressions for model/provider bugs
  - Debugging gateway + agent behavior
title: "Testing"
---

OpenClaw has three Vitest suites (unit/integration, e2e, live) and a small set
of Docker runners. This doc is a "how we test" guide:

- What each suite covers (and what it deliberately does _not_ cover).
- Which commands to run for common workflows (local, pre-push, debugging).
- How live tests discover credentials and select models/providers.
- How to add regressions for real-world model/provider issues.

<Note>
**QA stack (qa-lab, qa-channel, live transport lanes)** is documented separately:

- [QA overview](/concepts/qa-e2e-automation) — architecture, command surface, scenario authoring.
- [Matrix QA](/concepts/qa-matrix) — reference for `pnpm openclaw qa matrix`.
- [QA channel](/channels/qa-channel) — the synthetic transport plugin used by repo-backed scenarios.

This page covers running the regular test suites and Docker/Parallels runners. The QA-specific runners section below ([QA-specific runners](#qa-specific-runners)) lists the concrete `qa` invocations and points back at the references above.
</Note>

## Quick start

Most days:

- Full gate (expected before push): `pnpm build && pnpm check && pnpm check:test-types && pnpm test`
- Faster local full-suite run on a roomy machine: `pnpm test:max`
- Direct Vitest watch loop: `pnpm test:watch`
- Direct file targeting now routes extension/channel paths too: `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts`
- Prefer targeted runs first when you are iterating on a single failure.
- Docker-backed QA site: `pnpm qa:lab:up`
- Linux VM-backed QA lane: `pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline`

When you touch tests or want extra confidence:

- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

When debugging real providers/models (requires real creds):

- Live suite (models + gateway tool/image probes): `pnpm test:live`
- Target one live file quietly: `pnpm test:live -- src/agents/models.profiles.live.test.ts`
- Docker live model sweep: `pnpm test:docker:live-models`
  - Each selected model now runs a text turn plus a small file-read-style probe.
    Models whose metadata advertises `image` input also run a tiny image turn.
    Disable the extra probes with `OPENCLAW_LIVE_MODEL_FILE_PROBE=0` or
    `OPENCLAW_LIVE_MODEL_IMAGE_PROBE=0` when isolating provider failures.
  - CI coverage: daily `OpenClaw Scheduled Live And E2E Checks` and manual
    `OpenClaw Release Checks` both call the reusable live/E2E workflow with
    `include_live_suites: true`, which includes separate Docker live model
    matrix jobs sharded by provider.
  - For focused CI reruns, dispatch `OpenClaw Live And E2E Checks (Reusable)`
    with `include_live_suites: true` and `live_models_only: true`.
  - Add new high-signal provider secrets to `scripts/ci-hydrate-live-auth.sh`
    plus `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml` and its
    scheduled/release callers.
- Native Codex bound-chat smoke: `pnpm test:docker:live-codex-bind`
  - Runs a Docker live lane against the Codex app-server path, binds a synthetic
    Slack DM with `/codex bind`, exercises `/codex fast` and
    `/codex permissions`, then verifies a plain reply and an image attachment
    route through the native plugin binding instead of ACP.
- Codex app-server harness smoke: `pnpm test:docker:live-codex-harness`
  - Runs gateway agent turns through the plugin-owned Codex app-server harness,
    verifies `/codex status` and `/codex models`, and by default exercises image,
    cron MCP, sub-agent, and Guardian probes. Disable the sub-agent probe with
    `OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE=0` when isolating other Codex
    app-server failures. For a focused sub-agent check, disable the other probes:
    `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE=1 pnpm test:docker:live-codex-harness`.
    This exits after the sub-agent probe unless
    `OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_ONLY=0` is set.
- Crestodian rescue command smoke: `pnpm test:live:crestodian-rescue-channel`
  - Opt-in belt-and-suspenders check for the message-channel rescue command
    surface. It exercises `/crestodian status`, queues a persistent model
    change, replies `/crestodian yes`, and verifies the audit/config write path.
- Crestodian planner Docker smoke: `pnpm test:docker:crestodian-planner`
  - Runs Crestodian in a configless container with a fake Claude CLI on `PATH`
    and verifies the fuzzy planner fallback translates into an audited typed
    config write.
- Crestodian first-run Docker smoke: `pnpm test:docker:crestodian-first-run`
  - Starts from an empty OpenClaw state dir, routes bare `openclaw` to
    Crestodian, applies setup/model/agent/Discord plugin + SecretRef writes,
    validates config, and verifies audit entries. The same Ring 0 setup path is
    also covered in QA Lab by
    `pnpm openclaw qa suite --scenario crestodian-ring-zero-setup`.
- Moonshot/Kimi cost smoke: with `MOONSHOT_API_KEY` set, run
  `openclaw models list --provider moonshot --json`, then run an isolated
  `openclaw agent --local --session-id live-kimi-cost --message 'Reply exactly: KIMI_LIVE_OK' --thinking off --json`
  against `moonshot/kimi-k2.6`. Verify the JSON reports Moonshot/K2.6 and the
  assistant transcript stores normalized `usage.cost`.

<Tip>
When you only need one failing case, prefer narrowing live tests via the allowlist env vars described below.
</Tip>

## QA-specific runners

These commands sit beside the main test suites when you need QA-lab realism:

CI runs QA Lab in dedicated workflows. `Parity gate` runs on matching PRs and
from manual dispatch with mock providers. `QA-Lab - All Lanes` runs nightly on
`main` and from manual dispatch with the mock parity gate, live Matrix lane,
Convex-managed live Telegram lane, and Convex-managed live Discord lane as
parallel jobs. Scheduled QA and release checks pass Matrix `--profile fast`
explicitly, while the Matrix CLI and manual workflow input default remain
`all`; manual dispatch can shard `all` into `transport`, `media`, `e2ee-smoke`,
`e2ee-deep`, and `e2ee-cli` jobs. `OpenClaw Release Checks` runs parity plus
the fast Matrix and Telegram lanes before release approval, using
`mock-openai/gpt-5.5` for release transport checks so they stay deterministic
and avoid normal provider-plugin startup. These live transport gateways disable
memory search; memory behavior stays covered by the QA parity suites.

Full release live media shards use
`ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, which already has
`ffmpeg` and `ffprobe`. Docker live model/backend shards use the shared
`ghcr.io/openclaw/openclaw-live-test:<sha>` image built once per selected
commit, then pull it with `OPENCLAW_SKIP_DOCKER_BUILD=1` instead of rebuilding
inside every shard.

- `pnpm openclaw qa suite`
  - Runs repo-backed QA scenarios directly on the host.
  - Runs multiple selected scenarios in parallel by default with isolated
    gateway workers. `qa-channel` defaults to concurrency 4 (bounded by the
    selected scenario count). Use `--concurrency <count>` to tune the worker
    count, or `--concurrency 1` for the older serial lane.
  - Exits non-zero when any scenario fails. Use `--allow-failures` when you
    want artifacts without a failing exit code.
  - Supports provider modes `live-frontier`, `mock-openai`, and `aimock`.
    `aimock` starts a local AIMock-backed provider server for experimental
    fixture and protocol-mock coverage without replacing the scenario-aware
    `mock-openai` lane.
- `pnpm test:gateway:cpu-scenarios`
  - Runs the gateway startup bench plus a small mock QA Lab scenario pack
    (`channel-chat-baseline`, `memory-failure-fallback`,
    `gateway-restart-inflight-run`) and writes a combined CPU observation
    summary under `.artifacts/gateway-cpu-scenarios/`.
  - Flags only sustained hot CPU observations by default (`--cpu-core-warn`
    plus `--hot-wall-warn-ms`), so short startup bursts are recorded as metrics
    without looking like the minutes-long gateway peg regression.
  - Uses built `dist` artifacts; run a build first when the checkout does not
    already have fresh runtime output.
- `pnpm openclaw qa suite --runner multipass`
  - Runs the same QA suite inside a disposable Multipass Linux VM.
  - Keeps the same scenario-selection behavior as `qa suite` on the host.
  - Reuses the same provider/model selection flags as `qa suite`.
  - Live runs forward the supported QA auth inputs that are practical for the guest:
    env-based provider keys, the QA live provider config path, and `CODEX_HOME`
    when present.
  - Output dirs must stay under the repo root so the guest can write back through
    the mounted workspace.
  - Writes the normal QA report + summary plus Multipass logs under
    `.artifacts/qa-e2e/...`.
- `pnpm qa:lab:up`
  - Starts the Docker-backed QA site for operator-style QA work.
- `pnpm test:docker:npm-onboard-channel-agent`
  - Builds an npm tarball from the current checkout, installs it globally in
    Docker, runs non-interactive OpenAI API-key onboarding, configures Telegram
    by default, verifies the packaged plugin runtime loads without startup
    dependency repair, runs doctor, and runs one local agent turn against a
    mocked OpenAI endpoint.
  - Use `OPENCLAW_NPM_ONBOARD_CHANNEL=discord` to run the same packaged-install
    lane with Discord.
- `pnpm test:docker:session-runtime-context`
  - Runs a deterministic built-app Docker smoke for embedded runtime context
    transcripts. It verifies hidden OpenClaw runtime context is persisted as a
    non-display custom message instead of leaking into the visible user turn,
    then seeds an affected broken session JSONL and verifies
    `openclaw doctor --fix` rewrites it to the active branch with a backup.
- `pnpm test:docker:npm-telegram-live`
  - Installs an OpenClaw package candidate in Docker, runs installed-package
    onboarding, configures Telegram through the installed CLI, then reuses the
    live Telegram QA lane with that installed package as the SUT Gateway.
  - Defaults to `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC=openclaw@beta`; set
    `OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ=/path/to/openclaw-current.tgz` or
    `OPENCLAW_CURRENT_PACKAGE_TGZ` to test a resolved local tarball instead of
    installing from the registry.
  - Uses the same Telegram env credentials or Convex credential source as
    `pnpm openclaw qa telegram`. For CI/release automation, set
    `OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE=convex` plus
    `OPENCLAW_QA_CONVEX_SITE_URL` and the role secret. If
    `OPENCLAW_QA_CONVEX_SITE_URL` and a Convex role secret are present in CI,
    the Docker wrapper selects Convex automatically.
  - `OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=ci|maintainer` overrides the shared
    `OPENCLAW_QA_CREDENTIAL_ROLE` for this lane only.
  - GitHub Actions exposes this lane as the manual maintainer workflow
    `NPM Telegram Beta E2E`. It does not run on merge. The workflow uses the
    `qa-live-shared` environment and Convex CI credential leases.
- GitHub Actions also exposes `Package Acceptance` for side-run product proof
  against one candidate package. It accepts a trusted ref, published npm spec,
  HTTPS tarball URL plus SHA-256, or tarball artifact from another run, uploads
  the normalized `openclaw-current.tgz` as `package-under-test`, then runs the
  existing Docker E2E scheduler with smoke, package, product, full, or custom
  lane profiles. Set `telegram_mode=mock-openai` or `live-frontier` to run the
  Telegram QA workflow against the same `package-under-test` artifact.
  - Latest beta product proof:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f telegram_mode=mock-openai
```

- Exact tarball URL proof requires a digest:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=url \
  -f package_url=https://registry.npmjs.org/openclaw/-/openclaw-VERSION.tgz \
  -f package_sha256=<sha256> \
  -f suite_profile=package
```

- Artifact proof downloads a tarball artifact from another Actions run:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=artifact \
  -f artifact_run_id=<run-id> \
  -f artifact_name=<artifact-name> \
  -f suite_profile=smoke
```

- `pnpm test:docker:plugins`
  - Packs and installs the current OpenClaw build in Docker, starts the Gateway
    with OpenAI configured, then enables bundled channel/plugins via config
    edits.
  - Verifies setup discovery leaves unconfigured downloadable plugins absent,
    the first configured doctor repair installs each missing downloadable
    plugin explicitly, and a second restart does not run hidden dependency
    repair.
  - Also installs a known older npm baseline, enables Telegram before running
    `openclaw update --tag <candidate>`, and verifies the candidate's
    post-update doctor cleans legacy plugin dependency debris without a
    harness-side postinstall repair.
- `pnpm test:parallels:npm-update`
  - Runs the native packaged-install update smoke across Parallels guests. Each
    selected platform first installs the requested baseline package, then runs
    the installed `openclaw update` command in the same guest and verifies the
    installed version, update status, gateway readiness, and one local agent
    turn.
  - Use `--platform macos`, `--platform windows`, or `--platform linux` while
    iterating on one guest. Use `--json` for the summary artifact path and
    per-lane status.
  - The OpenAI lane uses `openai/gpt-5.5` for the live agent-turn proof by
    default. Pass `--model <provider/model>` or set
    `OPENCLAW_PARALLELS_OPENAI_MODEL` when deliberately validating another
    OpenAI model.
  - Wrap long local runs in a host timeout so Parallels transport stalls cannot
    consume the rest of the testing window:

    ```bash
    timeout --foreground 150m pnpm test:parallels:npm-update -- --json
    timeout --foreground 90m pnpm test:parallels:npm-update -- --platform windows --json
    ```

  - The script writes nested lane logs under `/tmp/openclaw-parallels-npm-update.*`.
    Inspect `windows-update.log`, `macos-update.log`, or `linux-update.log`
    before assuming the outer wrapper is hung.
  - Windows update can spend 10 to 15 minutes in post-update doctor and package
    update work on a cold guest; that is still healthy when the nested npm
    debug log is advancing.
  - Do not run this aggregate wrapper in parallel with individual Parallels
    macOS, Windows, or Linux smoke lanes. They share VM state and can collide on
    snapshot restore, package serving, or guest gateway state.
  - The post-update proof runs the normal bundled plugin surface because
    capability facades such as speech, image generation, and media
    understanding are loaded through bundled runtime APIs even when the agent
    turn itself only checks a simple text response.

- `pnpm openclaw qa aimock`
  - Starts only the local AIMock provider server for direct protocol smoke
    testing.
- `pnpm openclaw qa matrix`
  - Runs the Matrix live QA lane against a disposable Docker-backed Tuwunel homeserver. Source-checkout only — packaged installs do not ship `qa-lab`.
  - Full CLI, profile/scenario catalog, env vars, and artifact layout: [Matrix QA](/concepts/qa-matrix).
- `pnpm openclaw qa telegram`
  - Runs the Telegram live QA lane against a real private group using the driver and SUT bot tokens from env.
  - Requires `OPENCLAW_QA_TELEGRAM_GROUP_ID`, `OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`, and `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`. The group id must be the numeric Telegram chat id.
  - Supports `--credential-source convex` for shared pooled credentials. Use env mode by default, or set `OPENCLAW_QA_CREDENTIAL_SOURCE=convex` to opt into pooled leases.
  - Exits non-zero when any scenario fails. Use `--allow-failures` when you
    want artifacts without a failing exit code.
  - Requires two distinct bots in the same private group, with the SUT bot exposing a Telegram username.
  - For stable bot-to-bot observation, enable Bot-to-Bot Communication Mode in `@BotFather` for both bots and ensure the driver bot can observe group bot traffic.
  - Writes a Telegram QA report, summary, and observed-messages artifact under `.artifacts/qa-e2e/...`. Replying scenarios include RTT from driver send request to observed SUT reply.

Live transport lanes share one standard contract so new transports do not drift; the per-lane coverage matrix lives in [QA overview → Live transport coverage](/concepts/qa-e2e-automation#live-transport-coverage). `qa-channel` is the broad synthetic suite and is not part of that matrix.

### Shared Telegram credentials via Convex (v1)

When `--credential-source convex` (or `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`) is enabled for
`openclaw qa telegram`, QA lab acquires an exclusive lease from a Convex-backed pool, heartbeats
that lease while the lane is running, and releases the lease on shutdown.

Reference Convex project scaffold:

- `qa/convex-credential-broker/`

Required env vars:

- `OPENCLAW_QA_CONVEX_SITE_URL` (for example `https://your-deployment.convex.site`)
- One secret for the selected role:
  - `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` for `maintainer`
  - `OPENCLAW_QA_CONVEX_SECRET_CI` for `ci`
- Credential role selection:
  - CLI: `--credential-role maintainer|ci`
  - Env default: `OPENCLAW_QA_CREDENTIAL_ROLE` (defaults to `ci` in CI, `maintainer` otherwise)

Optional env vars:

- `OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS` (default `1200000`)
- `OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS` (default `30000`)
- `OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS` (default `90000`)
- `OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS` (default `15000`)
- `OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX` (default `/qa-credentials/v1`)
- `OPENCLAW_QA_CREDENTIAL_OWNER_ID` (optional trace id)
- `OPENCLAW_QA_ALLOW_INSECURE_HTTP=1` allows loopback `http://` Convex URLs for local-only development.

`OPENCLAW_QA_CONVEX_SITE_URL` should use `https://` in normal operation.

Maintainer admin commands (pool add/remove/list) require
`OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` specifically.

CLI helpers for maintainers:

```bash
pnpm openclaw qa credentials doctor
pnpm openclaw qa credentials add --kind telegram --payload-file qa/telegram-credential.json
pnpm openclaw qa credentials list --kind telegram
pnpm openclaw qa credentials remove --credential-id <credential-id>
```

Use `doctor` before live runs to check the Convex site URL, broker secrets,
endpoint prefix, HTTP timeout, and admin/list reachability without printing
secret values. Use `--json` for machine-readable output in scripts and CI
utilities.

Default endpoint contract (`OPENCLAW_QA_CONVEX_SITE_URL` + `/qa-credentials/v1`):

- `POST /acquire`
  - Request: `{ kind, ownerId, actorRole, leaseTtlMs, heartbeatIntervalMs }`
  - Success: `{ status: "ok", credentialId, leaseToken, payload, leaseTtlMs?, heartbeatIntervalMs? }`
  - Exhausted/retryable: `{ status: "error", code: "POOL_EXHAUSTED" | "NO_CREDENTIAL_AVAILABLE", ... }`
- `POST /heartbeat`
  - Request: `{ kind, ownerId, actorRole, credentialId, leaseToken, leaseTtlMs }`
  - Success: `{ status: "ok" }` (or empty `2xx`)
- `POST /release`
  - Request: `{ kind, ownerId, actorRole, credentialId, leaseToken }`
  - Success: `{ status: "ok" }` (or empty `2xx`)
- `POST /admin/add` (maintainer secret only)
  - Request: `{ kind, actorId, payload, note?, status? }`
  - Success: `{ status: "ok", credential }`
- `POST /admin/remove` (maintainer secret only)
  - Request: `{ credentialId, actorId }`
  - Success: `{ status: "ok", changed, credential }`
  - Active lease guard: `{ status: "error", code: "LEASE_ACTIVE", ... }`
- `POST /admin/list` (maintainer secret only)
  - Request: `{ kind?, status?, includePayload?, limit? }`
  - Success: `{ status: "ok", credentials, count }`

Payload shape for Telegram kind:

- `{ groupId: string, driverToken: string, sutToken: string }`
- `groupId` must be a numeric Telegram chat id string.
- `admin/add` validates this shape for `kind: "telegram"` and rejects malformed payloads.

### Adding a channel to QA

The architecture and scenario-helper names for new channel adapters live in [QA overview → Adding a channel](/concepts/qa-e2e-automation#adding-a-channel). The minimum bar: implement the transport runner on the shared `qa-lab` host seam, declare `qaRunners` in the plugin manifest, mount as `openclaw qa <runner>`, and author scenarios under `qa/scenarios/`.

## Test suites (what runs where)

Think of the suites as “increasing realism” (and increasing flakiness/cost):

### Unit / integration (default)

- Command: `pnpm test`
- Config: untargeted runs use the `vitest.full-*.config.ts` shard set and may expand multi-project shards into per-project configs for parallel scheduling
- Files: core/unit inventories under `src/**/*.test.ts`, `packages/**/*.test.ts`, and `test/**/*.test.ts`; UI unit tests run in the dedicated `unit-ui` shard
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Deterministic regressions for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable
  - Resolver and public-surface loader tests must prove broad `api.js` and
    `runtime-api.js` fallback behavior with generated tiny plugin fixtures, not
    real bundled plugin source APIs. Real plugin API loads belong in
    plugin-owned contract/integration suites.

<AccordionGroup>
  <Accordion title="Projects, shards, and scoped lanes">

    - Untargeted `pnpm test` runs twelve smaller shard configs (`core-unit-fast`, `core-unit-src`, `core-unit-security`, `core-unit-ui`, `core-unit-support`, `core-support-boundary`, `core-contracts`, `core-bundled`, `core-runtime`, `agentic`, `auto-reply`, `extensions`) instead of one giant native root-project process. This cuts peak RSS on loaded machines and avoids auto-reply/extension work starving unrelated suites.
    - `pnpm test --watch` still uses the native root `vitest.config.ts` project graph, because a multi-shard watch loop is not practical.
    - `pnpm test`, `pnpm test:watch`, and `pnpm test:perf:imports` route explicit file/directory targets through scoped lanes first, so `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts` avoids paying the full root project startup tax.
    - `pnpm test:changed` expands changed git paths into cheap scoped lanes by default: direct test edits, sibling `*.test.ts` files, explicit source mappings, and local import-graph dependents. Config/setup/package edits do not broad-run tests unless you explicitly use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed`.
    - `pnpm check:changed` is the normal smart local check gate for narrow work. It classifies the diff into core, core tests, extensions, extension tests, apps, docs, release metadata, live Docker tooling, and tooling, then runs the matching typecheck, lint, and guard commands. It does not run Vitest tests; call `pnpm test:changed` or explicit `pnpm test <target>` for test proof. Release metadata-only version bumps run targeted version/config/root-dependency checks, with a guard that rejects package changes outside the top-level version field.
    - Live Docker ACP harness edits run focused checks: shell syntax for the live Docker auth scripts and a live Docker scheduler dry-run. `package.json` changes are included only when the diff is limited to `scripts["test:docker:live-*"]`; dependency, export, version, and other package-surface edits still use the broader guards.
    - Import-light unit tests from agents, commands, plugins, auto-reply helpers, `plugin-sdk`, and similar pure utility areas route through the `unit-fast` lane, which skips `test/setup-openclaw-runtime.ts`; stateful/runtime-heavy files stay on the existing lanes.
    - Selected `plugin-sdk` and `commands` helper source files also map changed-mode runs to explicit sibling tests in those light lanes, so helper edits avoid rerunning the full heavy suite for that directory.
    - `auto-reply` has dedicated buckets for top-level core helpers, top-level `reply.*` integration tests, and the `src/auto-reply/reply/**` subtree. CI further splits the reply subtree into agent-runner, dispatch, and commands/state-routing shards so one import-heavy bucket does not own the full Node tail.
    - Normal PR/main CI intentionally skips the extension batch sweep and release-only `agentic-plugins` shard. Full Release Validation dispatches the separate `Plugin Prerelease` child workflow for those plugin/extension-heavy suites on release candidates.

  </Accordion>

  <Accordion title="Embedded runner coverage">

    - When you change message-tool discovery inputs or compaction runtime
      context, keep both levels of coverage.
    - Add focused helper regressions for pure routing and normalization
      boundaries.
    - Keep the embedded runner integration suites healthy:
      `src/agents/pi-embedded-runner/compact.hooks.test.ts`,
      `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`, and
      `src/agents/pi-embedded-runner/run.overflow-compaction.loop.test.ts`.
    - Those suites verify that scoped ids and compaction behavior still flow
      through the real `run.ts` / `compact.ts` paths; helper-only tests are
      not a sufficient substitute for those integration paths.

  </Accordion>

  <Accordion title="Vitest pool and isolation defaults">

    - Base Vitest config defaults to `threads`.
    - The shared Vitest config fixes `isolate: false` and uses the
      non-isolated runner across the root projects, e2e, and live configs.
    - The root UI lane keeps its `jsdom` setup and optimizer, but runs on the
      shared non-isolated runner too.
    - Each `pnpm test` shard inherits the same `threads` + `isolate: false`
      defaults from the shared Vitest config.
    - `scripts/run-vitest.mjs` adds `--no-maglev` for Vitest child Node
      processes by default to reduce V8 compile churn during big local runs.
      Set `OPENCLAW_VITEST_ENABLE_MAGLEV=1` to compare against stock V8
      behavior.

  </Accordion>

  <Accordion title="Fast local iteration">

    - `pnpm changed:lanes` shows which architectural lanes a diff triggers.
    - The pre-commit hook is formatting-only. It restages formatted files and
      does not run lint, typecheck, or tests.
    - Run `pnpm check:changed` explicitly before handoff or push when you
      need the smart local check gate.
    - `pnpm test:changed` routes through cheap scoped lanes by default. Use
      `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when the agent
      decides a harness, config, package, or contract edit really needs broader
      Vitest coverage.
    - `pnpm test:max` and `pnpm test:changed:max` keep the same routing
      behavior, just with a higher worker cap.
    - Local worker auto-scaling is intentionally conservative and backs off
      when the host load average is already high, so multiple concurrent
      Vitest runs do less damage by default.
    - The base Vitest config marks the projects/config files as
      `forceRerunTriggers` so changed-mode reruns stay correct when test
      wiring changes.
    - The config keeps `OPENCLAW_VITEST_FS_MODULE_CACHE` enabled on supported
      hosts; set `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/abs/path` if you want
      one explicit cache location for direct profiling.

  </Accordion>

  <Accordion title="Perf debugging">

    - `pnpm test:perf:imports` enables Vitest import-duration reporting plus
      import-breakdown output.
    - `pnpm test:perf:imports:changed` scopes the same profiling view to
      files changed since `origin/main`.
    - Shard timing data is written to `.artifacts/vitest-shard-timings.json`.
      Whole-config runs use the config path as the key; include-pattern CI
      shards append the shard name so filtered shards can be tracked
      separately.
    - When one hot test still spends most of its time in startup imports,
      keep heavy dependencies behind a narrow local `*.runtime.ts` seam and
      mock that seam directly instead of deep-importing runtime helpers just
      to pass them through `vi.mock(...)`.
    - `pnpm test:perf:changed:bench -- --ref <git-ref>` compares routed
      `test:changed` against the native root-project path for that committed
      diff and prints wall time plus macOS max RSS.
    - `pnpm test:perf:changed:bench -- --worktree` benchmarks the current
      dirty tree by routing the changed file list through
      `scripts/test-projects.mjs` and the root Vitest config.
    - `pnpm test:perf:profile:main` writes a main-thread CPU profile for
      Vitest/Vite startup and transform overhead.
    - `pnpm test:perf:profile:runner` writes runner CPU+heap profiles for the
      unit suite with file parallelism disabled.

  </Accordion>
</AccordionGroup>

### Stability (gateway)

- Command: `pnpm test:stability:gateway`
- Config: `vitest.gateway.config.ts`, forced to one worker
- Scope:
  - Starts a real loopback Gateway with diagnostics enabled by default
  - Drives synthetic gateway message, memory, and large-payload churn through the diagnostic event path
  - Queries `diagnostics.stability` over the Gateway WS RPC
  - Covers diagnostic stability bundle persistence helpers
  - Asserts the recorder remains bounded, synthetic RSS samples stay under the pressure budget, and per-session queue depths drain back to zero
- Expectations:
  - CI-safe and keyless
  - Narrow lane for stability-regression follow-up, not a substitute for the full Gateway suite

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`, `test/**/*.e2e.test.ts`, and bundled-plugin E2E tests under `extensions/`
- Runtime defaults:
  - Uses Vitest `threads` with `isolate: false`, matching the rest of the repo.
  - Uses adaptive workers (CI: up to 2, local: 1 by default).
  - Runs in silent mode by default to reduce console I/O overhead.
- Useful overrides:
  - `OPENCLAW_E2E_WORKERS=<n>` to force worker count (capped at 16).
  - `OPENCLAW_E2E_VERBOSE=1` to re-enable verbose console output.
- Scope:
  - Multi-instance gateway end-to-end behavior
  - WebSocket/HTTP surfaces, node pairing, and heavier networking
- Expectations:
  - Runs in CI (when enabled in the pipeline)
  - No real keys required
  - More moving parts than unit tests (can be slower)

### E2E: OpenShell backend smoke

- Command: `pnpm test:e2e:openshell`
- File: `extensions/openshell/src/backend.e2e.test.ts`
- Scope:
  - Starts an isolated OpenShell gateway on the host via Docker
  - Creates a sandbox from a temporary local Dockerfile
  - Exercises OpenClaw's OpenShell backend over real `sandbox ssh-config` + SSH exec
  - Verifies remote-canonical filesystem behavior through the sandbox fs bridge
- Expectations:
  - Opt-in only; not part of the default `pnpm test:e2e` run
  - Requires a local `openshell` CLI plus a working Docker daemon
  - Uses isolated `HOME` / `XDG_CONFIG_HOME`, then destroys the test gateway and sandbox
- Useful overrides:
  - `OPENCLAW_E2E_OPENSHELL=1` to enable the test when running the broader e2e suite manually
  - `OPENCLAW_E2E_OPENSHELL_COMMAND=/path/to/openshell` to point at a non-default CLI binary or wrapper script

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`, `test/**/*.live.test.ts`, and bundled-plugin live tests under `extensions/`
- Default: **enabled** by `pnpm test:live` (sets `OPENCLAW_LIVE_TEST=1`)
- Scope:
  - “Does this provider/model actually work _today_ with real creds?”
  - Catch provider format changes, tool-calling quirks, auth issues, and rate limit behavior
- Expectations:
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)
  - Costs money / uses rate limits
  - Prefer running narrowed subsets instead of “everything”
- Live runs source `~/.profile` to pick up missing API keys.
- By default, live runs still isolate `HOME` and copy config/auth material into a temp test home so unit fixtures cannot mutate your real `~/.openclaw`.
- Set `OPENCLAW_LIVE_USE_REAL_HOME=1` only when you intentionally need live tests to use your real home directory.
- `pnpm test:live` now defaults to a quieter mode: it keeps `[live] ...` progress output, but suppresses the extra `~/.profile` notice and mutes gateway bootstrap logs/Bonjour chatter. Set `OPENCLAW_LIVE_TEST_QUIET=0` if you want the full startup logs back.
- API key rotation (provider-specific): set `*_API_KEYS` with comma/semicolon format or `*_API_KEY_1`, `*_API_KEY_2` (for example `OPENAI_API_KEYS`, `ANTHROPIC_API_KEYS`, `GEMINI_API_KEYS`) or per-live override via `OPENCLAW_LIVE_*_KEY`; tests retry on rate limit responses.
- Progress/heartbeat output:
  - Live suites now emit progress lines to stderr so long provider calls are visibly active even when Vitest console capture is quiet.
  - `vitest.live.config.ts` disables Vitest console interception so provider/gateway progress lines stream immediately during live runs.
  - Tune direct-model heartbeats with `OPENCLAW_LIVE_HEARTBEAT_MS`.
  - Tune gateway/probe heartbeats with `OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS`.

## Which suite should I run?

Use this decision table:

- Editing logic/tests: run `pnpm test` (and `pnpm test:coverage` if you changed a lot)
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`
- Debugging “my bot is down” / provider-specific failures / tool calling: run a narrowed `pnpm test:live`

## Live (network-touching) tests

For the live model matrix, CLI backend smokes, ACP smokes, Codex app-server
harness, and all media-provider live tests (Deepgram, BytePlus, ComfyUI, image,
music, video, media harness) — plus credential handling for live runs — see
[Testing live suites](/help/testing-live). For the dedicated update and
plugin validation checklist, see
[Testing updates and plugins](/help/testing-updates-plugins).

## Docker runners (optional "works in Linux" checks)

These Docker runners split into two buckets:

- Live-model runners: `test:docker:live-models` and `test:docker:live-gateway` run only their matching profile-key live file inside the repo Docker image (`src/agents/models.profiles.live.test.ts` and `src/gateway/gateway-models.profiles.live.test.ts`), mounting your local config dir and workspace (and sourcing `~/.profile` if mounted). The matching local entrypoints are `test:live:models-profiles` and `test:live:gateway-profiles`.
- Docker live runners default to a smaller smoke cap so a full Docker sweep stays practical:
  `test:docker:live-models` defaults to `OPENCLAW_LIVE_MAX_MODELS=12`, and
  `test:docker:live-gateway` defaults to `OPENCLAW_LIVE_GATEWAY_SMOKE=1`,
  `OPENCLAW_LIVE_GATEWAY_MAX_MODELS=8`,
  `OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=45000`, and
  `OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=90000`. Override those env vars when you
  explicitly want the larger exhaustive scan.
- `test:docker:all` builds the live Docker image once via `test:docker:live-build`, packs OpenClaw once as an npm tarball through `scripts/package-openclaw-for-docker.mjs`, then builds/reuses two `scripts/e2e/Dockerfile` images. The bare image is only the Node/Git runner for install/update/plugin-dependency lanes; those lanes mount the prebuilt tarball. The functional image installs the same tarball into `/app` for built-app functionality lanes. Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mjs`; planner logic lives in `scripts/lib/docker-e2e-plan.mjs`; `scripts/test-docker-all.mjs` executes the selected plan. The aggregate uses a weighted local scheduler: `OPENCLAW_DOCKER_ALL_PARALLELISM` controls process slots, while resource caps keep heavy live, npm-install, and multi-service lanes from all starting at once. If a single lane is heavier than the active caps, the scheduler can still start it when the pool is empty and then keeps it running alone until capacity is available again. Defaults are 10 slots, `OPENCLAW_DOCKER_ALL_LIVE_LIMIT=9`, `OPENCLAW_DOCKER_ALL_NPM_LIMIT=10`, and `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT=7`; tune `OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT` or `OPENCLAW_DOCKER_ALL_DOCKER_LIMIT` only when the Docker host has more headroom. The runner performs a Docker preflight by default, removes stale OpenClaw E2E containers, prints status every 30 seconds, stores successful lane timings in `.artifacts/docker-tests/lane-timings.json`, and uses those timings to start longer lanes first on later runs. Use `OPENCLAW_DOCKER_ALL_DRY_RUN=1` to print the weighted lane manifest without building or running Docker, or `node scripts/test-docker-all.mjs --plan-json` to print the CI plan for selected lanes, package/image needs, and credentials.
- `Package Acceptance` is the GitHub-native package gate for "does this installable tarball work as a product?" It resolves one candidate package from `source=npm`, `source=ref`, `source=url`, or `source=artifact`, uploads it as `package-under-test`, then runs the reusable Docker E2E lanes against that exact tarball instead of repacking the selected ref. Profiles are ordered by breadth: `smoke`, `package`, `product`, and `full`. See [Testing updates and plugins](/help/testing-updates-plugins) for the package/update/plugin contract, published-upgrade survivor matrix, release defaults, and failure triage.
- Build and release checks run `scripts/check-cli-bootstrap-imports.mjs` after tsdown. The guard walks the static built graph from `dist/entry.js` and `dist/cli/run-main.js` and fails if pre-dispatch startup imports package dependencies such as Commander, prompt UI, undici, or logging before command dispatch; it also keeps the bundled gateway run chunk under budget and rejects static imports of known cold gateway paths. Packaged CLI smoke also covers root help, onboard help, doctor help, status, config schema, and a model-list command.
- Package Acceptance legacy compatibility is capped at `2026.4.25` (`2026.4.25-beta.*` included). Through that cutoff, the harness tolerates only shipped-package metadata gaps: omitted private QA inventory entries, missing `gateway install --wrapper`, missing patch files in the tarball-derived git fixture, missing persisted `update.channel`, legacy plugin install-record locations, missing marketplace install-record persistence, and config metadata migration during `plugins update`. For packages after `2026.4.25`, those paths are strict failures.
- Container smoke runners: `test:docker:openwebui`, `test:docker:onboard`, `test:docker:npm-onboard-channel-agent`, `test:docker:update-channel-switch`, `test:docker:upgrade-survivor`, `test:docker:published-upgrade-survivor`, `test:docker:session-runtime-context`, `test:docker:agents-delete-shared-workspace`, `test:docker:gateway-network`, `test:docker:browser-cdp-snapshot`, `test:docker:mcp-channels`, `test:docker:pi-bundle-mcp-tools`, `test:docker:cron-mcp-cleanup`, `test:docker:plugins`, `test:docker:plugin-update`, and `test:docker:config-reload` boot one or more real containers and verify higher-level integration paths.

The live-model Docker runners also bind-mount only the needed CLI auth homes (or all supported ones when the run is not narrowed), then copy them into the container home before the run so external-CLI OAuth can refresh tokens without mutating the host auth store:

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- ACP bind smoke: `pnpm test:docker:live-acp-bind` (script: `scripts/test-live-acp-bind-docker.sh`; covers Claude, Codex, and Gemini by default, with strict Droid/OpenCode coverage via `pnpm test:docker:live-acp-bind:droid` and `pnpm test:docker:live-acp-bind:opencode`)
- CLI backend smoke: `pnpm test:docker:live-cli-backend` (script: `scripts/test-live-cli-backend-docker.sh`)
- Codex app-server harness smoke: `pnpm test:docker:live-codex-harness` (script: `scripts/test-live-codex-harness-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Observability smoke: `pnpm qa:otel:smoke` is a private QA source-checkout lane. It is intentionally not part of package Docker release lanes because the npm tarball omits QA Lab.
- Open WebUI live smoke: `pnpm test:docker:openwebui` (script: `scripts/e2e/openwebui-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Npm tarball onboarding/channel/agent smoke: `pnpm test:docker:npm-onboard-channel-agent` installs the packed OpenClaw tarball globally in Docker, configures OpenAI via env-ref onboarding plus Telegram by default, runs doctor, and runs one mocked OpenAI agent turn. Reuse a prebuilt tarball with `OPENCLAW_CURRENT_PACKAGE_TGZ=/path/to/openclaw-*.tgz`, skip the host rebuild with `OPENCLAW_NPM_ONBOARD_HOST_BUILD=0`, or switch channel with `OPENCLAW_NPM_ONBOARD_CHANNEL=discord`.
- Update channel switch smoke: `pnpm test:docker:update-channel-switch` installs the packed OpenClaw tarball globally in Docker, switches from package `stable` to git `dev`, verifies the persisted channel and plugin post-update work, then switches back to package `stable` and checks update status.
- Upgrade survivor smoke: `pnpm test:docker:upgrade-survivor` installs the packed OpenClaw tarball over a dirty old-user fixture with agents, channel config, plugin allowlists, stale plugin dependency state, and existing workspace/session files. It runs package update plus non-interactive doctor without live provider or channel keys, then starts a loopback Gateway and checks config/state preservation plus startup/status budgets.
- Published upgrade survivor smoke: `pnpm test:docker:published-upgrade-survivor` installs `openclaw@latest` by default, seeds realistic existing-user files, configures that baseline with a baked command recipe, validates the resulting config, updates that published install to the candidate tarball, runs non-interactive doctor, writes `.artifacts/upgrade-survivor/summary.json`, then starts a loopback Gateway and checks configured intents, state preservation, startup, `/healthz`, `/readyz`, and RPC status budgets. Override one baseline with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, ask the aggregate scheduler to expand exact baselines with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, and expand issue-shaped fixtures with `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` such as `reported-issues`; Package Acceptance exposes those as `published_upgrade_survivor_baseline`, `published_upgrade_survivor_baselines`, and `published_upgrade_survivor_scenarios`.
- Session runtime context smoke: `pnpm test:docker:session-runtime-context` verifies hidden runtime context transcript persistence plus doctor repair of affected duplicated prompt-rewrite branches.
- Bun global install smoke: `bash scripts/e2e/bun-global-install-smoke.sh` packs the current tree, installs it with `bun install -g` in an isolated home, and verifies `openclaw infer image providers --json` returns bundled image providers instead of hanging. Reuse a prebuilt tarball with `OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ=/path/to/openclaw-*.tgz`, skip the host build with `OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD=0`, or copy `dist/` from a built Docker image with `OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE=openclaw-dockerfile-smoke:local`.
- Installer Docker smoke: `bash scripts/test-install-sh-docker.sh` shares one npm cache across its root, update, and direct-npm containers. Update smoke defaults to npm `latest` as the stable baseline before upgrading to the candidate tarball. Override with `OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE=2026.4.22` locally, or with the Install Smoke workflow's `update_baseline_version` input on GitHub. Non-root installer checks keep an isolated npm cache so root-owned cache entries do not mask user-local install behavior. Set `OPENCLAW_INSTALL_SMOKE_NPM_CACHE_DIR=/path/to/cache` to reuse the root/update/direct-npm cache across local reruns.
- Install Smoke CI skips the duplicate direct-npm global update with `OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL=1`; run the script locally without that env when direct `npm install -g` coverage is needed.
- Agents delete shared workspace CLI smoke: `pnpm test:docker:agents-delete-shared-workspace` (script: `scripts/e2e/agents-delete-shared-workspace-docker.sh`) builds the root Dockerfile image by default, seeds two agents with one workspace in an isolated container home, runs `agents delete --json`, and verifies valid JSON plus retained workspace behavior. Reuse the install-smoke image with `OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_E2E_IMAGE=openclaw-dockerfile-smoke:local OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_E2E_SKIP_BUILD=1`.
- Gateway networking (two containers, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Browser CDP snapshot smoke: `pnpm test:docker:browser-cdp-snapshot` (script: `scripts/e2e/browser-cdp-snapshot-docker.sh`) builds the source E2E image plus a Chromium layer, starts Chromium with raw CDP, runs `browser doctor --deep`, and verifies CDP role snapshots cover link URLs, cursor-promoted clickables, iframe refs, and frame metadata.
- OpenAI Responses web_search minimal reasoning regression: `pnpm test:docker:openai-web-search-minimal` (script: `scripts/e2e/openai-web-search-minimal-docker.sh`) runs a mocked OpenAI server through Gateway, verifies `web_search` raises `reasoning.effort` from `minimal` to `low`, then forces the provider schema reject and checks the raw detail appears in Gateway logs.
- MCP channel bridge (seeded Gateway + stdio bridge + raw Claude notification-frame smoke): `pnpm test:docker:mcp-channels` (script: `scripts/e2e/mcp-channels-docker.sh`)
- Pi bundle MCP tools (real stdio MCP server + embedded Pi profile allow/deny smoke): `pnpm test:docker:pi-bundle-mcp-tools` (script: `scripts/e2e/pi-bundle-mcp-tools-docker.sh`)
- Cron/subagent MCP cleanup (real Gateway + stdio MCP child teardown after isolated cron and one-shot subagent runs): `pnpm test:docker:cron-mcp-cleanup` (script: `scripts/e2e/cron-mcp-cleanup-docker.sh`)
- Plugins (install/update smoke for local path, `file:`, npm registry with hoisted dependencies, git moving refs, ClawHub kitchen-sink, marketplace updates, and Claude-bundle enable/inspect): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)
  Set `OPENCLAW_PLUGINS_E2E_CLAWHUB=0` to skip the ClawHub block, or override the default kitchen-sink package/runtime pair with `OPENCLAW_PLUGINS_E2E_CLAWHUB_SPEC` and `OPENCLAW_PLUGINS_E2E_CLAWHUB_ID`. Without `OPENCLAW_CLAWHUB_URL`/`CLAWHUB_URL`, the test uses a hermetic local ClawHub fixture server.
- Plugin update unchanged smoke: `pnpm test:docker:plugin-update` (script: `scripts/e2e/plugin-update-unchanged-docker.sh`)
- Config reload metadata smoke: `pnpm test:docker:config-reload` (script: `scripts/e2e/config-reload-source-docker.sh`)
- Plugins: `pnpm test:docker:plugins` covers install/update smoke for local path, `file:`, npm registry with hoisted dependencies, git moving refs, ClawHub fixtures, marketplace updates, and Claude-bundle enable/inspect. `pnpm test:docker:plugin-update` covers unchanged update behavior for installed plugins.

To prebuild and reuse the shared functional image manually:

```bash
OPENCLAW_DOCKER_E2E_IMAGE=openclaw-docker-e2e-functional:local pnpm test:docker:e2e-build
OPENCLAW_DOCKER_E2E_IMAGE=openclaw-docker-e2e-functional:local OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels
```

Suite-specific image overrides such as `OPENCLAW_GATEWAY_NETWORK_E2E_IMAGE` still win when set. When `OPENCLAW_SKIP_DOCKER_BUILD=1` points at a remote shared image, the scripts pull it if it is not already local. The QR and installer Docker tests keep their own Dockerfiles because they validate package/install behavior rather than the shared built-app runtime.

The live-model Docker runners also bind-mount the current checkout read-only and
stage it into a temporary workdir inside the container. This keeps the runtime
image slim while still running Vitest against your exact local source/config.
The staging step skips large local-only caches and app build outputs such as
`.pnpm-store`, `.worktrees`, `__openclaw_vitest__`, and app-local `.build` or
Gradle output directories so Docker live runs do not spend minutes copying
machine-specific artifacts.
They also set `OPENCLAW_SKIP_CHANNELS=1` so gateway live probes do not start
real Telegram/Discord/etc. channel workers inside the container.
`test:docker:live-models` still runs `pnpm test:live`, so pass through
`OPENCLAW_LIVE_GATEWAY_*` as well when you need to narrow or exclude gateway
live coverage from that Docker lane.
`test:docker:openwebui` is a higher-level compatibility smoke: it starts an
OpenClaw gateway container with the OpenAI-compatible HTTP endpoints enabled,
starts a pinned Open WebUI container against that gateway, signs in through
Open WebUI, verifies `/api/models` exposes `openclaw/default`, then sends a
real chat request through Open WebUI's `/api/chat/completions` proxy.
The first run can be noticeably slower because Docker may need to pull the
Open WebUI image and Open WebUI may need to finish its own cold-start setup.
This lane expects a usable live model key, and `OPENCLAW_PROFILE_FILE`
(`~/.profile` by default) is the primary way to provide it in Dockerized runs.
Successful runs print a small JSON payload like `{ "ok": true, "model":
"openclaw/default", ... }`.
`test:docker:mcp-channels` is intentionally deterministic and does not need a
real Telegram, Discord, or iMessage account. It boots a seeded Gateway
container, starts a second container that spawns `openclaw mcp serve`, then
verifies routed conversation discovery, transcript reads, attachment metadata,
live event queue behavior, outbound send routing, and Claude-style channel +
permission notifications over the real stdio MCP bridge. The notification check
inspects the raw stdio MCP frames directly so the smoke validates what the
bridge actually emits, not just what a specific client SDK happens to surface.
`test:docker:pi-bundle-mcp-tools` is deterministic and does not need a live
model key. It builds the repo Docker image, starts a real stdio MCP probe server
inside the container, materializes that server through the embedded Pi bundle
MCP runtime, executes the tool, then verifies `coding` and `messaging` keep
`bundle-mcp` tools while `minimal` and `tools.deny: ["bundle-mcp"]` filter them.
`test:docker:cron-mcp-cleanup` is deterministic and does not need a live model
key. It starts a seeded Gateway with a real stdio MCP probe server, runs an
isolated cron turn and a `/subagents spawn` one-shot child turn, then verifies
the MCP child process exits after each run.

Manual ACP plain-language thread smoke (not CI):

- `bun scripts/dev/discord-acp-plain-language-smoke.ts --channel <discord-channel-id> ...`
- Keep this script for regression/debug workflows. It may be needed again for ACP thread routing validation, so do not delete it.

Useful env vars:

- `OPENCLAW_CONFIG_DIR=...` (default: `~/.openclaw`) mounted to `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (default: `~/.openclaw/workspace`) mounted to `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests
- `OPENCLAW_DOCKER_PROFILE_ENV_ONLY=1` to verify only env vars sourced from `OPENCLAW_PROFILE_FILE`, using temporary config/workspace dirs and no external CLI auth mounts
- `OPENCLAW_DOCKER_CLI_TOOLS_DIR=...` (default: `~/.cache/openclaw/docker-cli-tools`) mounted to `/home/node/.npm-global` for cached CLI installs inside Docker
- External CLI auth dirs/files under `$HOME` are mounted read-only under `/host-auth...`, then copied into `/home/node/...` before tests start
  - Default dirs: `.minimax`
  - Default files: `~/.codex/auth.json`, `~/.codex/config.toml`, `.claude.json`, `~/.claude/.credentials.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`
  - Narrowed provider runs mount only the needed dirs/files inferred from `OPENCLAW_LIVE_PROVIDERS` / `OPENCLAW_LIVE_GATEWAY_PROVIDERS`
  - Override manually with `OPENCLAW_DOCKER_AUTH_DIRS=all`, `OPENCLAW_DOCKER_AUTH_DIRS=none`, or a comma list like `OPENCLAW_DOCKER_AUTH_DIRS=.claude,.codex`
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` to narrow the run
- `OPENCLAW_LIVE_GATEWAY_PROVIDERS=...` / `OPENCLAW_LIVE_PROVIDERS=...` to filter providers in-container
- `OPENCLAW_SKIP_DOCKER_BUILD=1` to reuse an existing `openclaw:local-live` image for reruns that do not need a rebuild
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)
- `OPENCLAW_OPENWEBUI_MODEL=...` to choose the model exposed by the gateway for the Open WebUI smoke
- `OPENCLAW_OPENWEBUI_PROMPT=...` to override the nonce-check prompt used by the Open WebUI smoke
- `OPENWEBUI_IMAGE=...` to override the pinned Open WebUI image tag

## Docs sanity

Run docs checks after doc edits: `pnpm check:docs`.
Run full Mintlify anchor validation when you need in-page heading checks too: `pnpm docs:check-links:anchors`.

## Offline regression (CI-safe)

These are “real pipeline” regressions without real providers:

- Gateway tool calling (mock OpenAI, real gateway + agent loop): `src/gateway/gateway.test.ts` (case: "runs a mock OpenAI tool call end-to-end via gateway agent loop")
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.test.ts` (case: "runs wizard over ws and writes auth token config")

## Agent reliability evals (skills)

We already have a few CI-safe tests that behave like “agent reliability evals”:

- Mock tool-calling through the real gateway + agent loop (`src/gateway/gateway.test.ts`).
- End-to-end wizard flows that validate session wiring and config effects (`src/gateway/gateway.test.ts`).

What’s still missing for skills (see [Skills](/tools/skills)):

- **Decisioning:** when skills are listed in the prompt, does the agent pick the right skill (or avoid irrelevant ones)?
- **Compliance:** does the agent read `SKILL.md` before use and follow required steps/args?
- **Workflow contracts:** multi-turn scenarios that assert tool order, session history carryover, and sandbox boundaries.

Future evals should stay deterministic first:

- A scenario runner using mock providers to assert tool calls + order, skill file reads, and session wiring.
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.

## Contract tests (plugin and channel shape)

Contract tests verify that every registered plugin and channel conforms to its
interface contract. They iterate over all discovered plugins and run a suite of
shape and behavior assertions. The default `pnpm test` unit lane intentionally
skips these shared seam and smoke files; run the contract commands explicitly
when you touch shared channel or provider surfaces.

### Commands

- All contracts: `pnpm test:contracts`
- Channel contracts only: `pnpm test:contracts:channels`
- Provider contracts only: `pnpm test:contracts:plugins`

### Channel contracts

Located in `src/channels/plugins/contracts/*.contract.test.ts`:

- **plugin** - Basic plugin shape (id, name, capabilities)
- **setup** - Setup wizard contract
- **session-binding** - Session binding behavior
- **outbound-payload** - Message payload structure
- **inbound** - Inbound message handling
- **actions** - Channel action handlers
- **threading** - Thread ID handling
- **directory** - Directory/roster API
- **group-policy** - Group policy enforcement

### Provider status contracts

Located in `src/plugins/contracts/*.contract.test.ts`.

- **status** - Channel status probes
- **registry** - Plugin registry shape

### Provider contracts

Located in `src/plugins/contracts/*.contract.test.ts`:

- **auth** - Auth flow contract
- **auth-choice** - Auth choice/selection
- **catalog** - Model catalog API
- **discovery** - Plugin discovery
- **loader** - Plugin loading
- **runtime** - Provider runtime
- **shape** - Plugin shape/interface
- **wizard** - Setup wizard

### When to run

- After changing plugin-sdk exports or subpaths
- After adding or modifying a channel or provider plugin
- After refactoring plugin registration or discovery

Contract tests run in CI and do not require real API keys.

## Adding regressions (guidance)

When you fix a provider/model issue discovered in live:

- Add a CI-safe regression if possible (mock/stub provider, or capture the exact request-shape transformation)
- If it’s inherently live-only (rate limits, auth policies), keep the live test narrow and opt-in via env vars
- Prefer targeting the smallest layer that catches the bug:
  - provider request conversion/replay bug → direct models test
  - gateway session/history/tool pipeline bug → gateway live smoke or CI-safe gateway mock test
- SecretRef traversal guardrail:
  - `src/secrets/exec-secret-ref-id-parity.test.ts` derives one sampled target per SecretRef class from registry metadata (`listSecretTargetRegistryEntries()`), then asserts traversal-segment exec ids are rejected.
  - If you add a new `includeInPlan` SecretRef target family in `src/secrets/target-registry-data.ts`, update `classifyTargetClass` in that test. The test intentionally fails on unclassified target ids so new classes cannot be skipped silently.

## Related

- [Testing live](/help/testing-live)
- [Testing updates and plugins](/help/testing-updates-plugins)
- [CI](/ci)
