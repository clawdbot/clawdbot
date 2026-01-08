---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
---
# Doctor

`clawdbot doctor` is the repair + migration tool for Clawdbot. It fixes stale
config/state, checks health, and provides actionable repair steps.

## Quick start

```bash
clawdbot doctor
```

### Headless / automation

```bash
clawdbot doctor --yes
```

Accept defaults without prompting (including restart/service/sandbox repair steps when applicable).

```bash
clawdbot doctor --non-interactive
```

Run without prompts and only apply safe migrations (config normalization + on-disk state moves). Skips restart/service/sandbox actions that require human confirmation.

```bash
clawdbot doctor --deep
```

Scan system services for extra gateway installs (launchd/systemd/schtasks).

If you want to review changes before writing, open the config file first:

```bash
cat ~/.clawdbot/clawdbot.json
```

## What it does (summary)
- Health check + restart prompt.
- Skills status summary (eligible/missing/blocked).
- Legacy config migration and normalization.
- Legacy on-disk state migration (sessions/agent dir/WhatsApp auth).
- State integrity and permissions checks (sessions, transcripts, state dir).
- Legacy workspace dir detection (`~/clawdis`, `~/clawdbot`).
- Sandbox image repair when sandboxing is enabled.
- Legacy service migration and extra gateway detection.
- Gateway runtime checks (service installed but not running; cached launchd label).
- Gateway port collision diagnostics (default `18789`).
- Security warnings for open DM policies.
- systemd linger check on Linux.
- Writes updated config + wizard metadata.

## Detailed behavior and rationale

### 1) Legacy config file migration
If `~/.clawdis/clawdis.json` exists and `~/.clawdbot/clawdbot.json` does not,
doctor migrates the file and normalizes old paths/image names. This prevents
new installs from silently booting with the wrong schema.

### 2) Legacy config key migrations
When the config contains deprecated keys, other commands refuse to run and ask
you to run `clawdbot doctor`.

Doctor will:
- Explain which legacy keys were found.
- Show the migration it applied.
- Rewrite `~/.clawdbot/clawdbot.json` with the updated schema.

The Gateway also auto-runs doctor migrations on startup when it detects a
legacy config format, so stale configs are repaired without manual intervention.

Current migrations:
- `routing.allowFrom` → `whatsapp.allowFrom`
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agent.models` + `agent.model.primary/fallbacks` + `agent.imageModel.primary/fallbacks`

### 3) Legacy state migrations (disk layout)
Doctor can migrate older on-disk layouts into the current structure:
- Sessions store + transcripts:
  - from `~/.clawdbot/sessions/` to `~/.clawdbot/agents/<agentId>/sessions/`
- Agent dir:
  - from `~/.clawdbot/agent/` to `~/.clawdbot/agents/<agentId>/agent/`
- WhatsApp auth state (Baileys):
  - from legacy `~/.clawdbot/credentials/*.json` (except `oauth.json`)
  - to `~/.clawdbot/credentials/whatsapp/<accountId>/...` (default account id: `default`)

These migrations are best-effort and idempotent; doctor will emit warnings when
it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates
the legacy sessions + agent dir on startup so history/auth/models land in the
per-agent path without a manual doctor run. WhatsApp auth is intentionally only
migrated via `clawdbot doctor`.

### 4) State integrity checks (session persistence, routing, and safety)
The state directory is the operational brainstem. If it vanishes, you lose
sessions, credentials, logs, and config (unless you have backups elsewhere).

Doctor checks:
- **State dir missing**: warns about catastrophic state loss, prompts to recreate
  the directory, and reminds you that it cannot recover missing data.
- **State dir permissions**: verifies writability; offers to repair permissions
  (and emits a `chown` hint when owner/group mismatch is detected).
- **Session dirs missing**: `sessions/` and the session store directory are
  required to persist history and avoid `ENOENT` crashes.
- **Transcript mismatch**: warns when recent session entries have missing
  transcript files.
- **Main session “1-line JSONL”**: flags when the main transcript has only one
  line (history is not accumulating).
- **Multiple state dirs**: warns when multiple `~/.clawdbot` folders exist across
  home directories or when `CLAWDBOT_STATE_DIR` points elsewhere (history can
  split between installs).
- **Remote mode reminder**: if `gateway.mode=remote`, doctor reminds you to run
  it on the remote host (the state lives there).

### 5) Sandbox image repair
When sandboxing is enabled, doctor checks Docker images and offers to build or
switch to legacy names if the current image is missing.

### 6) Gateway service migrations and cleanup hints
Doctor detects legacy Clawdis gateway services (launchd/systemd/schtasks) and
offers to remove them and install the Clawdbot service using the current gateway
port. It can also scan for extra gateway-like services and print cleanup hints
to ensure only one gateway runs per machine.

### 7) Security warnings
Doctor emits warnings when a provider is open to DMs without an allowlist, or
when a policy is configured in a dangerous way.

### 8) systemd linger (Linux)
If running as a systemd user service, doctor ensures lingering is enabled so the
gateway stays alive after logout.

### 9) Skills status
Doctor prints a quick summary of eligible/missing/blocked skills for the current
workspace.

### 10) Gateway health check + restart
Doctor runs a health check and offers to restart the gateway when it looks
unhealthy.

### 11) Gateway runtime + port diagnostics
Doctor inspects the daemon runtime (PID, last exit status) and warns when the
service is installed but not actually running. It also checks for port collisions
on the gateway port (default `18789`) and reports likely causes (gateway already
running, SSH tunnel).

### 12) Config write + wizard metadata
Doctor persists any config changes and stamps wizard metadata to record the
doctor run.

### 13) Workspace tips (backup + memory system)
Doctor suggests a workspace memory system when missing and prints a backup tip
if the workspace is not already under git.

See [/concepts/agent-workspace](/concepts/agent-workspace) for a full guide to
workspace structure and git backup (recommended private GitHub or GitLab).
