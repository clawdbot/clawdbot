---
summary: "The qa-lab command surface, shared Convex credentials, and adding a channel to QA"
title: "QA-specific runners"
read_when:
  - You are running a QA Lab or live transport lane
  - You need the shared QA credential contract
---

## QA-specific runners

These commands sit beside the main test suites when you need QA-lab realism.

CI runs QA Lab in dedicated workflows. Agentic parity is nested under
`QA-Lab - All Lanes` and release validation, not a standalone PR workflow.
Broad validation should use `Full Release Validation` with
`rerun_group=qa-parity` for parity or `rerun_group=qa-live` for live QA.
The direct `OpenClaw Release Checks` child alone may use `rerun_group=qa` as a
manual aggregate of both groups. Stable/full, soak-enabled, and explicit
`qa-live` release checks include the QA-live Matrix and Telegram lanes. Bounded
beta-publish `all` without soak runs parity but defers those live lanes to
postpublish-confidence. `QA-Lab - All Lanes` runs
nightly on `main` and from manual dispatch with the mock parity lane, live
Matrix lane, Convex-managed live Telegram lane, and Convex-managed live Discord
lane as parallel jobs. Scheduled QA and selected release checks run the
catalog-derived Matrix selection through the shared live adapter. Release
transport checks use `mock-openai/gpt-5.6-luna` so they stay deterministic and
avoid normal provider-plugin startup. These live transport gateways disable
memory search; memory behavior stays covered by the QA parity suites.

Full release live media shards use
`ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, which already has
`ffmpeg` and `ffprobe`. Docker live model/backend shards use the shared
`ghcr.io/openclaw/openclaw-live-test:<sha>` image built once per selected
commit, then pull it with `OPENCLAW_SKIP_DOCKER_BUILD=1` instead of rebuilding
inside every shard.

- `pnpm openclaw qa suite`
  - Runs repo-backed QA scenarios directly on the host.
  - Writes top-level `qa-evidence.json`, `qa-suite-summary.json`, and
    `qa-suite-report.md` artifacts for the selected scenario set, including
    mixed flow, Vitest, and Playwright scenario selections.
  - When dispatched by `pnpm openclaw qa run --qa-profile <profile>`, embeds
    the selected taxonomy profile scorecard in the same `qa-evidence.json`.
    `smoke-ci` writes slim evidence (`evidenceMode: "slim"`, no per-entry
    `execution`). `release` covers the curated release-readiness slice; `all`
    selects every active maturity category and targets explicit QA Profile
    Evidence workflow dispatches when a full scorecard artifact is needed.
  - Runs multiple selected scenarios in parallel by default with isolated
    gateway workers. `qa-channel` defaults to concurrency 4 (bounded by the
    selected scenario count). Use `--concurrency <count>` to tune the worker
    count, or `--concurrency 1` for the older serial lane.
  - Exits non-zero when any scenario fails. Use `--allow-failures` for
    artifacts without a failing exit code.
  - Supports provider modes `live-frontier`, `mock-openai`, and `aimock`.
    `aimock` starts a local AIMock-backed provider server for experimental
    fixture and protocol-mock coverage without replacing the scenario-aware
    `mock-openai` lane.
- `pnpm openclaw qa coverage --match <query>`
  - Searches scenario IDs, titles, surfaces, coverage IDs, docs refs, code
    refs, plugins, and provider requirements, then prints matching suite
    targets.
  - Use this before a QA Lab run when you know the touched behavior or file
    path but not the smallest scenario. Advisory only - still choose mock,
    live, Multipass, Matrix, or transport proof from the behavior being
    changed.
- `pnpm test:plugins:kitchen-sink-live`
  - Runs the live OpenAI Kitchen Sink plugin gauntlet through QA Lab.
    Installs the external Kitchen Sink package, verifies the plugin SDK
    surface inventory, probes `/healthz` and `/readyz`, records gateway
    CPU/RSS evidence, runs a live OpenAI turn, and checks adversarial
    diagnostics. Requires live OpenAI auth such as `OPENAI_API_KEY`. In
    hydrated Testbox sessions it automatically sources the Testbox live-auth
    profile when the `openclaw-testbox-env` helper is present.
- `pnpm test:gateway:cpu-scenarios`
  - Runs the gateway startup bench plus a small mock QA Lab scenario pack
    (`channel-chat-baseline`, `memory-failure-fallback`,
    `gateway-restart-inflight-run`) and writes a combined CPU observation
    summary under `.artifacts/gateway-cpu-scenarios/`.
  - Flags only sustained hot CPU observations by default (`--cpu-core-warn`,
    default `0.9`; `--hot-wall-warn-ms`, default `30000`), so short startup
    bursts are recorded as metrics without looking like the minutes-long
    gateway peg regression.
  - Runs against built `dist` artifacts; run a build first when the checkout
    does not already have fresh runtime output.
- `pnpm openclaw qa suite --runner multipass`
  - Runs the same QA suite inside a disposable Multipass Linux VM, keeping
    the same scenario-selection and provider/model flags as `qa suite`.
  - Live runs forward the QA auth inputs practical for the guest:
    env-based provider keys, the QA live provider config path, and
    `CODEX_HOME` when present.
  - Output dirs must stay under the repo root so the guest can write back
    through the mounted workspace.
  - Writes the normal QA report + summary plus Multipass logs under
    `.artifacts/qa-e2e/...`.
- `pnpm qa:lab:up`
  - Starts the Docker-backed QA site for operator-style QA work.
- `pnpm test:docker:npm-onboard-channel-agent`
  - Builds an npm tarball from the current checkout, installs it globally in
    Docker, runs non-interactive OpenAI API-key onboarding, configures
    Telegram by default, verifies the packaged plugin runtime loads without
    startup dependency repair, runs doctor, and runs one local agent turn
    against a mocked OpenAI endpoint.
  - Use `OPENCLAW_NPM_ONBOARD_CHANNEL=discord` to run the same packaged-install
    lane with Discord.
- `pnpm test:docker:session-runtime-context`
  - Runs a deterministic built-app Docker smoke for embedded runtime context
    transcripts. Verifies hidden OpenClaw runtime context persists as a
    non-display custom message instead of leaking into the visible user
    turn, then seeds an affected broken session JSONL and verifies
    `openclaw doctor --fix` rewrites it to the active branch with a backup.
- `pnpm test:docker:npm-telegram-live`
  - Installs an OpenClaw package candidate in Docker, runs installed-package
    onboarding, configures Telegram through the installed CLI, then reuses
    the live Telegram QA lane with that installed package as the SUT
    Gateway.
  - The trusted checkout owns the QA harness source, taxonomy, scenarios,
    dependencies, and private SDK build. The installed package remains the
    absolute CLI, Gateway, and bundled-plugin runtime under test, and its CLI
    writes the package candidate's persisted auth state.
  - Defaults to `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC=openclaw@beta`; set
    `OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ=/path/to/openclaw-current.tgz` or
    `OPENCLAW_CURRENT_PACKAGE_TGZ` to test a resolved local tarball instead
    of installing from the registry.
  - Emits repeated RTT timing in `qa-evidence.json` by default with
    `OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES=20`. Override
    `OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES`,
    `OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS`, or
    `OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES` to tune the run.
    `OPENCLAW_NPM_TELEGRAM_RTT_CHECKS` accepts zero or exactly one canonical
    Telegram QA scenario id. When omitted, the normal lane samples
    `channel-canary`; focused non-RTT scenario runs stay probe-free. An explicit
    RTT scenario is included in scenario selection automatically, so callers do
    not need to repeat it in `OPENCLAW_NPM_TELEGRAM_SCENARIOS`. Multiple ids
    fail immediately, while unknown or inapplicable ids fail canonical scenario
    validation. The package runner promotes the selected RTT scenario once to
    the first position before the remaining taxonomy-backed fail-fast release
    scenarios.
  - Uses the same Convex-leased Test Server userbot credentials as
    `pnpm openclaw qa telegram`. Set `OPENCLAW_QA_CONVEX_SITE_URL` and the
    secret for the selected role. The Docker wrapper selects Convex by default.
  - The wrapper validates Convex credential env on the host before Docker
    build/install work. Set
    `OPENCLAW_NPM_TELEGRAM_SKIP_CREDENTIAL_PREFLIGHT=1` only when
    deliberately debugging pre-credential setup.
  - `OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=ci|maintainer` overrides the
    shared `OPENCLAW_QA_CREDENTIAL_ROLE` for this lane only. With no role, the
    wrapper uses `ci` in CI and `maintainer` outside CI.
  - GitHub Actions exposes this lane as the manual maintainer workflow
    `NPM Telegram Beta E2E`. It does not run on merge. The workflow uses the
    `qa-live-shared` environment and Convex CI credential leases. Set its
    optional `rtt_scenario` input to select the repeated RTT scenario, or leave
    it empty for the default behavior above. Enable
    `allow_older_binary_destructive_actions` only for intentional historical
    downgrade or recovery proof; it remains false by default.
- GitHub Actions also exposes `Package Acceptance` for side-run product proof
  against one candidate package. It accepts a Git ref, published npm spec,
  HTTPS tarball URL plus SHA-256, trusted-URL policy, or tarball artifact
  from another run (`source=ref|npm|url|trusted-url|artifact`), uploads the
  normalized `openclaw-current.tgz` as `package-under-test`, then runs the
  existing Docker E2E scheduler with `smoke`, `package`, `product`, `full`,
  or `custom` lane profiles. Set `telegram_mode=mock-openai` or
  `live-frontier` to run the Telegram QA workflow against the same
  `package-under-test` artifact.
  - Latest beta product proof:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f telegram_mode=mock-openai
```

- Exact tarball URL proof requires a digest and uses the public URL safety policy:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=url \
  -f package_url=https://registry.npmjs.org/openclaw/-/openclaw-VERSION.tgz \
  -f package_sha256=<sha256> \
  -f suite_profile=package
```

- Enterprise/private tarball mirrors use an explicit trusted-source policy:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=trusted-url \
  -f trusted_source_id=enterprise-artifactory \
  -f package_url=https://packages.example.internal:8443/artifactory/openclaw/openclaw-VERSION.tgz \
  -f package_sha256=<sha256> \
  -f suite_profile=package
```

`source=trusted-url` reads `.github/package-trusted-sources.json` from the trusted workflow ref and does not accept URL credentials or a workflow-input private-network bypass. If the named policy declares bearer auth, configure the fixed `OPENCLAW_TRUSTED_PACKAGE_TOKEN` secret.

- Artifact proof downloads a tarball artifact from another Actions run:

```bash
gh workflow run package-acceptance.yml --ref main \
  -f source=artifact \
  -f artifact_run_id=<run-id> \
  -f artifact_name=<artifact-name> \
  -f suite_profile=smoke
```

- `pnpm test:docker:plugins`
  - Packs and installs the current OpenClaw build in Docker, starts the
    Gateway with OpenAI configured, then enables bundled channel/plugins via
    config edits.
  - Verifies setup discovery leaves unconfigured downloadable plugins
    absent, the first configured doctor repair installs each missing
    downloadable plugin explicitly, and a second restart does not run
    hidden dependency repair.
  - Also installs a known older npm baseline, enables Telegram before
    running `openclaw update --tag <candidate>`, and verifies the
    candidate's post-update doctor cleans legacy plugin dependency debris
    without a harness-side postinstall repair.
- `pnpm test:parallels:npm-update`
  - Runs the native packaged-install update smoke across Parallels guests.
    Each selected platform first installs the requested baseline package,
    then runs the installed `openclaw update` command in the same guest and
    verifies the installed version, update status, gateway readiness, and
    one local agent turn.
  - Use `--platform macos`, `--platform windows`, or `--platform linux`
    while iterating on one guest. Use `--json` for the summary artifact
    path and per-lane status.
  - The OpenAI lane uses `openai/gpt-5.6-luna` for the live agent-turn proof by
    default. Pass `--model <provider/model>` or set
    `OPENCLAW_PARALLELS_OPENAI_MODEL` to validate another OpenAI model.
  - Wrap long local runs in a host timeout so Parallels transport stalls
    cannot consume the rest of the testing window:

    ```bash
    timeout --foreground 150m pnpm test:parallels:npm-update -- --json
    timeout --foreground 90m pnpm test:parallels:npm-update -- --platform windows --json
    ```

  - The script writes nested lane logs under
    `/tmp/openclaw-parallels-npm-update.*`. Inspect `windows-update.log`,
    `macos-update.log`, or `linux-update.log` before assuming the outer
    wrapper is hung.
  - Windows update can spend 10 to 15 minutes in post-update doctor and
    package update work on a cold guest; that is still healthy when the
    nested npm debug log is advancing.
  - Do not run this aggregate wrapper in parallel with individual Parallels
    macOS, Windows, or Linux smoke lanes. They share VM state and can
    collide on snapshot restore, package serving, or guest gateway state.
  - The post-update proof runs the normal bundled plugin surface because
    capability facades such as speech, image generation, and media
    understanding load through bundled runtime APIs even when the agent
    turn itself only checks a simple text response.

- `pnpm openclaw qa aimock`
  - Starts only the local AIMock provider server for direct protocol smoke
    testing.
- `pnpm openclaw qa buzz`
  - Runs the Buzz live QA lane against a real relay room using dedicated driver
    and SUT identities.
  - Local runs use `--credential-file <path>` with `relayUrl`, `roomId`,
    `driverPrivateKey`, and `sutPrivateKey`. Closed relays may also need
    `driverAuthTag` and `sutAuthTag`. Hosted relays require `wss://`; `ws://` is
    accepted only for loopback development relays.
  - Defaults to `mock-openai` and runs canary and mention-gating scenarios
    through the real Buzz plugin path.
  - Supports `--credential-source convex` with a pooled `kind: "buzz"` row.
    Both public keys must be relay/room members, and the SUT must have the
    **Bot** room role. Never use a human owner or admin private key.
- `pnpm openclaw qa matrix`
  - Runs the Matrix live QA lane against a disposable Docker-backed Tuwunel
    homeserver. Source-checkout only - packaged installs do not ship
    `qa-lab`.
  - Full CLI, profile/scenario catalog, env vars, and artifact layout:
    [Matrix smoke lanes](/concepts/qa-e2e-automation#matrix-live-lane).
- `pnpm openclaw qa telegram`
  - Runs the Telegram live QA lane on Telegram's Test Server with one
    Convex-leased SUT bot and one independent TDLib user session.
  - Uses `--credential-source convex` by default and rejects `env`. Provide
    `OPENCLAW_QA_CONVEX_SITE_URL` and the secret for the selected
    `--credential-role`.
  - Defaults cover canary, mention gating, command addressing, `/status`,
    bot-to-bot mentioned replies, and core native command replies.
    `mock-openai` defaults also cover deterministic reply-chain and
    Telegram final-message streaming regressions. Use `--list-scenarios`
    for optional probes such as `session_status`.
  - Exits non-zero when any scenario fails. Use `--allow-failures` for
    artifacts without a failing exit code.
  - The leased user drives and observes the shared Test Server group. No
    production Telegram account or bot-to-bot observer is used.
  - Writes a Telegram QA report, summary, and `qa-evidence.json` under
    `.artifacts/qa-e2e/...`. Replying scenarios include RTT from driver send
    request to observed SUT reply.

Live transport lanes share one standard contract so new transports do not
drift; the per-lane coverage matrix lives in
[QA overview - Live transport coverage](/concepts/qa-e2e-automation#buzz%2C-discord%2C-slack%2C-telegram%2C-and-whatsapp-qa-reference).
`qa-channel` is the broad synthetic suite and is not part of that matrix.

### Shared Telegram credentials via Convex (v1)

When `--credential-source convex` (or `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`)
is enabled for live transport QA, QA lab acquires an exclusive lease from a
Convex-backed pool, heartbeats that lease while the lane is running, and
releases the lease on shutdown. Telegram always uses this source. The section
name predates Buzz, Discord, Slack, and WhatsApp support; the lease contract is
shared across kinds.

Reference Convex project scaffold: `qa/convex-credential-broker/`

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

Default endpoint contract (`OPENCLAW_QA_CONVEX_SITE_URL` + `/qa-credentials/v1`).
Requests authenticate with an `Authorization: Bearer <role secret>` header;
bodies below omit that header:

- `POST /acquire`
  - Request: `{ kind, ownerId, actorRole, leaseTtlMs, heartbeatIntervalMs }`
  - Success: `{ status: "ok", credentialId, leaseToken, payload, leaseTtlMs?, heartbeatIntervalMs? }`
  - Exhausted/retryable: `{ status: "error", code: "POOL_EXHAUSTED" | "NO_CREDENTIAL_AVAILABLE", ... }`
- `POST /payload-chunk`
  - Request: `{ kind, ownerId, actorRole, credentialId, leaseToken, index }`
  - Success: `{ status: "ok", index, data }`
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

Broker-validated multi-channel payloads:

- Buzz: `{ relayUrl: string, roomId: string, driverPrivateKey: string, sutPrivateKey: string, driverAuthTag?: string, sutAuthTag?: string }`
- Discord: `{ guildId: string, channelId: string, driverBotToken: string, sutBotToken: string, sutApplicationId: string, voiceChannelId?: string }`
- WhatsApp: `{ driverPhoneE164: string, sutPhoneE164: string, driverAuthArchiveBase64: string, sutAuthArchiveBase64: string, groupJid?: string }`

Slack lanes can also lease from the pool, but Slack payload validation
currently lives in the Slack QA runner rather than the broker. Use
`{ channelId: string, driverBotToken: string, sutBotToken: string, sutAppToken: string }`
for Slack rows.

### Adding a channel to QA

The architecture and scenario-helper names for new channel adapters live in
[QA overview - Adding a channel](/concepts/qa-e2e-automation#adding-a-channel).
The minimum bar: implement the transport runner on the shared `qa-lab` host
seam, add an `adapterFactory` for shared scenarios, declare `qaRunners` in the
plugin manifest, mount as `openclaw qa <runner>`, and author scenarios under
`qa/scenarios/`.
