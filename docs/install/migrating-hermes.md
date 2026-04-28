---
summary: "Move from Hermes to OpenClaw with a previewed, reversible import"
read_when:
  - You are coming from Hermes and want to keep your model config, prompts, memory, and skills
  - You want to know what OpenClaw imports automatically and what stays archive-only
  - You need a clean, scripted migration path (CI, fresh laptop, automation)
title: "Migrating from Hermes"
---

OpenClaw imports Hermes state through a bundled migration provider. The provider previews everything before changing state, redacts secrets in plans and reports, and creates a verified backup before apply.

<Note>
Imports require a fresh OpenClaw setup. If you already have local OpenClaw state, reset config, credentials, sessions, and the workspace first, or use `openclaw migrate` directly with `--overwrite` after reviewing the plan.
</Note>

## Two ways to import

<Tabs>
  <Tab title="Onboarding wizard">
    The fastest path. The wizard detects Hermes at `~/.hermes` and shows a preview before applying.

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

    Add `--from <path>` when Hermes lives outside `~/.hermes`.

  </Tab>
</Tabs>

## What gets imported

<AccordionGroup>
  <Accordion title="Model configuration">
    - Default model selection from Hermes `config.yaml`.
    - Configured model providers and custom OpenAI-compatible endpoints from `providers` and `custom_providers`.

  </Accordion>
  <Accordion title="MCP servers">
    MCP server definitions from `mcp_servers` or `mcp.servers`.
  </Accordion>
  <Accordion title="Workspace files">
    - `SOUL.md` and `AGENTS.md` are copied into the OpenClaw agent workspace.
    - `memories/MEMORY.md` and `memories/USER.md` are **appended** to the matching OpenClaw memory files instead of overwriting them.

  </Accordion>
  <Accordion title="Memory configuration">
    Memory config defaults for OpenClaw file memory. External memory providers such as Honcho are recorded as archive or manual-review items so you can move them deliberately.
  </Accordion>
  <Accordion title="Skills">
    Skills with a `SKILL.md` file under `skills/<name>/` are copied, along with per-skill config values from `skills.config`.
  </Accordion>
  <Accordion title="API keys (opt-in)">
    Set `--include-secrets` to import supported `.env` keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`. Without the flag, secrets are never copied.
  </Accordion>
</AccordionGroup>

## What stays archive-only

The provider copies these into the migration report directory for manual review, but does **not** load them into live OpenClaw config or credentials:

- `plugins/`
- `sessions/`
- `logs/`
- `cron/`
- `mcp-tokens/`
- `auth.json`
- `state.db`

OpenClaw refuses to execute or trust this state automatically because the formats and trust assumptions can drift between systems. Move what you need by hand after reviewing the archive.

## Recommended flow

<Steps>
  <Step title="Preview the plan">
    ```bash
    openclaw migrate hermes --dry-run
    ```

    The plan lists everything that will change, including conflicts, skipped items, and any sensitive items. Plan output redacts nested secret-looking keys.

  </Step>
  <Step title="Apply with backup">
    ```bash
    openclaw migrate apply hermes --yes
    ```

    OpenClaw creates and verifies a backup before applying. If you need API keys imported, add `--include-secrets`.

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

For a fresh OpenClaw install, conflicts are unusual. They typically appear when you re-run the import on a setup that already has user edits.

If a conflict surfaces mid-apply (for example, an unexpected race on a config file), Hermes marks remaining dependent config items as `skipped` with reason `blocked by earlier apply conflict` instead of writing them partially. The migration report records each blocked item so you can resolve the original conflict and rerun the import.

## Secrets

Secrets are never imported by default.

- Run `openclaw migrate apply hermes --yes` first to import non-secret state.
- If you also want supported `.env` keys copied across, rerun with `--include-secrets`.
- For SecretRef-managed credentials, configure the SecretRef source after the import completes.

## JSON output for automation

```bash
openclaw migrate hermes --dry-run --json
openclaw migrate apply hermes --json --yes
```

With `--json` and no `--yes`, apply prints the plan and does not mutate state. This is the safest mode for CI and shared scripts.

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
    `--include-secrets` is required, and only the keys listed above are recognized. Other variables in `.env` are ignored.
  </Accordion>
</AccordionGroup>

## Related

- [`openclaw migrate`](/cli/migrate): full CLI reference, plugin contract, and JSON shapes.
- [Onboarding](/cli/onboard): wizard flow and non-interactive flags.
- [Migrating](/install/migrating): move an OpenClaw install between machines.
- [Doctor](/gateway/doctor): post-migration health check.
- [Agent workspace](/concepts/agent-workspace): where `SOUL.md`, `AGENTS.md`, and memory files live.
