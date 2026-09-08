---
summary: "The Docker works-in-Linux runners, their scheduler, lanes, and env vars"
title: "Docker test runners"
read_when:
  - You are running the Docker test lanes
  - You need a Docker lane name or env var
---

## Docker runners (optional "works in Linux" checks)

These Docker runners split into two buckets:

- Live-model runners: `test:docker:live-models` and `test:docker:live-gateway` run only their matching profile-key live file inside the repo Docker image (`src/agents/models.profiles.live.test.ts` and `src/gateway/gateway-models.profiles.live.test.ts`), mounting your local config dir, workspace, and optional profile env file. The matching local entrypoints are `test:live:models-profiles` and `test:live:gateway-profiles`.
- Docker live runners keep their own practical caps where needed:
  `test:docker:live-models` defaults to the curated supported high-signal set, and
  `test:docker:live-gateway` defaults to `OPENCLAW_LIVE_GATEWAY_SMOKE=1`,
  `OPENCLAW_LIVE_GATEWAY_MAX_MODELS=8`,
  `OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=45000`, and
  `OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=90000`. Set `OPENCLAW_LIVE_MAX_MODELS`
  or the gateway env vars when you explicitly want a smaller cap or larger scan.
- `test:docker:all` builds the live Docker image once via `test:docker:live-build`, packs OpenClaw once as an npm tarball through `scripts/package-openclaw-for-docker.mjs`, then builds/reuses two `scripts/e2e/Dockerfile` images. The bare image is only the Node/Git runner for install/update/plugin-dependency lanes; those lanes mount the prebuilt tarball. The functional image installs the same tarball into `/app` for built-app functionality lanes. Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mts`; planner logic lives in `scripts/lib/docker-e2e-plan.mts`; `scripts/test-docker-all.mjs` executes the selected plan. The aggregate uses a weighted local scheduler: `OPENCLAW_DOCKER_ALL_PARALLELISM` controls process slots, while resource caps keep heavy live, npm-install, and multi-service lanes from all starting at once. If a single lane is heavier than the active caps, the scheduler can still start it when the pool is empty and then keeps it running alone until capacity is available again. Defaults are 10 slots, `OPENCLAW_DOCKER_ALL_LIVE_LIMIT=9`, `OPENCLAW_DOCKER_ALL_NPM_LIMIT=5`, and `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT=7`; tune `OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT` or `OPENCLAW_DOCKER_ALL_DOCKER_LIMIT` (and other `OPENCLAW_DOCKER_ALL_<RESOURCE>_LIMIT` overrides) only when the Docker host has more headroom. The runner performs a Docker preflight by default, removes stale OpenClaw E2E containers, prints status every 30 seconds, stores successful lane timings in `.artifacts/docker-tests/lane-timings.json`, and uses those timings to start longer lanes first on later runs. Use `OPENCLAW_DOCKER_ALL_DRY_RUN=1` to print the weighted lane manifest without building or running Docker, or `node scripts/test-docker-all.mjs --plan-json` to print the CI plan for selected lanes, package/image needs, and credentials.
- `Package Acceptance` is the GitHub-native package gate for "does this installable tarball work as a product?" It resolves one candidate package from `source=npm`, `source=ref`, `source=url`, `source=trusted-url`, or `source=artifact`, uploads it as `package-under-test`, then runs the reusable Docker E2E lanes against that exact tarball instead of repacking the selected ref. Profiles are ordered by breadth: `smoke`, `package`, `product`, and `full` (plus `custom` for an explicit lane list). See [Testing updates and plugins](/help/testing-updates-plugins) for the package/update/plugin contract, published-upgrade survivor matrix, release defaults, and failure triage.
- Build and release checks run `scripts/check-cli-bootstrap-imports.mts` after tsdown. The guard walks the static built graph from `dist/entry.js` and `dist/cli/run-main.js` and fails if that pre-dispatch bootstrap graph statically imports any external package (Commander, prompt UI, undici, logging, and similar startup-heavy deps all count) before command dispatch; it also caps the bundled gateway run chunk at 70 KB and rejects static imports of known cold gateway paths (`control-ui-assets`, `diagnostic-stability-bundle`, `onboard-helpers`, `process-respawn`, `restart-sentinel`, `server-close`, `server-reload-handlers`) from that chunk. Current builds locate the gateway chunk through hash-checked metadata emitted by tsdown, so discovery does not scan unrelated JavaScript under `dist`. Missing or stale metadata requires rebuilding; trusted release tooling retains source scanning only for frozen targets that predate the locator. Standalone workers still receive independent JavaScript dependency checks. `scripts/release-check.ts` separately smoke-tests the packed CLI with `--help`, `onboard --help`, `doctor --help`, `status --json --timeout 1`, `config schema`, and `models list --provider openai`.
- Package Acceptance legacy compatibility is capped at `2026.4.25` (`2026.4.25-beta.*` included). Through that cutoff, the harness tolerates only shipped-package metadata gaps: omitted private QA inventory entries, missing `gateway install --wrapper`, missing patch files in the tarball-derived git fixture, missing persisted `update.channel`, legacy plugin install-record locations, missing marketplace install-record persistence, and config metadata migration during `plugins update`. For packages after `2026.4.25`, those paths are strict failures.
- Container smoke runners: `test:docker:openwebui`, `test:docker:onboard`, `test:docker:npm-onboard-channel-agent`, `test:docker:release-user-journey`, `test:docker:release-typed-onboarding`, `test:docker:release-media-memory`, `test:docker:release-upgrade-user-journey`, `test:docker:release-plugin-marketplace`, `test:docker:skill-install`, `test:docker:update-channel-switch`, `test:docker:upgrade-survivor`, `test:docker:published-upgrade-survivor`, `test:docker:session-runtime-context`, `test:docker:agents-delete-shared-workspace`, `test:docker:gateway-network`, `test:docker:browser-cdp-snapshot`, `test:docker:mcp-channels`, `test:docker:agent-bundle-mcp-tools`, `test:docker:cron-mcp-cleanup`, `test:docker:plugins`, `test:docker:plugin-update`, `test:docker:plugin-lifecycle-matrix`, and `test:docker:config-reload` boot one or more real containers and verify higher-level integration paths.
- Docker/Bash E2E lanes that install the packed OpenClaw tarball through `scripts/lib/openclaw-e2e-instance.sh` cap `npm install` at `OPENCLAW_E2E_NPM_INSTALL_TIMEOUT` (default `600s`; set `0` to disable the wrapper for debugging).

The live-model Docker runners also bind-mount only the needed CLI auth homes
(or all supported ones when the run is not narrowed), then copy them into the
container home before the run so external-CLI OAuth can refresh tokens
without mutating the host auth store:

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- ACP bind smoke: `pnpm test:docker:live-acp-bind` (script: `scripts/test-live-acp-bind-docker.sh`; covers Claude, Codex, and Gemini by default, with strict Droid/OpenCode coverage via `pnpm test:docker:live-acp-bind:droid` and `pnpm test:docker:live-acp-bind:opencode`)
- CLI backend smoke: `pnpm test:docker:live-cli-backend` (script: `scripts/test-live-cli-backend-docker.sh`)
- Codex app-server harness smoke: `pnpm test:docker:live-codex-harness` (script: `scripts/test-live-codex-harness-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Observability smokes: `pnpm qa:otel:smoke`, `pnpm qa:prometheus:smoke`, and `pnpm qa:observability:smoke` are private QA source-checkout lanes. They are intentionally not part of package Docker release lanes because the npm tarball omits QA Lab.
- Open WebUI live smoke: `pnpm test:docker:openwebui` (script: `scripts/e2e/openwebui-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Npm tarball onboarding/channel/agent smoke: `pnpm test:docker:npm-onboard-channel-agent` installs the packed OpenClaw tarball globally in Docker, configures OpenAI via env-ref onboarding plus Telegram by default, runs doctor, and runs one mocked OpenAI agent turn. Reuse a prebuilt tarball with `OPENCLAW_CURRENT_PACKAGE_TGZ=/path/to/openclaw-*.tgz`, skip the host rebuild with `OPENCLAW_NPM_ONBOARD_HOST_BUILD=0`, or switch channel with `OPENCLAW_NPM_ONBOARD_CHANNEL=discord` or `OPENCLAW_NPM_ONBOARD_CHANNEL=slack`.

- Release user journey smoke: `pnpm test:docker:release-user-journey` installs the packed OpenClaw tarball globally in a clean Docker home, runs onboarding, configures a mocked OpenAI provider, runs an agent turn, installs/uninstalls external plugins, configures ClickClack against a local fixture, verifies outbound/inbound messaging, restarts Gateway, and runs doctor.
- Release typed onboarding smoke: `pnpm test:docker:release-typed-onboarding` installs the packed tarball, drives `openclaw onboard` through a real TTY, configures OpenAI as an env-ref provider, verifies no raw key persistence, and runs a mocked agent turn.
- Release media/memory smoke: `pnpm test:docker:release-media-memory` installs the packed tarball, verifies image understanding from a PNG attachment, OpenAI-compatible image generation output, memory search recall, and recall survival across Gateway restart.
- Release upgrade user journey smoke: `pnpm test:docker:release-upgrade-user-journey` installs the newest published stable baseline older than the candidate tarball by default, onboards and installs a CLI plugin on the published package, then replaces the package and runs the documented Doctor migration step. It verifies the existing plugin still works and configures candidate-compatible mock provider/ClickClack settings for the agent/channel journey. If no older stable baseline exists, it reuses the candidate version only when that version is published and stable; otherwise it fails and requires an explicit baseline. Override the baseline with `OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC=openclaw@<version>`.
- Release plugin marketplace smoke: `pnpm test:docker:release-plugin-marketplace` installs from a local fixture marketplace, updates the installed plugin, uninstalls it, and verifies the plugin CLI disappears with install metadata pruned.
- Skill install smoke: `pnpm test:docker:skill-install` installs the packed OpenClaw tarball globally in Docker, disables uploaded archive installs in config, resolves the current live ClawHub skill slug from search, installs it with `openclaw skills install`, and verifies the installed skill plus `.clawhub` origin/lock metadata.
- Update channel switch smoke: `pnpm test:docker:update-channel-switch` installs the packed OpenClaw tarball globally in Docker, switches from package `stable` to git `dev`, verifies the persisted channel and plugin post-update work, then switches back to package `stable` and checks update status.
- Upgrade survivor smoke: `pnpm test:docker:upgrade-survivor` installs the packed OpenClaw tarball over a dirty old-user fixture with agents, channel config, plugin allowlists, stale plugin dependency state, and existing workspace/session files. It runs package update plus non-interactive doctor without live provider or channel keys, then starts a loopback Gateway and checks config/state preservation plus startup/status budgets.
- Published upgrade survivor smoke: `pnpm test:docker:published-upgrade-survivor` installs `openclaw@latest` by default, seeds realistic existing-user files, configures that baseline with a baked command recipe, validates the resulting config, updates that published install to the candidate tarball, runs non-interactive doctor, writes `.artifacts/upgrade-survivor/summary.json`, then starts a loopback Gateway and checks configured intents, state preservation, startup, `/healthz`, `/readyz`, and RPC status budgets. Override one baseline with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, ask the aggregate scheduler to expand exact local baselines with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS` such as `openclaw@2026.5.2 openclaw@2026.4.23 openclaw@2026.4.15`, and expand issue-shaped fixtures with `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` such as `reported-issues`; the reported-issues set includes `configured-plugin-installs` for automatic external OpenClaw plugin install repair. Package Acceptance exposes those as `published_upgrade_survivor_baseline`, `published_upgrade_survivor_baselines`, and `published_upgrade_survivor_scenarios`, resolves meta baseline tokens such as `last-stable-4` or `all-since-2026.4.23`, and Full Release Validation runs all `reported-issues` scenarios against the latest stable baseline, resolved once to an exact package before fanout. Historical matrices remain explicit manual overrides.
- Session runtime context smoke: `pnpm test:docker:session-runtime-context` verifies hidden runtime context transcript persistence plus doctor repair of affected duplicated prompt-rewrite branches.
- Bun global install and runtime smoke: `bash scripts/e2e/bun-global-install-smoke.sh` packs the current tree, installs it with `bun install -g --trust` in an isolated home, verifies OpenClaw's lifecycle scripts ran, and executes the installed package with Bun 1.4 or newer. It checks representative CLI state, bundled image providers, a mocked local agent turn, Gateway readiness and health, and a mocked agent turn through the Bun-hosted Gateway. Reuse a prebuilt tarball with `OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ=/path/to/openclaw-*.tgz`, skip the host build with `OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD=0`, or copy `dist/` from a built Docker image with `OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE=openclaw-dockerfile-smoke:local`.
- Installer Docker smoke: `bash scripts/test-install-sh-docker.sh` shares one npm cache across its root, update, and direct-npm containers. Update smoke defaults to npm `latest` as the stable baseline before upgrading to the candidate tarball. Override with `OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE=2026.4.22` locally, or with the Install Smoke workflow's `update_baseline_version` input on GitHub. Non-root installer checks keep an isolated npm cache so root-owned cache entries do not mask user-local install behavior. Set `OPENCLAW_INSTALL_SMOKE_NPM_CACHE_DIR=/path/to/cache` to reuse the root/update/direct-npm cache across local reruns.
- Install Smoke CI skips the duplicate direct-npm global update with `OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL=1`; run the script locally without that env when direct `npm install -g` coverage is needed.
- Agents delete shared workspace CLI smoke: `pnpm test:docker:agents-delete-shared-workspace` (script: `scripts/e2e/agents-delete-shared-workspace-docker.sh`) builds the root Dockerfile image by default, seeds two agents with one workspace in an isolated container home, runs `agents delete --json`, and verifies valid JSON plus retained workspace behavior. Reuse the install-smoke image with `OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_E2E_IMAGE=openclaw-dockerfile-smoke:local OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_E2E_SKIP_BUILD=1`.
- Gateway networking and host lifecycle: `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`) preserves the two-container LAN WebSocket auth/health smoke, then uses loopback Admin HTTP to prove prepare fencing, retained-control access, resume recovery, and a prepared same-container stop/start. The restart check must finish before the original lease expires, verifies that suspension state is process-local while persisted Gateway config and container identity survive, and emits machine-readable phase timing JSON.
- Browser CDP snapshot smoke: `pnpm test:docker:browser-cdp-snapshot` (script: `scripts/e2e/browser-cdp-snapshot-docker.sh`) builds the source E2E image plus a Chromium layer, starts Chromium with raw CDP, runs `browser doctor --deep`, and verifies CDP role snapshots cover link URLs, cursor-promoted clickables, iframe refs, and frame metadata.
- OpenAI Responses web_search minimal reasoning regression: `pnpm test:docker:openai-web-search-minimal` (script: `scripts/e2e/openai-web-search-minimal-docker.sh`) runs a mocked OpenAI server through Gateway, verifies `web_search` raises `reasoning.effort` from `minimal` to `low`, then forces the provider schema reject and checks the raw detail appears in Gateway logs.
- MCP channel bridge (seeded Gateway + stdio bridge + raw Claude notification-frame smoke): `pnpm test:docker:mcp-channels` (script: `scripts/e2e/mcp-channels-docker.sh`)
- OpenClaw bundle MCP tools (real stdio MCP server + embedded OpenClaw profile allow/deny smoke): `pnpm test:docker:agent-bundle-mcp-tools` (script: `scripts/e2e/agent-bundle-mcp-tools-docker.sh`)
- Cron/subagent MCP cleanup (real Gateway + stdio MCP child teardown after isolated cron and one-shot subagent runs): `pnpm test:docker:cron-mcp-cleanup` (script: `scripts/e2e/cron-mcp-cleanup-docker.sh`)
- Plugins (install/update smoke for local path, `file:`, npm registry with hoisted dependencies, malformed npm package metadata, git moving refs, ClawHub kitchen-sink, marketplace updates, and Claude-bundle enable/inspect): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)
  Set `OPENCLAW_PLUGINS_E2E_CLAWHUB=0` to skip the ClawHub block, or override the default kitchen-sink package/runtime pair with `OPENCLAW_PLUGINS_E2E_CLAWHUB_SPEC` and `OPENCLAW_PLUGINS_E2E_CLAWHUB_ID`. Without `OPENCLAW_CLAWHUB_URL`/`CLAWHUB_URL`, the test uses a hermetic local ClawHub fixture server.
- Plugin update unchanged smoke: `pnpm test:docker:plugin-update` (script: `scripts/e2e/plugin-update-unchanged-docker.sh`)
- Plugin lifecycle matrix smoke: `pnpm test:docker:plugin-lifecycle-matrix` installs the packed OpenClaw tarball in a bare container, installs an npm plugin, toggles enable/disable, upgrades and downgrades it through a local npm registry, deletes the installed code, then verifies uninstall still removes stale state while logging RSS/CPU metrics for each lifecycle phase.
- Config reload metadata smoke: `pnpm test:docker:config-reload` (script: `scripts/e2e/config-reload-source-docker.sh`)
- Plugins: `pnpm test:docker:plugins` covers install/update smoke for local path, `file:`, npm registry with hoisted dependencies, git moving refs, ClawHub fixtures, marketplace updates, and Claude-bundle enable/inspect. `pnpm test:docker:plugin-update` covers unchanged update behavior for installed plugins. `pnpm test:docker:plugin-lifecycle-matrix` covers resource-tracked npm plugin install, enable, disable, upgrade, downgrade, and missing-code uninstall.

To prebuild and reuse the shared functional image manually:

```bash
OPENCLAW_DOCKER_E2E_IMAGE=openclaw-docker-e2e-functional:local pnpm test:docker:e2e-build
OPENCLAW_DOCKER_E2E_IMAGE=openclaw-docker-e2e-functional:local OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels
```

Suite-specific image overrides such as `OPENCLAW_GATEWAY_NETWORK_E2E_IMAGE` still win when set. When `OPENCLAW_SKIP_DOCKER_BUILD=1` points at a remote shared image, the scripts pull it if it is not already local. The QR and installer Docker tests keep their own Dockerfiles because they validate package/install behavior rather than the shared built-app runtime.

The live-model Docker runners also bind-mount the current checkout read-only
and stage it into a temporary workdir inside the container. This keeps the
runtime image slim while still running Vitest against your exact local
source/config. The staging step skips large local-only caches and app build
outputs such as `.pnpm-store`, `.worktrees`, `__openclaw_vitest__`, and
app-local `.build` or Gradle output directories so Docker live runs do not
spend minutes copying machine-specific artifacts. They also set
`OPENCLAW_SKIP_CHANNELS=1` so gateway live probes do not start real
Telegram/Discord/etc. channel workers inside the container.
`test:docker:live-models` still runs `pnpm test:live`, so pass through
`OPENCLAW_LIVE_GATEWAY_*` as well when you need to narrow or exclude gateway
live coverage from that Docker lane.

`test:docker:openwebui` is a higher-level compatibility smoke: it starts an
OpenClaw gateway container with the OpenAI-compatible HTTP endpoints enabled,
starts a pinned Open WebUI container against that gateway, signs in through
Open WebUI, verifies `/api/models` exposes `openclaw/default`, then sends a
real chat request through Open WebUI's `/api/chat/completions` proxy. Set
`OPENWEBUI_SMOKE_MODE=models` for release-path CI checks that should stop
after Open WebUI sign-in and model discovery, without waiting on a live model
completion. The first run can be noticeably slower because Docker may need to
pull the Open WebUI image and Open WebUI may need to finish its own
cold-start setup. This lane expects a usable live model key, provided through
the process environment, staged auth profiles, or an explicit
`OPENCLAW_PROFILE_FILE`. Successful runs print a small JSON payload like
`{ "ok": true, "model": "openclaw/default", ... }`.

`test:docker:mcp-channels` is intentionally deterministic and does not need a
real Telegram, Discord, or iMessage account. It boots a seeded Gateway
container, starts a second container that spawns `openclaw mcp serve`, then
verifies routed conversation discovery, transcript reads, attachment
metadata, live event queue behavior, outbound send routing, and Claude-style
channel + permission notifications over the real stdio MCP bridge. The
notification check inspects the raw stdio MCP frames directly so the smoke
validates what the bridge actually emits, not just what a specific client SDK
happens to surface.

`test:docker:agent-bundle-mcp-tools` is deterministic and does not need a
live model key. It builds the repo Docker image, starts a real stdio MCP
probe server inside the container, materializes that server through the
embedded OpenClaw bundle MCP runtime, executes the tool, then verifies
`coding` and `messaging` keep `bundle-mcp` tools while `minimal` and
`tools.deny: ["bundle-mcp"]` filter them.

`test:docker:cron-mcp-cleanup` is deterministic and does not need a live
model key. It starts a seeded Gateway with a real stdio MCP probe server,
runs an isolated cron turn and a `sessions_spawn` one-shot child turn, then
verifies the MCP child process exits after each run.

Manual ACP plain-language thread smoke (not CI):

- `bun scripts/dev/discord-acp-plain-language-smoke.ts --channel <discord-channel-id> ...`
- Keep this script for regression/debug workflows. It may be needed again for ACP thread routing validation, so do not delete it.

Useful env vars:

- `OPENCLAW_CONFIG_DIR=...` (default: `~/.openclaw`) mounted to `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (default: `~/.openclaw/workspace`) mounted to `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` mounted and sourced before running tests
- `OPENCLAW_DOCKER_PROFILE_ENV_ONLY=1` to verify only env vars sourced from `OPENCLAW_PROFILE_FILE`, using temporary config/workspace dirs and no external CLI auth mounts
- `OPENCLAW_DOCKER_CLI_TOOLS_DIR=...` (default: `~/.cache/openclaw/docker-cli-tools`, unless the run already uses a CI/managed bind dir) mounted to `/home/node/.npm-global` for cached CLI installs inside Docker
- External CLI auth dirs/files under `$HOME` are mounted read-only under `/host-auth...`, then copied into `/home/node/...` before tests start
  - Default dirs (used when the run is not narrowed to specific providers): `.factory`, `.gemini`, `.minimax`
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
