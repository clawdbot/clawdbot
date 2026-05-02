---
summary: "Migration hub: cross-system imports, machine-to-machine moves, and plugin upgrades"
read_when:
  - You are moving OpenClaw to a new laptop or server
  - You are coming from another agent system and want to keep state
  - You are upgrading an in-place plugin
title: "Migration guide"
---

OpenClaw supports three migration paths: importing from another agent system, moving an existing install to a new machine, and upgrading a plugin in place.

## Import from another agent system

Use the bundled migration providers to bring instructions, MCP servers, skills, model config, and (opt-in) API keys into OpenClaw. Plans are previewed before any change, secrets are redacted in reports, and apply is backed by a verified backup.

<CardGroup cols={2}>
  <Card title="Migrating from Claude" href="/install/migrating-claude" icon="brain">
    Import Claude Code and Claude Desktop state, including `CLAUDE.md`, MCP servers, skills, and project commands.
  </Card>
  <Card title="Migrating from Hermes" href="/install/migrating-hermes" icon="feather">
    Import Hermes config, providers, MCP servers, memory, skills, and supported `.env` keys.
  </Card>
</CardGroup>

The CLI entry point is [`openclaw migrate`](/cli/migrate). Onboarding can also offer migration when it detects a known source (`openclaw onboard --flow import`).

## Move OpenClaw to a new machine

Copy the **state directory** (`~/.openclaw/` by default) and your **workspace** to preserve:

- **Config** — `openclaw.json` and all gateway settings.
- **Auth** — per-agent `auth-profiles.json` (API keys plus OAuth), plus any channel or provider state under `credentials/`.
- **Sessions** — conversation history and agent state.
- **Channel state** — WhatsApp login, Telegram session, and similar.
- **Workspace files** — `MEMORY.md`, `USER.md`, skills, and prompts.

<Tip>
Run `openclaw status` on the old machine to confirm your state directory path. Custom profiles use `~/.openclaw-<profile>/` or a path set via `OPENCLAW_STATE_DIR`.
</Tip>

### Migration steps

<Steps>
  <Step title="Stop the gateway and back up">
    On the **old** machine, stop the gateway so files are not changing mid-copy, then archive:

    ```bash
    openclaw gateway stop
    cd ~
    tar -czf openclaw-state.tgz .openclaw
    ```

    If you use multiple profiles (for example `~/.openclaw-work`), archive each separately.

  </Step>

  <Step title="Install OpenClaw on the new machine">
    [Install](/install) the CLI (and Node if needed) on the new machine. It is fine if onboarding creates a fresh `~/.openclaw/`. You will overwrite it next.
  </Step>

  <Step title="Copy state directory and workspace">
    Transfer the archive via `scp`, `rsync -a`, or an external drive, then extract:

    ```bash
    cd ~
    tar -xzf openclaw-state.tgz
    ```

    Ensure hidden directories were included and file ownership matches the user that will run the gateway.

  </Step>

  <Step title="Run doctor and verify">
    On the new machine, run [Doctor](/gateway/doctor) to apply config migrations and repair services:

    ```bash
    openclaw doctor
    openclaw gateway restart
    openclaw status
    ```

  </Step>
</Steps>

If Telegram or Discord uses the default env fallback (`TELEGRAM_BOT_TOKEN` or `DISCORD_BOT_TOKEN`), verify the migrated state-dir `.env` contains those keys without printing the secret values:

```bash
awk -F= '/^(TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN)=/ { print $1 "=present" }' ~/.openclaw/.env
```

`openclaw doctor` also warns when an enabled default Telegram or Discord account has no configured token and the matching env variable is unavailable to the doctor process.

### Common pitfalls

<AccordionGroup>
  <Accordion title="Profile or state-dir mismatch">
    If the old gateway used `--profile` or `OPENCLAW_STATE_DIR` and the new one does not, channels will appear logged out and sessions will be empty. Launch the gateway with the **same** profile or state-dir you migrated, then rerun `openclaw doctor`.
  </Accordion>

  <Accordion title="Copying only openclaw.json">
    The config file alone is not enough. Model auth profiles live under `agents/<agentId>/agent/auth-profiles.json`, and channel and provider state lives under `credentials/`. Always migrate the **entire** state directory.
  </Accordion>

  <Accordion title="Permissions and ownership">
    If you copied as root or switched users, the gateway may fail to read credentials. Ensure the state directory and workspace are owned by the user running the gateway.
  </Accordion>

  <Accordion title="Remote mode">
    If your UI points at a **remote** gateway, the remote host owns sessions and workspace. Migrate the gateway host itself, not your local laptop. See [FAQ](/help/faq#where-things-live-on-disk).
  </Accordion>

  <Accordion title="Secrets in backups">
    The state directory contains auth profiles, channel credentials, and other provider state. Store backups encrypted, avoid insecure transfer channels, and rotate keys if you suspect exposure.
  </Accordion>
</AccordionGroup>

### Verification checklist

On the new machine, confirm:

- [ ] `openclaw status` shows the gateway running.
- [ ] Channels are still connected (no re-pairing needed).
- [ ] The dashboard opens and shows existing sessions.
- [ ] Workspace files (memory, configs) are present.

## Upgrade a plugin in place

In-place plugin upgrades preserve the same plugin id and config keys but may move on-disk state into the current layout. Plugin-specific upgrade guides live alongside their channels:

- [Matrix migration](/channels/matrix-migration): encrypted-state recovery limits, automatic snapshot behavior, and manual recovery commands.

## Related

- [`openclaw migrate`](/cli/migrate): CLI reference for cross-system imports.
- [Install overview](/install): all installation methods.
- [Doctor](/gateway/doctor): post-migration health check.
- [Uninstall](/install/uninstall): removing OpenClaw cleanly.
