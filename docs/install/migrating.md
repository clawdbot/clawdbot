---
summary: "Move (migrate) an OpenClaw install from one machine to another"
read_when:
  - You are moving OpenClaw to a new laptop/server
  - You want to preserve sessions, auth, and channel logins (WhatsApp, etc.)
title: "Migration guide"
---

# Migrating OpenClaw to a new machine

Move an OpenClaw gateway to a new machine without redoing onboarding.

## What gets migrated

When you copy the **state directory** (`~/.openclaw/` by default) and your **workspace**, you preserve:

- **Config** — `openclaw.json` and all gateway settings.
- **Auth** — per-agent `auth-profiles.json` (API keys plus OAuth), plus any channel or provider state under `credentials/`.
- **Sessions** — conversation history and agent state.
- **Channel state** — WhatsApp login, Telegram session, and similar.
- **Workspace files** — `MEMORY.md`, `USER.md`, skills, and prompts.

<Tip>
Run `openclaw status` on the old machine to confirm your state directory path.
Custom profiles use `~/.openclaw-<profile>/` or a path set via `OPENCLAW_STATE_DIR`.
</Tip>

## Migration steps

<Steps>
  <Step title="Stop the gateway and back up">
    On the **old** machine, stop the gateway so files are not changing mid-copy, then archive:

    ```bash
    openclaw gateway stop
    cd ~
    tar -czf openclaw-state.tgz .openclaw
    ```

    If you use multiple profiles (e.g. `~/.openclaw-work`), archive each separately.

  </Step>

  <Step title="Install OpenClaw on the new machine">
    [Install](/install) the CLI (and Node if needed) on the new machine.
    It is fine if onboarding creates a fresh `~/.openclaw/` -- you will overwrite it next.
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

## Common pitfalls

<AccordionGroup>
  <Accordion title="Profile or state-dir mismatch">
    If the old gateway used `--profile` or `OPENCLAW_STATE_DIR` and the new one does not,
    channels will appear logged out and sessions will be empty.
    Launch the gateway with the **same** profile or state-dir you migrated, then rerun `openclaw doctor`.
  </Accordion>

  <Accordion title="Copying only openclaw.json">
    The config file alone is not enough. Model auth profiles live under
    `agents/<agentId>/agent/auth-profiles.json`, and channel/provider state still
    lives under `credentials/`. Always migrate the **entire** state directory.
  </Accordion>

  <Accordion title="Permissions and ownership">
    If you copied as root or switched users, the gateway may fail to read credentials.
    Ensure the state directory and workspace are owned by the user running the gateway.
  </Accordion>

  <Accordion title="Remote mode">
    If your UI points at a **remote** gateway, the remote host owns sessions and workspace.
    Migrate the gateway host itself, not your local laptop. See [FAQ](/help/faq#where-things-live-on-disk).
  </Accordion>

  <Accordion title="Secrets in backups">
    The state directory contains auth profiles, channel credentials, and other
    provider state.
    Store backups encrypted, avoid insecure transfer channels, and rotate keys if you suspect exposure.
  </Accordion>
</AccordionGroup>

## Verification checklist

On the new machine, confirm:

- [ ] `openclaw status` shows the gateway running
- [ ] Channels are still connected (no re-pairing needed)
- [ ] The dashboard opens and shows existing sessions
- [ ] Workspace files (memory, configs) are present

## Related

- [Install overview](/install)
- [Matrix migration](/install/migrating-matrix)
- [Uninstall](/install/uninstall)
