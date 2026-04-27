---
summary: "Agent workspace: location, layout, and backup strategy"
read_when:
  - You need to explain the agent workspace or its file layout
  - You want to back up or migrate an agent workspace
title: "Agent workspace"
sidebarTitle: "Agent workspace"
---

The workspace is the agent's home. It is the only working directory used for file tools and for workspace context. Keep it private and treat it as memory.

This is separate from `~/.openclaw/`, which stores config, credentials, and sessions.

<Warning>
The workspace is the **default cwd**, not a hard sandbox. Tools resolve relative paths against the workspace, but absolute paths can still reach elsewhere on the host unless sandboxing is enabled. If you need isolation, use [`agents.defaults.sandbox`](/gateway/sandboxing) (and/or per-agent sandbox config).

When sandboxing is enabled and `workspaceAccess` is not `"rw"`, tools operate inside a sandbox workspace under `~/.openclaw/sandboxes`, not your host workspace.
</Warning>

## Default location

- Default: `~/.openclaw/workspace`
- If `OPENCLAW_PROFILE` is set and not `"default"`, the default becomes `~/.openclaw/workspace-<profile>`.
- Override in `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
    },
  },
}
```

`openclaw onboard`, `openclaw configure`, or `openclaw setup` will create the workspace and seed the bootstrap files if they are missing.

<Note>
Sandbox seed copies only accept regular in-workspace files; symlink/hardlink aliases that resolve outside the source workspace are ignored.
</Note>

If you already manage the workspace files yourself, you can disable bootstrap file creation:

```json5
{ agents: { defaults: { skipBootstrap: true } } }
```

## Extra workspace folders

Older installs may have created `~/openclaw`. Keeping multiple workspace directories around can cause confusing auth or state drift, because only one workspace is active at a time.

<Note>
**Recommendation:** keep a single active workspace. If you no longer use the extra folders, archive or move them to Trash (for example `trash ~/openclaw`). If you intentionally keep multiple workspaces, make sure `agents.defaults.workspace` points to the active one.

`openclaw doctor` warns when it detects extra workspace directories.
</Note>

## Workspace file map

These are the standard files OpenClaw expects inside the workspace:

<AccordionGroup>
  <Accordion title="AGENTS.md — operating instructions">
    Operating instructions for the agent and how it should use memory. Loaded at the start of every session. Good place for rules, priorities, and "how to behave" details.
  </Accordion>
  <Accordion title="SOUL.md — persona and tone">
    Persona, tone, and boundaries. Loaded every session. Guide: [SOUL.md personality guide](/concepts/soul).
  </Accordion>
  <Accordion title="USER.md — who the user is">
    Who the user is and how to address them. Loaded every session.
  </Accordion>
  <Accordion title="IDENTITY.md — name, vibe, emoji">
    The agent's name, vibe, and emoji. Created/updated during the bootstrap ritual.
  </Accordion>
  <Accordion title="TOOLS.md — local tool conventions">
    Notes about your local tools and conventions. Does not control tool availability; it is only guidance.
  </Accordion>
  <Accordion title="HEARTBEAT.md — heartbeat checklist">
    Optional tiny checklist for heartbeat runs. Keep it short to avoid token burn.
  </Accordion>
  <Accordion title="BOOT.md — startup checklist">
    Optional startup checklist run automatically on gateway restart (when [internal hooks](/automation/hooks) are enabled). Keep it short; use the message tool for outbound sends.
  </Accordion>
  <Accordion title="BOOTSTRAP.md — first-run ritual">
    One-time first-run ritual. Only created for a brand-new workspace. Delete it after the ritual is complete.
  </Accordion>
  <Accordion title="memory/YYYY-MM-DD.md — daily memory log">
    Daily memory log (one file per day). Recommended to read today + yesterday on session start.
  </Accordion>
  <Accordion title="MEMORY.md — curated long-term memory (optional)">
    Curated long-term memory. Only load in the main, private session (not shared/group contexts). See [Memory](/concepts/memory) for the workflow and automatic memory flush.
  </Accordion>
  <Accordion title="skills/ — workspace skills (optional)">
    Workspace-specific skills. Highest-precedence skill location for that workspace. Overrides project agent skills, personal agent skills, managed skills, bundled skills, and `skills.load.extraDirs` when names collide.
  </Accordion>
  <Accordion title="canvas/ — Canvas UI files (optional)">
    Canvas UI files for node displays (for example `canvas/index.html`).
  </Accordion>
</AccordionGroup>

<Note>
If any bootstrap file is missing, OpenClaw injects a "missing file" marker into the session and continues. Large bootstrap files are truncated when injected; adjust limits with `agents.defaults.bootstrapMaxChars` (default: 12000) and `agents.defaults.bootstrapTotalMaxChars` (default: 60000). `openclaw setup` can recreate missing defaults without overwriting existing files.
</Note>

## What is NOT in the workspace

These live under `~/.openclaw/` and should NOT be committed to the workspace repo:

- `~/.openclaw/openclaw.json` (config)
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (model auth profiles: OAuth + API keys)
- `~/.openclaw/credentials/` (channel/provider state plus legacy OAuth import data)
- `~/.openclaw/agents/<agentId>/sessions/` (session transcripts + metadata)
- `~/.openclaw/skills/` (managed skills)

If you need to migrate sessions or config, copy them separately and keep them out of version control.

## Git backup (recommended, private)

Treat the workspace as private memory. Put it in a **private** git repo so it is backed up and recoverable.

Run these steps on the machine where the Gateway runs (that is where the workspace lives).

<Steps>
  <Step title="Initialize the repo">
    If git is installed, brand-new workspaces are initialized automatically. If this workspace is not already a repo, run:

    ```bash
    cd ~/.openclaw/workspace
    git init
    git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
    git commit -m "Add agent workspace"
    ```

  </Step>
  <Step title="Add a private remote">
    <Tabs>
      <Tab title="GitHub web UI">
        1. Create a new **private** repository on GitHub.
        2. Do not initialize with a README (avoids merge conflicts).
        3. Copy the HTTPS remote URL.
        4. Add the remote and push:

        ```bash
        git branch -M main
        git remote add origin <https-url>
        git push -u origin main
        ```
      </Tab>
      <Tab title="GitHub CLI (gh)">
        ```bash
        gh auth login
        gh repo create openclaw-workspace --private --source . --remote origin --push
        ```
      </Tab>
      <Tab title="GitLab web UI">
        1. Create a new **private** repository on GitLab.
        2. Do not initialize with a README (avoids merge conflicts).
        3. Copy the HTTPS remote URL.
        4. Add the remote and push:

        ```bash
        git branch -M main
        git remote add origin <https-url>
        git push -u origin main
        ```
      </Tab>
    </Tabs>

  </Step>
  <Step title="Ongoing updates">
    ```bash
    git status
    git add .
    git commit -m "Update memory"
    git push
    ```
  </Step>
</Steps>

## Do not commit secrets

<Warning>
Even in a private repo, avoid storing secrets in the workspace:

- API keys, OAuth tokens, passwords, or private credentials.
- Anything under `~/.openclaw/`.
- Raw dumps of chats or sensitive attachments.

If you must store sensitive references, use placeholders and keep the real secret elsewhere (password manager, environment variables, or `~/.openclaw/`).
</Warning>

Suggested `.gitignore` starter:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Moving the workspace to a new machine

<Steps>
  <Step title="Clone the repo">
    Clone the repo to the desired path (default `~/.openclaw/workspace`).
  </Step>
  <Step title="Update config">
    Set `agents.defaults.workspace` to that path in `~/.openclaw/openclaw.json`.
  </Step>
  <Step title="Seed missing files">
    Run `openclaw setup --workspace <path>` to seed any missing files.
  </Step>
  <Step title="Copy sessions (optional)">
    If you need sessions, copy `~/.openclaw/agents/<agentId>/sessions/` from the old machine separately.
  </Step>
</Steps>

## Advanced notes

- Multi-agent routing can use different workspaces per agent. See [Channel routing](/channels/channel-routing) for routing configuration.
- If `agents.defaults.sandbox` is enabled, non-main sessions can use per-session sandbox workspaces under `agents.defaults.sandbox.workspaceRoot`.

## Related

- [Heartbeat](/gateway/heartbeat) — HEARTBEAT.md workspace file
- [Sandboxing](/gateway/sandboxing) — workspace access in sandboxed environments
- [Session](/concepts/session) — session storage paths
- [Standing orders](/automation/standing-orders) — persistent instructions in workspace files
