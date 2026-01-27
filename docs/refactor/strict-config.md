---
summary: "Strict config validation + doctor-only migrations"
read_when:
  - Designing or implementing config validation behavior
  - Working on config migrations or doctor workflows
  - Handling plugin config schemas or plugin load gating
---
# Strict config validation (doctor-only migrations)

## Goals
- **Reject unknown config keys everywhere** (root + nested).
- **Reject plugin config without a schema**; don’t load that plugin.
- **Remove legacy auto-migration on load**; migrations run via doctor only.
- **Auto-run doctor (dry-run) on startup**; if invalid, block non-diagnostic commands.

## Non-goals
- Backward compatibility on load (legacy keys do not auto-migrate).
- Silent drops of unrecognized keys.

## Strict validation rules
- Config must match the schema exactly at every level.
- Unknown keys are validation errors (no passthrough at root or nested).
- `plugins.entries.<id>.config` must be validated by the plugin’s schema.
  - If a plugin lacks a schema, **reject plugin load** and surface a clear error.
- Unknown `channels.<id>` keys are errors unless a plugin manifest declares the channel id.
- Plugin manifests (`moltbot.plugin.json`) are required for all plugins.

## Plugin schema enforcement
- Each plugin provides a strict JSON Schema for its config (inline in the manifest).
- Plugin load flow:
  1) Resolve plugin manifest + schema (`moltbot.plugin.json`).
  2) Validate config against the schema.
  3) If missing schema or invalid config: block plugin load, record error.
- Error message includes:
  - Plugin id
  - Reason (missing schema / invalid config)
  - Path(s) that failed validation
- Disabled plugins keep their config, but Doctor + logs surface a warning.

## Doctor flow
- Doctor runs **every time** config is loaded (dry-run by default).
- If config invalid:
  - Print a summary + actionable errors.
  - Instruct: `moltbot doctor --fix`.
- `moltbot doctor --fix`:
  - Applies migrations.
  - Removes unknown keys.
  - Writes updated config.

## Command gating (when config is invalid)
Allowed (diagnostic-only):
- `moltbot doctor`
- `moltbot logs`
- `moltbot health`
- `moltbot help`
- `moltbot status`
- `moltbot gateway status`

Everything else must hard-fail with: “Config invalid. Run `moltbot doctor --fix`.”

## Error UX format
- Single summary header.
- Grouped sections:
  - Unknown keys (full paths)
  - Legacy keys / migrations needed
  - Plugin load failures (plugin id + reason + path)

## Implementation touchpoints
- `src/config/zod-schema.ts`: remove root passthrough; strict objects everywhere.
- `src/config/zod-schema.providers.ts`: ensure strict channel schemas.
- `src/config/validation.ts`: fail on unknown keys; do not apply legacy migrations.
- `src/config/io.ts`: remove legacy auto-migrations; always run doctor dry-run.
- `src/config/legacy*.ts`: move usage to doctor only.
- `src/plugins/*`: add schema registry + gating.
- CLI command gating in `src/cli`.

## Tests
- Unknown key rejection (root + nested).
- Plugin missing schema → plugin load blocked with clear error.
- Invalid config → gateway startup blocked except diagnostic commands.
- Doctor dry-run auto; `doctor --fix` writes corrected config.
