---
title: "OpenProse removal and migration"
sidebarTitle: "OpenProse migration"
summary: "OpenClaw no longer bundles OpenProse or the /prose command. Move to the maintained upstream Agent Skill and clean stale plugin configuration."
read_when:
  - You used the bundled OpenProse plugin or /prose command
  - You need to clean OpenProse configuration after upgrading OpenClaw
  - You want to install the maintained upstream OpenProse Agent Skill
---

OpenClaw no longer bundles the OpenProse plugin or its `/prose` command. OpenProse
continues as a maintained upstream Agent Skill. Existing `.prose` source files
remain yours; the removed plugin did not store state in OpenClaw's SQLite database.

## Migrate

1. Clean stale bundled-plugin configuration:

   ```bash
   openclaw doctor --fix
   ```

   Doctor removes `open-prose` from plugin allowlists, denylists, and plugin
   entries. No OpenClaw database migration is required.

2. From your workspace root, install the upstream skill:

   ```bash
   npx skills add openprose/prose --skill open-prose --agent codex --copy -y
   ```

   This copies the skill to `.agents/skills/open-prose`, which OpenClaw loads as
   a project Agent Skill. It does not restore the removed bundled plugin or the
   `/prose` command.

3. If you are upgrading older OpenProse source, start a new OpenClaw agent
   session in the workspace and send:

   ```text
   prose upgrade --dry-run
   ```

   This is an Agent Skill command, not a shell executable. Review the plan, then
   send `prose upgrade` in the same session. The upstream upgrade does not
   migrate old runtime ledgers or state, so retain your source files and begin
   with a clean state directory.

## Related

- [Skills](/tools/skills)
- [Slash commands](/tools/slash-commands)
- [Lobster workflows](/tools/lobster)
- [OpenProse upstream](https://github.com/openprose/prose)
