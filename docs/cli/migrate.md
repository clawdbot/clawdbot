---
summary: "CLI reference for `openclaw migrate` (import state from another agent system)"
read_when:
  - You want to migrate from Hermes or another agent system into OpenClaw
  - You are adding a plugin-owned migration provider
title: "Migrate"
---

# `openclaw migrate`

Import state from another agent system through a plugin-owned migration provider. Bundled providers cover Codex CLI state, [Claude](/install/migrating-claude), and [Hermes](/install/migrating-hermes); third-party plugins can register additional providers.

<Tip>
For user-facing walkthroughs, see [Migrating from Claude](/install/migrating-claude) and [Migrating from Hermes](/install/migrating-hermes). The [migration hub](/install/migrating) lists all paths.
</Tip>

## Commands

```bash
openclaw migrate list
openclaw migrate claude --dry-run
openclaw migrate codex --dry-run
openclaw migrate codex --skill gog-vault77-google-workspace
openclaw migrate codex --plugin google-calendar --dry-run
openclaw migrate hermes --dry-run
openclaw migrate hermes
openclaw migrate apply codex --yes --skill gog-vault77-google-workspace
openclaw migrate apply codex --yes --plugin google-calendar
openclaw migrate apply codex --yes
openclaw migrate apply claude --yes
openclaw migrate apply hermes --yes
openclaw migrate apply hermes --include-secrets --yes
openclaw onboard --flow import
openclaw onboard --import-from claude --import-source ~/.claude
openclaw onboard --import-from hermes --import-source ~/.hermes
```

<ParamField path="<provider>" type="string">
  Name of a registered migration provider, for example `hermes`. Run `openclaw migrate list` to see installed providers.
</ParamField>
<ParamField path="--dry-run" type="boolean">
  Build the plan and exit without changing state.
</ParamField>
<ParamField path="--from <path>" type="string">
  Override the source state directory. Hermes defaults to `~/.hermes`.
</ParamField>
<ParamField path="--include-secrets" type="boolean">
  Import supported credentials. Off by default.
</ParamField>
<ParamField path="--overwrite" type="boolean">
  Allow apply to replace existing targets when the plan reports conflicts.
</ParamField>
<ParamField path="--yes" type="boolean">
  Skip the confirmation prompt. Required in non-interactive mode.
</ParamField>
<ParamField path="--skill <name>" type="string">
  Select one skill copy item by skill name or item id. Repeat the flag to migrate multiple skills. When omitted, interactive Codex migrations show a checkbox selector and non-interactive migrations keep all planned skills.
</ParamField>
<ParamField path="--plugin <name>" type="string">
  Select one Codex plugin install item by plugin name or item id. Repeat the flag to migrate multiple Codex plugins. When omitted, interactive Codex migrations show a native Codex plugin checkbox selector and non-interactive migrations keep all planned plugins. This only applies to source-installed `openai-curated` Codex plugins discovered by the Codex app-server inventory.
</ParamField>
<ParamField path="--no-backup" type="boolean">
  Skip the pre-apply backup. Requires `--force` when local OpenClaw state exists.
</ParamField>
<ParamField path="--force" type="boolean">
  Required alongside `--no-backup` when apply would otherwise refuse to skip backup.
</ParamField>
<ParamField path="--json" type="boolean">
  Print the plan or apply result as JSON. With `--json` and no `--yes`, apply prints the plan and does not mutate state.
</ParamField>

## Safety model

`openclaw migrate` is preview-first.

<AccordionGroup>
  <Accordion title="Preview before apply">
    The provider returns an itemized plan before anything changes, including conflicts, skipped items, and sensitive items. JSON plans, apply output, and migration reports redact nested secret-looking keys such as API keys, tokens, authorization headers, cookies, and passwords.

    `openclaw migrate apply <provider>` previews the plan and prompts before changing state unless `--yes` is set. In non-interactive mode, apply requires `--yes`.

  </Accordion>
  <Accordion title="Backups">
    Apply creates and verifies an OpenClaw backup before applying the migration. If no local OpenClaw state exists yet, the backup step is skipped and the migration can continue. To skip a backup when state exists, pass both `--no-backup` and `--force`.
  </Accordion>
  <Accordion title="Conflicts">
    Apply refuses to continue when the plan has conflicts. Review the plan, then rerun with `--overwrite` if replacing existing targets is intentional. Providers may still write item-level backups for overwritten files in the migration report directory.
  </Accordion>
  <Accordion title="Secrets">
    Secrets are never imported by default. Use `--include-secrets` to import supported credentials.
  </Accordion>
</AccordionGroup>

## Claude provider

The bundled Claude provider detects Claude Code state at `~/.claude` by default. Use `--from <path>` to import a specific Claude Code home or project root.

<Tip>
For a user-facing walkthrough, see [Migrating from Claude](/install/migrating-claude).
</Tip>

### What Claude imports

- Project `CLAUDE.md` and `.claude/CLAUDE.md` into the OpenClaw agent workspace.
- User `~/.claude/CLAUDE.md` appended to workspace `USER.md`.
- MCP server definitions from project `.mcp.json`, Claude Code `~/.claude.json`, and Claude Desktop `claude_desktop_config.json`.
- Claude skill directories that include `SKILL.md`.
- Claude command Markdown files converted into OpenClaw skills with manual invocation only.

### Archive and manual-review state

Claude hooks, permissions, environment defaults, local memory, path-scoped rules, subagents, caches, plans, and project history are preserved in the migration report or reported as manual-review items. OpenClaw does not execute hooks, copy broad allowlists, or import OAuth/Desktop credential state automatically.

## Codex provider

The bundled Codex provider detects Codex CLI state at `~/.codex` by default, or
at `CODEX_HOME` when that environment variable is set. Use `--from <path>` to
inventory a specific Codex home.

Use this provider when moving to the OpenClaw Codex harness and you want to
promote useful personal Codex CLI assets deliberately. Local Codex app-server
launches use per-agent `CODEX_HOME` and `HOME` directories, so they do not read
your personal Codex CLI state by default.

Running `openclaw migrate codex` in an interactive terminal previews the full
plan, then opens checkbox selectors before the final apply confirmation. Skill
copy items are prompted first. Use `Toggle all on` or `Toggle all off` for bulk
selection; planned skills start checked, conflict skills start unchecked, and
`Skip for now` skips skill copies for this run while still continuing to plugin
selection. When source-installed curated Codex plugins are migratable and
`--plugin` was not supplied, migration then prompts for native Codex plugin
activation by plugin name. Plugin items
start checked unless the target OpenClaw Codex plugin config already has that
plugin. Existing target plugins start unchecked and show a conflict hint such as
`conflict: plugin exists`; choose `Toggle all off` to migrate no native Codex
plugins in that run, or `Skip for now` to stop before applying. For scripted or
exact runs, pass `--skill <name>` once per skill, for example:

```bash
openclaw migrate codex --dry-run --skill gog-vault77-google-workspace
openclaw migrate apply codex --yes --skill gog-vault77-google-workspace
```

Use `--plugin <name>` to limit native Codex plugin migration non-interactively
to one or more source-installed curated plugins:

```bash
openclaw migrate codex --dry-run --plugin google-calendar
openclaw migrate apply codex --yes --plugin google-calendar
```

### What Codex imports

- Codex CLI skill directories under `$CODEX_HOME/skills`, excluding Codex's
  `.system` cache.
- Personal AgentSkills under `$HOME/.agents/skills`, copied into the current
  OpenClaw agent workspace when you want per-agent ownership.
- Source-installed `openai-curated` Codex plugins discovered through Codex
  app-server `plugin/list`. Apply calls app-server `plugin/install` for each
  selected plugin, even if the target app-server already reports that plugin as
  installed and enabled. Migrated Codex plugins are usable only in sessions that
  select the native Codex harness; they are not exposed to Pi, normal OpenAI
  provider runs, ACP conversation bindings, or other harnesses.

### Manual-review Codex state

Codex `config.toml`, native `hooks/hooks.json`, non-curated marketplaces, and
cached plugin bundles that are not source-installed curated plugins are not
activated automatically. They are copied or reported in the migration report for
manual review.

For migrated source-installed curated plugins, apply writes:

- `plugins.entries.codex.enabled: true`
- `plugins.entries.codex.config.codexPlugins.enabled: true`
- `plugins.entries.codex.config.codexPlugins.allow_destructive_actions: true`
- one explicit plugin entry with `marketplaceName: "openai-curated"` and
  `pluginName` for each selected plugin

Migration never writes `plugins["*"]` and never stores local marketplace cache
paths. Auth-required installs are reported on the affected plugin item with
`status: "skipped"`, `reason: "auth_required"`, and sanitized app identifiers.
Their explicit config entries are written disabled until you reauthorize and
enable them. Other install failures are item-scoped `error` results.

If Codex app-server plugin inventory is unavailable during planning, migration
falls back to cached bundle advisory items instead of failing the whole
migration.

## Hermes provider

The bundled Hermes provider detects state at `~/.hermes` by default. Use `--from <path>` when Hermes lives elsewhere.

### What Hermes imports

- Default model configuration from `config.yaml`.
- Configured model providers and custom OpenAI-compatible endpoints from `providers` and `custom_providers`.
- MCP server definitions from `mcp_servers` or `mcp.servers`.
- `SOUL.md` and `AGENTS.md` into the OpenClaw agent workspace.
- `memories/MEMORY.md` and `memories/USER.md` appended to workspace memory files.
- Memory config defaults for OpenClaw file memory, plus archive or manual-review items for external memory providers such as Honcho.
- Skills that include a `SKILL.md` file under `skills/<name>/`.
- Per-skill config values from `skills.config`.
- Supported API keys from `.env`, only with `--include-secrets`.

### Supported `.env` keys

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`.

### Archive-only state

Hermes state that OpenClaw cannot safely interpret is copied into the migration report for manual review, but it is not loaded into live OpenClaw config or credentials. This preserves opaque or unsafe state without pretending OpenClaw can execute or trust it automatically:

- `plugins/`
- `sessions/`
- `logs/`
- `cron/`
- `mcp-tokens/`
- `auth.json`
- `state.db`

### After applying

```bash
openclaw doctor
```

## Plugin contract

Migration sources are plugins. A plugin declares its provider ids in `openclaw.plugin.json`:

```json
{
  "contracts": {
    "migrationProviders": ["hermes"]
  }
}
```

At runtime the plugin calls `api.registerMigrationProvider(...)`. The provider implements `detect`, `plan`, and `apply`. Core owns CLI orchestration, backup policy, prompts, JSON output, and conflict preflight. Core passes the reviewed plan into `apply(ctx, plan)`, and providers may rebuild the plan only when that argument is absent for compatibility.

Provider plugins can use `openclaw/plugin-sdk/migration` for item construction and summary counts, plus `openclaw/plugin-sdk/migration-runtime` for conflict-aware file copies, archive-only report copies, cached config-runtime wrappers, and migration reports.

## Onboarding integration

Onboarding can offer migration when a provider detects a known source. Both `openclaw onboard --flow import` and `openclaw setup --wizard --import-from hermes` use the same plugin migration provider and still show a preview before applying.

<Note>
Onboarding imports require a fresh OpenClaw setup. Reset config, credentials, sessions, and the workspace first if you already have local state. Backup-plus-overwrite or merge imports are feature-gated for existing setups.
</Note>

## Related

- [Migrating from Hermes](/install/migrating-hermes): user-facing walkthrough.
- [Migrating from Claude](/install/migrating-claude): user-facing walkthrough.
- [Migrating](/install/migrating): move OpenClaw to a new machine.
- [Doctor](/gateway/doctor): health check after applying a migration.
- [Plugins](/tools/plugin): plugin install and registration.
