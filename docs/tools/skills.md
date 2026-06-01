---
title: "Skills"
sidebarTitle: "Skills"
summary: "Skills teach your agent how to use tools. Learn how they load, how precedence works, and how to configure gating, allowlists, and environment injection."
read_when:
  - Adding or modifying skills
  - Changing skill gating, allowlists, or load rules
  - Understanding skill precedence and snapshot behavior
---

Skills are markdown instruction files that teach the agent how and when to use
tools. Each skill lives in a directory containing a `SKILL.md` file with YAML
frontmatter and a markdown body. OpenClaw loads bundled skills plus any local
overrides, and filters them at load time based on environment, config, and
binary presence.

<CardGroup cols={2}>
  <Card title="Creating skills" href="/tools/creating-skills" icon="hammer">
    Build and test a custom skill from scratch.
  </Card>
  <Card title="Skill Workshop" href="/tools/skill-workshop" icon="flask">
    Review and approve agent-drafted skill proposals.
  </Card>
  <Card title="Skills config" href="/tools/skills-config" icon="gear">
    Full `skills.*` config schema and agent allowlists.
  </Card>
  <Card title="ClawHub" href="/clawhub" icon="cloud">
    Browse and install community skills.
  </Card>
</CardGroup>

## Loading order

OpenClaw loads from these sources, **highest precedence first**. When the same
skill name appears in multiple places, the highest source wins.

| Priority    | Source                 | Path                                    |
| ----------- | ---------------------- | --------------------------------------- |
| 1 — highest | Workspace skills       | `<workspace>/skills`                    |
| 2           | Project agent skills   | `<workspace>/.agents/skills`            |
| 3           | Personal agent skills  | `~/.agents/skills`                      |
| 4           | Managed / local skills | `~/.openclaw/skills`                    |
| 5           | Bundled skills         | shipped with the install                |
| 6 — lowest  | Extra directories      | `skills.load.extraDirs` + plugin skills |

Skill roots support grouped layouts. OpenClaw discovers a skill whenever
`SKILL.md` appears anywhere under a configured root:

```text
<workspace>/skills/research/SKILL.md          ✓ found as "research"
<workspace>/skills/personal/research/SKILL.md ✓ also found as "research"
```

The folder path is for organization only. The skill's name, slash command, and
allowlist key all come from the `name` frontmatter field (or the directory name
when `name` is missing).

<Note>
  Codex CLI's native `$CODEX_HOME/skills` directory is **not** an OpenClaw
  skill root. Use `openclaw migrate plan codex` to inventory those skills, then
  `openclaw migrate codex` to copy them into your OpenClaw workspace.
</Note>

## Per-agent vs shared skills

In multi-agent setups, each agent has its own workspace. Use the path that
matches your desired visibility:

| Scope          | Path                         | Visible to                  |
| -------------- | ---------------------------- | --------------------------- |
| Per-agent      | `<workspace>/skills`         | Only that agent             |
| Project-agent  | `<workspace>/.agents/skills` | Only that workspace's agent |
| Personal-agent | `~/.agents/skills`           | All agents on this machine  |
| Shared managed | `~/.openclaw/skills`         | All agents on this machine  |
| Extra dirs     | `skills.load.extraDirs`      | All agents on this machine  |

## Agent allowlists

Skill **location** (precedence) and skill **visibility** (which agent can use
it) are separate controls. Use allowlists to restrict which skills an agent sees,
regardless of where they are loaded from.

```json5
{
  agents: {
    defaults: {
      skills: ["github", "weather"], // shared baseline
    },
    list: [
      { id: "writer" }, // inherits github, weather
      { id: "docs", skills: ["docs-search"] }, // replaces defaults entirely
      { id: "locked-down", skills: [] }, // no skills
    ],
  },
}
```

<AccordionGroup>
  <Accordion title="Allowlist rules">
    - Omit `agents.defaults.skills` to leave all skills unrestricted by default.
    - Omit `agents.list[].skills` to inherit `agents.defaults.skills`.
    - Set `agents.list[].skills: []` to expose no skills for that agent.
    - A non-empty `agents.list[].skills` list is the **final** set — it does not
      merge with defaults.
    - The effective allowlist applies across prompt building, slash-command
      discovery, sandbox sync, and skill snapshots.
  </Accordion>
</AccordionGroup>

## Plugins and skills

Plugins can ship their own skills by listing `skills` directories in
`openclaw.plugin.json` (paths relative to the plugin root). Plugin skills load
when the plugin is enabled — for example, the browser plugin ships a
`browser-automation` skill for multi-step browser control.

Plugin skill directories merge at the same low-precedence level as
`skills.load.extraDirs`, so a same-named bundled, managed, agent, or workspace
skill overrides them. Gate them via `metadata.openclaw.requires.config` on the
plugin's config entry.

See [Plugins](/tools/plugin) and [Tools](/tools) for the full plugin system.

## Skill Workshop

[Skill Workshop](/tools/skill-workshop) is a proposal queue between the agent
and your active skill files. When the agent spots reusable work, it drafts a
proposal instead of writing directly to `SKILL.md`. You review and approve
before anything changes.

```bash
openclaw skills workshop list
openclaw skills workshop inspect <proposal-id>
openclaw skills workshop apply <proposal-id>
```

See [Skill Workshop](/tools/skill-workshop) for the full lifecycle, CLI
reference, and configuration.

## Installing from ClawHub

[ClawHub](https://clawhub.ai) is the public skills registry. Use
`openclaw skills` commands for install and update, or the `clawhub` CLI for
publish and sync.

| Action                             | Command                                                |
| ---------------------------------- | ------------------------------------------------------ |
| Install a skill into the workspace | `openclaw skills install <slug>`                       |
| Install from a Git repository      | `openclaw skills install git:owner/repo@ref`           |
| Install a local skill directory    | `openclaw skills install ./path/to/skill --as my-tool` |
| Install for all local agents       | `openclaw skills install <slug> --global`              |
| Update all workspace skills        | `openclaw skills update --all`                         |
| Update a shared managed skill      | `openclaw skills update <slug> --global`               |
| Update all shared managed skills   | `openclaw skills update --all --global`                |
| Verify a skill's trust envelope    | `openclaw skills verify <slug>`                        |
| Print the generated Skill Card     | `openclaw skills verify <slug> --card`                 |
| Publish / sync via ClawHub CLI     | `clawhub sync --all`                                   |

<AccordionGroup>
  <Accordion title="Install details">
    `openclaw skills install` installs into the active workspace `skills/`
    directory by default. Add `--global` to install into the shared
    `~/.openclaw/skills` directory, visible to all local agents unless agent
    allowlists narrow it.

    Git and local installs expect `SKILL.md` at the source root. The slug comes
    from `SKILL.md` frontmatter `name` when valid, then falls back to the
    directory or repository name. Use `--as <slug>` to override.
    `openclaw skills update` tracks ClawHub installs only — reinstall Git or
    local sources to refresh them.

  </Accordion>
  <Accordion title="Verification and security scanning">
    `openclaw skills verify <slug>` asks ClawHub for the skill's
    `clawhub.skill.verify.v1` trust envelope. Installed ClawHub skills verify
    against the version and registry recorded in `.clawhub/origin.json`.

    ClawHub skill pages expose the latest security scan state before install,
    with detail pages for VirusTotal, ClawScan, and static analysis. The
    command exits non-zero when ClawHub marks verification as failed. Publishers
    recover false positives through the ClawHub dashboard or
    `clawhub skill rescan <slug>`.

  </Accordion>
  <Accordion title="Private archive installs">
    Gateway clients that need non-ClawHub delivery can stage a zip skill archive
    with `skills.upload.begin`, `skills.upload.chunk`, and `skills.upload.commit`,
    then install with `skills.install({ source: "upload", ... })`. This path is
    off by default and requires `skills.install.allowUploadedArchives: true` in
    `openclaw.json`. Normal ClawHub installs never need that setting.
  </Accordion>
</AccordionGroup>

## Security

<Warning>
  Treat third-party skills as **untrusted code**. Read them before enabling.
  Prefer sandboxed runs for untrusted inputs and risky tools. See
  [Sandboxing](/gateway/sandboxing) for agent-side controls.
</Warning>

<AccordionGroup>
  <Accordion title="Path containment">
    Workspace, project-agent, and extra-dir skill discovery only accepts skill
    roots whose resolved realpath stays inside the configured root, unless
    `skills.load.allowSymlinkTargets` explicitly trusts a target root.
    Managed `~/.openclaw/skills` and personal `~/.agents/skills` may contain
    symlinked skill folders, but every `SKILL.md` realpath must still stay
    inside its resolved skill directory.
  </Accordion>
  <Accordion title="Scan and scan overrides">
    Gateway-backed skill installs (onboarding, Skills settings UI) run the
    built-in dangerous-code scanner before executing installer metadata.
    `critical` findings block by default; `suspicious` findings warn only.
    `openclaw skills install <slug>` downloads a ClawHub skill folder directly
    and does not use the installer-metadata scanner.
  </Accordion>
  <Accordion title="Secret injection scope">
    `skills.entries.*.env` and `skills.entries.*.apiKey` inject secrets into the
    **host** process for that agent turn only — not into the sandbox. Keep
    secrets out of prompts and logs.
  </Accordion>
</AccordionGroup>

For the broader threat model and security checklists, see
[Security](/gateway/security).

## SKILL.md format

Every skill needs at minimum a `name` and `description` in the frontmatter:

```markdown
---
name: image-lab
description: Generate or edit images via a provider-backed image workflow
---

When the user asks to generate an image, use the `image_generate` tool...
```

<Note>
  OpenClaw follows the [AgentSkills](https://agentskills.io) spec. The
  frontmatter parser supports **single-line keys only** — `metadata` must be a
  single-line JSON object. Use `{baseDir}` in the body to reference the skill
  folder path.
</Note>

### Optional frontmatter keys

<ParamField path="homepage" type="string">
  URL shown as "Website" in the macOS Skills UI. Also supported via
  `metadata.openclaw.homepage`.
</ParamField>

<ParamField path="user-invocable" type="boolean" default="true">
  When `true`, the skill is exposed as a user-invocable slash command.
</ParamField>

<ParamField path="disable-model-invocation" type="boolean" default="false">
  When `true`, OpenClaw keeps the skill's instructions out of the agent's normal
  prompt. The skill is still available as a slash command when `user-invocable`
  is also `true`.
</ParamField>

<ParamField path="command-dispatch" type='"tool"'>
  When set to `tool`, the slash command bypasses the model and dispatches
  directly to a registered tool.
</ParamField>

<ParamField path="command-tool" type="string">
  Tool name to invoke when `command-dispatch: tool` is set.
</ParamField>

<ParamField path="command-arg-mode" type='"raw"' default="raw">
  For tool dispatch, forwards the raw args string to the tool with no
  core parsing. The tool receives
  `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.
</ParamField>

## Gating

OpenClaw filters skills at load time using `metadata.openclaw` (single-line
JSON in the frontmatter). A skill with no `metadata.openclaw` block is always
eligible unless explicitly disabled.

```markdown
---
name: image-lab
description: Generate or edit images via a provider-backed image workflow
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

<ParamField path="always" type="boolean">
  When `true`, always include the skill and skip all other gates.
</ParamField>

<ParamField path="emoji" type="string">
  Optional emoji shown in the macOS Skills UI.
</ParamField>

<ParamField path="homepage" type="string">
  Optional URL shown as "Website" in the macOS Skills UI.
</ParamField>

<ParamField path="os" type='"darwin" | "linux" | "win32"'>
  Platform filter. When set, the skill is only eligible on the listed OSes.
</ParamField>

<ParamField path="requires.bins" type="string[]">
  Each binary must exist on `PATH`.
</ParamField>

<ParamField path="requires.anyBins" type="string[]">
  At least one binary must exist on `PATH`.
</ParamField>

<ParamField path="requires.env" type="string[]">
  Each env var must exist in the process or be provided via config.
</ParamField>

<ParamField path="requires.config" type="string[]">
  Each `openclaw.json` path must be truthy.
</ParamField>

<ParamField path="primaryEnv" type="string">
  Env var name associated with `skills.entries.<name>.apiKey`.
</ParamField>

<ParamField path="install" type="object[]">
  Optional installer specs used by the macOS Skills UI (brew / node / go / uv / download).
</ParamField>

<Note>
  Legacy `metadata.clawdbot` blocks are still accepted when
  `metadata.openclaw` is absent, so older installed skills keep their
  dependency gates and installer hints. New skills should use
  `metadata.openclaw`.
</Note>

### Installer specs

Installer specs tell the macOS Skills UI how to install a dependency:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

<AccordionGroup>
  <Accordion title="Installer selection rules">
    - When multiple installers are listed, the gateway picks one preferred
      option (brew when available, otherwise node).
    - If all installers are `download`, OpenClaw lists each entry so you can
      see all available artifacts.
    - Specs can include `os: ["darwin"|"linux"|"win32"]` to filter by platform.
    - Node installs honor `skills.install.nodeManager` in `openclaw.json`
      (default: npm; options: npm / pnpm / yarn / bun). This only affects skill
      installs; the Gateway runtime should still be Node.
    - Gateway installer preference: Homebrew → uv → configured node manager →
      go → download.
  </Accordion>
  <Accordion title="Per-installer details">
    - **Homebrew:** OpenClaw does not auto-install Homebrew or translate brew
      formulas into system package commands. In Linux containers without
      `brew`, brew-only installers are hidden; use a custom image or install
      the dependency manually.
    - **Go:** if `go` is missing and `brew` is available, the gateway installs
      Go via Homebrew first and sets `GOBIN` to Homebrew's `bin`.
    - **Download:** `url` (required), `archive` (`tar.gz` | `tar.bz2` | `zip`),
      `extract` (default: auto when archive detected), `stripComponents`,
      `targetDir` (default: `~/.openclaw/tools/<skillKey>`).
  </Accordion>
  <Accordion title="Sandboxing notes">
    `requires.bins` is checked on the **host** at skill load time. If an agent
    runs in a sandbox, the binary must also exist **inside the container**.
    Install it via `agents.defaults.sandbox.docker.setupCommand` or a custom
    image. `setupCommand` runs once after container creation and requires
    network egress, a writable root FS, and a root user in the sandbox.
  </Accordion>
</AccordionGroup>

## Config overrides

Toggle and configure bundled or managed skills under `skills.entries` in
`~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      "image-lab": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

<ParamField path="enabled" type="boolean">
  `false` disables the skill even when bundled or installed. The `coding-agent`
  bundled skill is opt-in — set `skills.entries.coding-agent.enabled: true`
  and ensure one of `claude`, `codex`, `opencode`, or another supported CLI
  is installed and authenticated.
</ParamField>

<ParamField path="apiKey" type='string | { source, provider, id }'>
  Convenience field for skills that declare `metadata.openclaw.primaryEnv`.
  Supports a plaintext string or a SecretRef object.
</ParamField>

<ParamField path="env" type="Record<string, string>">
  Environment variables injected for the agent run. Only injected when the
  variable is not already set in the process.
</ParamField>

<ParamField path="config" type="object">
  Optional bag for custom per-skill configuration fields.
</ParamField>

<ParamField path="allowBundled" type="string[]">
  Optional allowlist for **bundled** skills only. When set, only bundled skills
  in the list are eligible. Managed and workspace skills are unaffected.
</ParamField>

<Note>
  Config keys match the **skill name** by default. If a skill defines
  `metadata.openclaw.skillKey`, use that key under `skills.entries`. Quote
  hyphenated names: JSON5 allows quoted keys.
</Note>

## Environment injection

When an agent run starts, OpenClaw:

<Steps>
  <Step title="Reads skill metadata">
    OpenClaw resolves the effective skill list for the agent, applying gating
    rules, allowlists, and config overrides.
  </Step>
  <Step title="Injects env and API keys">
    `skills.entries.<key>.env` and `skills.entries.<key>.apiKey` are applied to
    `process.env` for the duration of the run.
  </Step>
  <Step title="Builds the system prompt">
    Eligible skills are compiled into a compact XML block and injected into the
    system prompt.
  </Step>
  <Step title="Restores the environment">
    After the run ends, the original environment is restored.
  </Step>
</Steps>

<Warning>
  Env injection is scoped to the **host** agent run, not the sandbox. Inside a
  sandbox, `env` and `apiKey` have no effect. See
  [Skills config](/tools/skills-config#sandboxed-skills-and-env-vars) for how
  to pass secrets into sandboxed runs.
</Warning>

For the bundled `claude-cli` backend, OpenClaw also materializes the same
eligible skill snapshot as a temporary Claude Code plugin and passes it via
`--plugin-dir`. Other CLI backends use the prompt catalog only.

## Snapshots and refresh

OpenClaw snapshots eligible skills **when a session starts** and reuses that
list for all subsequent turns in the session. Changes to skills or config take
effect on the next new session.

Skills refresh mid-session in two cases:

- The skills watcher detects a `SKILL.md` change.
- A new eligible remote node connects.

The refreshed list is picked up on the next agent turn. If the effective agent
allowlist changes, OpenClaw refreshes the snapshot to keep visible skills
aligned.

<AccordionGroup>
  <Accordion title="Skills watcher">
    By default, OpenClaw watches skill folders and bumps the snapshot when
    `SKILL.md` files change. Configure under `skills.load`:

    ```json5
    {
      skills: {
        load: {
          extraDirs: ["~/Projects/agent-scripts/skills"],
          allowSymlinkTargets: ["~/Projects/manager/skills"],
          watch: true,
          watchDebounceMs: 250,
        },
      },
    }
    ```

    Use `allowSymlinkTargets` for intentional symlinked layouts where a skill
    root symlink points outside the configured root, for example
    `<workspace>/skills/manager -> ~/Projects/manager/skills`.

  </Accordion>
  <Accordion title="Remote macOS nodes (Linux gateway)">
    If the Gateway runs on Linux but a **macOS node** is connected with
    `system.run` allowed, OpenClaw can treat macOS-only skills as eligible when
    the required binaries are present on that node. The agent should run those
    skills via the `exec` tool with `host=node`.

    Offline nodes do **not** make remote-only skills visible. If a node stops
    answering bin probes, OpenClaw clears its cached bin matches.

  </Accordion>
</AccordionGroup>

## Token impact

When skills are eligible, OpenClaw injects a compact XML block into the system
prompt. The cost is deterministic:

```text
total = 195 + Σ (97 + len(name) + len(description) + len(filepath))
```

- **Base overhead** (only when ≥ 1 skill): ~195 characters
- **Per skill:** ~97 characters + your `name`, `description`, and `location` field lengths
- XML escaping expands `& < > " '` into entities, adding a few characters per occurrence
- At ~4 chars/token, 97 chars ≈ 24 tokens per skill before field lengths

Keep descriptions short and descriptive to minimize prompt overhead.

## Related

<CardGroup cols={2}>
  <Card title="Creating skills" href="/tools/creating-skills" icon="hammer">
    Step-by-step guide to authoring a custom skill.
  </Card>
  <Card title="Skill Workshop" href="/tools/skill-workshop" icon="flask">
    Proposal queue for agent-drafted skills.
  </Card>
  <Card title="Skills config" href="/tools/skills-config" icon="gear">
    Full `skills.*` config schema and agent allowlists.
  </Card>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    How skill slash commands are registered and routed.
  </Card>
  <Card title="ClawHub" href="/clawhub" icon="cloud">
    Browse and publish skills on the public registry.
  </Card>
  <Card title="Plugins" href="/tools/plugin" icon="plug">
    Plugins can ship skills alongside the tools they document.
  </Card>
</CardGroup>
