---
summary: "Advanced setup and development workflows for OpenClaw"
read_when:
  - Setting up a new machine
  - You want "latest + greatest" without breaking your personal setup
title: "Setup"
---

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For onboarding details, see [Onboarding (CLI)](/start/wizard).
</Note>

## TL;DR

Pick a setup workflow based on how often you want updates and whether you want to run the Gateway yourself:

- **Tailoring lives outside the repo:** keep your config and workspace in `~/.openclaw/openclaw.json` and `~/.openclaw/workspace/` so repo updates don't touch them.
- **Stable workflow (recommended for most):** install the macOS app and let it run the bundled Gateway.
- **Bleeding edge workflow (dev):** run the Gateway yourself via `pnpm gateway:watch`, then let the macOS app attach in Local mode.

## Prereqs (from source)

- Node 24.16+ LTS or Node 26.1+ (recommended)
- `pnpm` required for source checkouts. OpenClaw loads bundled plugins from the
  `extensions/*` pnpm workspace packages in dev mode, so root `npm install` does
  not prepare the full source tree.
- Docker (optional; only for containerized setup/e2e - see [Docker](/install/docker))

Use the pnpm version pinned in `package.json`. The workspace applies a seven-day
publication cooldown to npm dependencies, with trusted `@openai/codex` and
`@openai/codex-*` packages exempt. The standalone pnpm toolchain is managed separately.

For npm tooling that reads the project's `.npmrc`, use npm **11.19 or newer** for
install and `npm pack` cooldowns and Codex exclusions. Node runtime support does
not imply support for its bundled npm as a source resolver. [Published/global installs](/install) do not
inherit the repository's `.npmrc`. Source installs continue to use pnpm.

pnpm owns root and plugin-local dependencies, including workspace links and
versions that differ between packages. Postinstall and build preparation preserve
those trees. If an older checkout pruned plugin-local dependencies, run
`pnpm install --frozen-lockfile` after updating to restore them before testing.

## Tailoring strategy (so updates do not hurt)

If you want "100% tailored to me" _and_ easy updates, keep your customization in:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; make it a private git repo)

Bootstrap the config/workspace folders once, without running the full onboarding wizard:

```bash
openclaw setup --baseline
```

No global install yet? Run it from this repo instead:

```bash
pnpm openclaw setup --baseline
```

(Bare `openclaw setup`, without `--baseline`, opens an interactive OpenClaw chat on a configured system and falls through to guided onboarding on a fresh one. See [Setup CLI](/cli/setup) for the full routing order.)

## Run the Gateway from this repo

After `pnpm build`, you can run the packaged CLI directly:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stable workflow (macOS app first)

1. Install + launch **OpenClaw.app** (menu bar).
2. Complete the onboarding/permissions checklist (TCC prompts).
3. Ensure Gateway is **Local** and running (the app manages it).
4. Link surfaces (example: WhatsApp):

```bash
openclaw channels login
```

5. Sanity check:

```bash
openclaw health
```

If onboarding is not available in your build:

- Run `openclaw setup`, then `openclaw channels login`, then start the Gateway manually (`openclaw gateway`).

## Bleeding edge workflow (Gateway in a terminal)

Goal: work on the TypeScript Gateway, get hot reload, keep the macOS app UI attached.

### 0) (Optional) Run the macOS app from source too

If you also want the macOS app on the bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1) Start the dev Gateway

```bash
pnpm install
# First run only (or after resetting local OpenClaw config/workspace)
pnpm openclaw setup
pnpm gateway:watch
```

What `gateway:watch` does:

- It starts or restarts the Gateway watch process in a named tmux session,
  `openclaw-gateway-watch-main`, and auto-attaches from interactive terminals.
- Non-interactive shells stay detached and print
  `tmux attach -t openclaw-gateway-watch-main`. Run
  `OPENCLAW_GATEWAY_WATCH_ATTACH=0 pnpm gateway:watch` to keep an interactive
  run detached, or `pnpm gateway:watch:raw` for foreground watch mode.
- It stops the active profile's installed Gateway service before it takes over
  that service's configured or default port. This prevents the service
  supervisor from replacing the source process. The service stays installed.
  Run `pnpm openclaw gateway start` when you finish watching.
- The tmux pane remains available after a startup failure, so another terminal
  or agent can attach to it or capture its logs.
- It reloads on relevant source, config, and bundled-plugin metadata changes.
- If the watched Gateway exits during startup, `gateway:watch` runs
  `openclaw doctor --fix --non-interactive` once and retries. Set
  `OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR=0` to disable that dev-only repair pass.

TypeScript rebuilds triggered by `pnpm openclaw ...` or `pnpm gateway:watch` preserve existing `dist/control-ui` assets. When the Gateway starts, it rebuilds missing, incomplete, or stale bundled UI assets before serving them. Headless commands do not rebuild the UI. Run `pnpm ui:build` after `ui/` changes, or use `pnpm ui:dev` while developing the Control UI.

### 2) Point the macOS app at your running Gateway

In **OpenClaw.app**:

- Connection Mode: **Local**
  The app will attach to the running gateway on the configured port.

### 3) Verify

- In-app Gateway status should read **"Using existing gateway …"**
- Or via CLI:

```bash
openclaw health
```

### Common footguns

- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:18789`; keep app + CLI on the same port.
- **Wrong developer CLI:** When `PATH` includes `node_modules/.bin`, `codex` can
  resolve to the workspace-pinned CLI instead of your standalone installation.
  For developer workers, use the intended executable's absolute path for both
  `--version` and `exec`, and confirm the worker's startup version. A package
  manifest or a version check in another shell does not identify a running worker.
  OpenClaw's [managed Codex app-server](/plugins/codex-harness-reference#app-server-transport)
  has a separate pinned-version contract; do not change that pin or your model/auth
  settings to fix developer CLI selection. If the installed workspace package and
  native executable disagree with the lockfile, repair the install with `pnpm install`
  rather than editing `node_modules`.
- **Where state lives:**
  - Channel/provider state: `~/.openclaw/credentials/`
  - Model auth profiles: SQLite auth stores (shared: `~/.openclaw/state/openclaw.sqlite`; agent-local: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`)
  - Sessions and transcripts: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
  - Legacy/archive session artifacts: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env or `channels.telegram.tokenFile` (regular file only; symlinks rejected)
- **Discord bot token**: config/env or SecretRef (env/file/exec/store providers)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json` (default account)
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json` (non-default accounts)
- **Model auth profiles**: shared and agent-local SQLite auth stores; see [Auth credential semantics](/auth-credential-semantics#agent-copy-portability) for inheritance and legacy shared-store relocation
- **File-backed secrets payload (optional)**: `~/.openclaw/secrets.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.openclaw/workspace` and `~/.openclaw/` as "your stuff"; don't put personal prompts/config into the `openclaw` repo.
- Updating source: `git pull` + `pnpm install` + keep using `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it's still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway lifecycle)
