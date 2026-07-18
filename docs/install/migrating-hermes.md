---
summary: "Move from Hermes to OpenClaw with a previewed, reversible import"
read_when:
  - You are coming from Hermes and want to keep your model config, prompts, memory, and skills
  - You want to know what OpenClaw imports automatically and what stays archive-only
  - You need a clean, scripted migration path (CI, fresh laptop, automation)
title: "Migrating from Hermes"
---

The bundled Hermes migration provider follows `HERMES_HOME` and the active Hermes profile, falling back to `~/.hermes` on macOS/Linux or `%LOCALAPPDATA%\hermes` on Windows. It previews every change before applying, redacts secrets in plans and reports, and writes a verified OpenClaw backup before it touches anything. An explicit `--from` path always wins.

<Note>
Imports require a fresh OpenClaw setup. If you already have local OpenClaw state, reset config, credentials, sessions, and the workspace first, or use `openclaw migrate apply hermes` directly with `--overwrite` after reviewing the plan.
</Note>

## Two ways to import

<Tabs>
  <Tab title="Onboarding wizard">
    Detects the active Hermes home/profile and shows a preview before applying.

    ```bash
    openclaw onboard --flow import
    ```

    Or point at a specific source:

    ```bash
    openclaw onboard --import-from hermes --import-source ~/.hermes
    ```

  </Tab>
  <Tab title="CLI">
    Use `openclaw migrate` for scripted or repeatable runs. See [`openclaw migrate`](/cli/migrate) for the full reference.

    ```bash
    openclaw migrate hermes --dry-run    # preview only
    openclaw migrate apply hermes --yes  # apply with confirmation skipped
    ```

    Add `--from <path>` to override Hermes home/profile discovery.

  </Tab>
</Tabs>

## What gets imported

<AccordionGroup>
  <Accordion title="Model configuration">
    - Default model selection from Hermes `config.yaml`.
    - Configured model providers and custom endpoints from `model`, `providers`, and `custom_providers`, including current Hermes Chat Completions, Codex Responses, and Anthropic Messages transports.

  </Accordion>
  <Accordion title="MCP servers">
    MCP server definitions from `mcp_servers` or `mcp.servers`, including disabled state, timeouts, parallel-tool support, OAuth scope, compatible TLS fields, and native/resource/prompt tool policy. Literal environment variables and headers require credential-import consent. Hermes-only lifecycle, sampling, elicitation, preflight, keepalive, CA-bundle, password-protected client-key, and pre-registered OAuth-client settings become manual-review items instead of invalid OpenClaw config.
  </Accordion>
  <Accordion title="Workspace files">
    - `SOUL.md` and `AGENTS.md` are copied into the OpenClaw agent workspace.
    - `memories/MEMORY.md` and `memories/USER.md` are **appended** to the matching OpenClaw memory files instead of overwriting them.
    - Memory-only surfaces behave differently: the onboarding memory page and the Control UI Memory import page copy these two files under `memory/imports/hermes/` for indexed recall and leave existing workspace memory untouched.

  </Accordion>
  <Accordion title="Memory configuration">
    Memory config defaults for OpenClaw file memory. External memory providers such as Honcho are recorded as archive or manual-review items so you can move them deliberately.
  </Accordion>
  <Accordion title="Skills">
    Skills with a `SKILL.md` file anywhere under `skills/` are discovered recursively, flattened into the OpenClaw workspace skill directory, and copied with their support files. Per-skill config values from `skills.config` are preserved.
  </Accordion>
  <Accordion title="Auth credentials">
    Interactive `openclaw migrate` asks before importing auth credentials, with yes selected by default. Accepted imports include current Hermes OpenAI Codex OAuth entries, OpenCode OpenAI OAuth and GitHub Copilot entries, and the [supported Hermes `.env` keys](/cli/migrate#supported-env-keys). Use `--include-secrets` for non-interactive import, `--no-auth-credentials` to skip credentials, or onboarding's `--import-secrets` flag. After importing Hermes OAuth, do not keep Hermes and OpenClaw using the same refresh grant; reauthenticate one side before running both.
  </Accordion>
</AccordionGroup>

## What stays archive-only

The provider copies these into the migration report directory for manual review, but does **not** load them into live OpenClaw config or credentials:

- `plugins/`
- `sessions/`
- `logs/`
- `cron/`
- `mcp-tokens/`
- `plans/`, `workspace/`, `skins/`, and `kanban/`
- `pairing/` and `platforms/` stores, plus gateway routing/process state
- `state.db`, `hermes_state.db`, `projects.db`, `response_store.db`, `memory_store.db`, `verification_evidence.db`, `kanban.db`, and `retaindb_queue.db`

OpenClaw refuses to execute or trust this state automatically because formats and trust assumptions can drift between systems. Move what you need by hand after reviewing the archive.

## Recommended flow

<Steps>
  <Step title="Preview the plan">
    ```bash
    openclaw migrate hermes --dry-run
    ```

    The plan lists everything that will change, including conflicts, skipped items, and sensitive items. Nested secret-looking keys are redacted in the output.

  </Step>
  <Step title="Apply with backup">
    ```bash
    openclaw migrate apply hermes --yes
    ```

    OpenClaw creates and verifies a backup before applying. This non-interactive example imports non-secret state only. Run without `--yes` to answer the credential prompt interactively, or add `--include-secrets` to include supported credentials in an unattended run.

  </Step>
  <Step title="Run doctor">
    ```bash
    openclaw doctor
    ```

    [Doctor](/gateway/doctor) reapplies any pending config migrations and checks for issues introduced during the import.

  </Step>
  <Step title="Restart and verify">
    ```bash
    openclaw gateway restart
    openclaw status
    ```

    Confirm the gateway is healthy and your imported model, memory, and skills are loaded.

  </Step>
</Steps>

## Conflict handling

Apply refuses to continue when the plan reports conflicts (a file or config value already exists at the target).

<Warning>
Rerun with `--overwrite` only when replacing the existing target is intentional. Providers may still write item-level backups for overwritten files in the migration report directory.
</Warning>

Conflicts are unusual on a fresh install. They typically show up when you re-run the import against a setup that already has user edits.

If a conflict surfaces mid-apply (for example, an unexpected race on a config file), that item is reported as a conflict while independent files, skills, credentials, archives, and config entries continue. Resolve the conflicted item and rerun the import; identical memory imports are idempotent.

## Secrets

Interactive `openclaw migrate` asks whether to import detected auth credentials, with yes selected by default.

- Accepting imports current Hermes OpenAI Codex OAuth entries, OpenCode OpenAI OAuth and GitHub Copilot entries, and the [supported `.env` keys](/cli/migrate#supported-env-keys).
- Use `--no-auth-credentials`, or answer no at the prompt, to import non-secret state only.
- Use `--include-secrets` to import credentials in an unattended `--yes` run.
- Use the onboarding wizard's `--import-secrets` flag to import credentials from the wizard.

## JSON output for automation

```bash
openclaw migrate hermes --dry-run --json
openclaw migrate apply hermes --json --yes
```

With `--json` and no `--yes`, apply prints the plan and does not mutate state — the safest mode for CI and shared scripts.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Apply refuses with conflicts">
    Inspect the plan output. Each conflict identifies the source path and the existing target. Decide per item whether to skip, edit the target, or rerun with `--overwrite`.
  </Accordion>
  <Accordion title="Hermes lives outside ~/.hermes">
    Pass `--from /actual/path` (CLI) or `--import-source /actual/path` (onboarding).
  </Accordion>
  <Accordion title="Onboarding refuses to import on an existing setup">
    Onboarding imports require a fresh setup. Either reset state and re-onboard, or use `openclaw migrate apply hermes` directly, which supports `--overwrite` and explicit backup control.
  </Accordion>
  <Accordion title="API keys did not import">
    Interactive `openclaw migrate` imports API keys only when you accept the credential prompt. Non-interactive `--yes` runs need `--include-secrets`; onboarding imports need `--import-secrets`. Only the [supported `.env` keys](/cli/migrate#supported-env-keys) are recognized — other `.env` variables are ignored.
  </Accordion>
</AccordionGroup>

## Related

- [`openclaw migrate`](/cli/migrate): full CLI reference, plugin contract, and JSON shapes.
- [Onboarding](/cli/onboard): wizard flow and non-interactive flags.
- [Migrating](/install/migrating): move an OpenClaw install between machines.
- [Doctor](/gateway/doctor): post-migration health check.
- [Agent workspace](/concepts/agent-workspace): where `SOUL.md`, `AGENTS.md`, and memory files live.
