---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
---
# Doctor

`clawdbot doctor` is the repair + migration tool for Clawdbot. It runs a quick health check, audits skills, and can migrate deprecated config entries to the new schema.

## What it does
- Runs a health check and offers to restart the gateway if it looks unhealthy.
- Prints a skills status summary (eligible/missing/blocked).
- Detects deprecated config keys and offers to migrate them.
- Migrates legacy `~/.clawdis/clawdis.json` when no Clawdbot config exists.
- Checks sandbox Docker images when sandboxing is enabled (offers to build or switch to legacy names).
- Detects legacy Clawdis services (launchd/systemd/schtasks) and offers to migrate them.
- On Linux, checks if systemd user lingering is enabled and can enable it (required to keep the Gateway alive after logout).

## Legacy config file migration
If `~/.clawdis/clawdis.json` exists and `~/.clawdbot/clawdbot.json` does not, doctor will migrate the file and normalize old paths/image names.

## Legacy config migrations
When the config contains deprecated keys, other commands will refuse to run and ask you to run `clawdbot doctor`.
Doctor will:
- Explain which legacy keys were found.
- Show the migration it applied.
- Rewrite `~/.clawdbot/clawdbot.json` with the updated schema.

The Gateway also auto-runs doctor migrations on startup when it detects a legacy
config format, so stale configs are repaired without manual intervention.

Current migrations:
- `routing.allowFrom` → `whatsapp.allowFrom`
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agent.models` + `agent.model.primary/fallbacks` + `agent.imageModel.primary/fallbacks`

## Usage

```bash
clawdbot doctor
```

If you want to review changes before writing, open the config file first:

```bash
cat ~/.clawdbot/clawdbot.json
```

## Legacy service migrations
Doctor checks for older Clawdis gateway services (launchd/systemd/schtasks).
If found, it offers to remove them and install the Clawdbot service using the current gateway port.
Remote mode skips the install step, and Nix mode only reports what it finds.
