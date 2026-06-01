---
title: "Skills config"
sidebarTitle: "Skills config"
summary: "Full reference for the skills.* config schema, agent allowlists, workshop settings, and sandbox env var handling."
read_when:
  - Configuring skill loading, install, or gating behavior
  - Setting per-agent skill visibility
  - Adjusting Skill Workshop limits or approval policy
---

Most skills configuration lives under `skills` in
`~/.openclaw/openclaw.json`. Agent-specific visibility lives under
`agents.defaults.skills` and `agents.list[].skills`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills"],
      allowSymlinkTargets: ["~/Projects/manager/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm",
      allowUploadedArchives: false,
    },
    workshop: {
      autonomous: { enabled: false },
      approvalPolicy: "pending",
      maxPending: 50,
      maxSkillBytes: 40000,
    },
    entries: {
      "image-lab": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

<Note>
  For built-in image generation, use `agents.defaults.imageGenerationModel`
  plus the core `image_generate` tool instead of `skills.entries`. Skill
  entries are for custom or third-party skill workflows only.
</Note>

## Loading (`skills.load`)

<ParamField path="skills.load.extraDirs" type="string[]">
  Additional skill directories to scan, at the lowest precedence (after bundled
  and plugin skills). Paths are expanded with `~` support.
</ParamField>

<ParamField path="skills.load.allowSymlinkTargets" type="string[]">
  Trusted real target directories that symlinked skill folders may resolve into,
  even when the symlink lives outside the configured root. Use this for
  intentional sibling-repo layouts such as
  `<workspace>/skills/manager -> ~/Projects/manager/skills`. Keep this list
  narrow — do not point at broad roots like `~` or `~/Projects`.
</ParamField>

<ParamField path="skills.load.watch" type="boolean" default="true">
  Watch skill folders and refresh the skills snapshot when `SKILL.md` files
  change. Covers nested files under grouped skill roots.
</ParamField>

<ParamField path="skills.load.watchDebounceMs" type="number" default="250">
  Debounce window for skill watcher events in milliseconds.
</ParamField>

## Install (`skills.install`)

<ParamField path="skills.install.preferBrew" type="boolean" default="true">
  Prefer Homebrew installers when `brew` is available.
</ParamField>

<ParamField path="skills.install.nodeManager" type='"npm" | "pnpm" | "yarn" | "bun"' default='"npm"'>
  Node package manager preference for skill installs. This only affects skill
  installs — the Gateway runtime should still use Node (Bun is not recommended
  for WhatsApp/Telegram). Use `openclaw setup --node-manager` for npm, pnpm,
  or bun; set `"yarn"` manually for Yarn-backed skill installs.
</ParamField>

<ParamField path="skills.install.allowUploadedArchives" type="boolean" default="false">
  Allow trusted `operator.admin` Gateway clients to install private zip
  archives staged through `skills.upload.*`. Normal ClawHub installs do not
  need this setting.
</ParamField>

## Bundled skill allowlist

<ParamField path="skills.allowBundled" type="string[]">
  Optional allowlist for **bundled** skills only. When set, only bundled skills
  in the list are eligible. Managed, agent-level, and workspace skills are
  unaffected.
</ParamField>

## Per-skill entries (`skills.entries`)

Keys under `entries` match the skill `name` by default. If a skill defines
`metadata.openclaw.skillKey`, use that key instead. Quote hyphenated names
(JSON5 allows quoted keys).

<ParamField path="skills.entries.<key>.enabled" type="boolean">
  `false` disables the skill even when bundled or installed. The `coding-agent`
  bundled skill is opt-in — set it to `true` and ensure one of `claude`,
  `codex`, `opencode`, or another supported CLI is installed and authenticated.
</ParamField>

<ParamField path="skills.entries.<key>.apiKey" type='string | { source, provider, id }'>
  Convenience field for skills that declare `metadata.openclaw.primaryEnv`.
  Supports a plaintext string or a SecretRef: `{ source: "env", provider: "default", id: "VAR_NAME" }`.
</ParamField>

<ParamField path="skills.entries.<key>.env" type="Record<string, string>">
  Environment variables injected for the agent run. Only injected when the
  variable is not already set in the process.
</ParamField>

<ParamField path="skills.entries.<key>.config" type="object">
  Optional bag for custom per-skill configuration fields.
</ParamField>

## Agent allowlists (`agents`)

Use agent config when you want the same machine/workspace skill roots but a
different visible skill set per agent.

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

<ParamField path="agents.defaults.skills" type="string[]">
  Shared baseline allowlist inherited by agents that omit `agents.list[].skills`.
  Omit entirely to leave skills unrestricted by default.
</ParamField>

<ParamField path="agents.list[].skills" type="string[]">
  Explicit final skill set for that agent. Explicit lists **replace** inherited
  defaults — they do not merge. Set to `[]` to expose no skills for that agent.
</ParamField>

## Workshop (`skills.workshop`)

<ParamField path="skills.workshop.autonomous.enabled" type="boolean" default="false">
  When `true`, agents can create pending proposals from durable conversation
  signals after successful turns. User-prompted skill creation always goes
  through Skill Workshop regardless of this setting.
</ParamField>

<ParamField path="skills.workshop.approvalPolicy" type='"pending" | "auto"' default='"pending"'>
  `pending` requires operator approval before agent-initiated apply, reject, or
  quarantine. `auto` allows those actions without approval.
</ParamField>

<ParamField path="skills.workshop.maxPending" type="number" default="50">
  Maximum pending and quarantined proposals retained per workspace.
</ParamField>

<ParamField path="skills.workshop.maxSkillBytes" type="number" default="40000">
  Maximum proposal body size in bytes. Proposal descriptions are hard-capped at
  160 bytes because they appear in discovery and listing output.
</ParamField>

## Symlinked skill roots

By default, workspace, project-agent, extra-dir, and bundled skill roots are
containment boundaries. A symlinked skill folder under `<workspace>/skills`
that resolves outside the root is skipped with a log message.

To allow an intentional symlink layout, declare the trusted target:

```json5
{
  skills: {
    load: {
      extraDirs: ["~/Projects/manager/skills"],
      allowSymlinkTargets: ["~/Projects/manager/skills"],
    },
  },
}
```

With this config, `<workspace>/skills/manager -> ~/Projects/manager/skills` is
accepted after realpath resolution. `extraDirs` scans the sibling repo directly;
`allowSymlinkTargets` preserves the symlinked path for existing layouts.

Managed `~/.openclaw/skills` and personal `~/.agents/skills` directories
already accept skill-directory symlinks (per-skill `SKILL.md` containment still
applies).

## Sandboxed skills and env vars

<Warning>
  `skills.entries.<skill>.env` and `apiKey` apply to **host** runs only. Inside
  a sandbox they have no effect — a skill that depends on `GEMINI_API_KEY` will
  fail with `apiKey not configured` unless the sandbox is given the variable
  separately.
</Warning>

Pass secrets into a Docker sandbox with:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          env: { GEMINI_API_KEY: "your-key-here" },
        },
      },
    },
  },
}
```

<Note>
  Users with Docker daemon access can inspect `sandbox.docker.env` values
  through Docker metadata. Use a mounted secret file, a custom image, or
  another delivery path when that exposure is not acceptable.
</Note>

## Loading order reminder

```text
workspace/skills      (highest)
workspace/.agents/skills
~/.agents/skills
~/.openclaw/skills
bundled skills
skills.load.extraDirs (lowest)
```

Changes to skills and config take effect on the next new session when the
watcher is enabled, or on the next agent turn when the watcher detects a change.

## Related

<CardGroup cols={2}>
  <Card title="Skills reference" href="/tools/skills" icon="puzzle-piece">
    What skills are, loading order, gating, and SKILL.md format.
  </Card>
  <Card title="Creating skills" href="/tools/creating-skills" icon="hammer">
    Authoring custom workspace skills.
  </Card>
  <Card title="Skill Workshop" href="/tools/skill-workshop" icon="flask">
    Proposal queue for agent-drafted skills.
  </Card>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    Native slash-command catalog and chat directives.
  </Card>
</CardGroup>
