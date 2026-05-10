---
summary: "Skills config schema and examples"
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: "Skills config"
---

Most skills loader/install configuration lives under `skills` in
`~/.openclaw/openclaw.json`. Agent-specific skill visibility lives under
`agents.defaults.skills` and `agents.list[].skills`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      allowSymlinkTargets: ["~/Projects/manager/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
      allowUploadedArchives: false,
    },
    entries: {
      "image-lab": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

For built-in image generation/editing, prefer `agents.defaults.imageGenerationModel`
plus the core `image_generate` tool. `skills.entries.*` is only for custom or
third-party skill workflows.

If you select a specific image provider/model, also configure that provider's
auth/API key. Typical examples: `GEMINI_API_KEY` or `GOOGLE_API_KEY` for
`google/*`, `OPENAI_API_KEY` for `openai/*`, and `FAL_KEY` for `fal/*`.

Examples:

- Native Nano Banana Pro-style setup: `agents.defaults.imageGenerationModel.primary: "google/gemini-3-pro-image-preview"`
- Native fal setup: `agents.defaults.imageGenerationModel.primary: "fal/fal-ai/flux/dev"`

## Agent skill allowlists

Use agent config when you want the same machine/workspace skill roots, but a
different visible skill set per agent.

```json5
{
  agents: {
    defaults: {
      skills: ["github", "weather"],
    },
    list: [
      { id: "writer" }, // inherits defaults -> github, weather
      { id: "docs", skills: ["docs-search"] }, // replaces defaults
      { id: "locked-down", skills: [] }, // no skills
    ],
  },
}
```

Rules:

- `agents.defaults.skills`: shared baseline allowlist for agents that omit
  `agents.list[].skills`.
- Omit `agents.defaults.skills` to leave skills unrestricted by default.
- `agents.list[].skills`: explicit final skill set for that agent; it does not
  merge with defaults.
- `agents.list[].skills: []`: expose no skills for that agent.

## Fields

- Built-in skill roots always include `~/.openclaw/skills`, `~/.agents/skills`,
  `<workspace>/.agents/skills`, and `<workspace>/skills`.
- `allowBundled`: optional allowlist for **bundled** skills only. When set, only
  bundled skills in the list are eligible (managed, agent, and workspace skills unaffected).
- `load.extraDirs`: additional skill directories to scan (lowest precedence).
- `load.allowSymlinkTargets`: trusted real target directories that symlinked
  skill folders may resolve into even when the symlink lives outside that
  target root. Use this for intentional sibling-repo layouts such as
  `~/.agents/skills/manager -> ~/Projects/manager/skills`.
- `load.watch`: watch skill folders and refresh the skills snapshot (default: true).
- `load.watchDebounceMs`: debounce for skill watcher events in milliseconds (default: 250).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun not recommended for WhatsApp/Telegram).
  - `openclaw setup --node-manager` is narrower and currently accepts `npm`,
    `pnpm`, or `bun`. Set `skills.install.nodeManager: "yarn"` manually if you
    want Yarn-backed skill installs.
- `install.allowUploadedArchives`: allow trusted `operator.admin` Gateway
  clients to install private zip archives staged through `skills.upload.*`
  (default: false). This only enables the uploaded-archive path; normal ClawHub
  installs do not require it.
- `entries.<skillKey>`: per-skill overrides.
- `agents.defaults.skills`: optional default skill allowlist inherited by agents
  that omit `agents.list[].skills`.
- `agents.list[].skills`: optional per-agent final skill allowlist; explicit
  lists replace inherited defaults instead of merging.

## Symlinked sibling repos

By default, each skill root is a containment boundary. If a skill folder under
`~/.agents/skills` is a symlink that resolves outside `~/.agents/skills`,
OpenClaw skips it and logs `Skipping escaped skill path outside its configured
root`.

Keep the symlink layout and allow only the trusted target root:

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

With this config, a symlink such as
`~/.agents/skills/manager -> ~/Projects/manager/skills` is accepted after
realpath resolution. `extraDirs` also scans the sibling repo directly, while
`allowSymlinkTargets` preserves the symlinked path for existing agent-skill
layouts. Keep target entries narrow; do not point at broad roots such as `~` or
`~/Projects` unless every skill tree under that root is trusted.

Per-skill fields:

- `enabled`: set `false` to disable a skill even if it's bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var.
  Supports plaintext string or SecretRef object (`{ source, provider, id }`).

## Notes

- Keys under `entries` map to the skill name by default. If a skill defines
  `metadata.openclaw.skillKey`, use that key instead.
- Load precedence is `<workspace>/skills` → `<workspace>/.agents/skills` →
  `~/.agents/skills` → `~/.openclaw/skills` → bundled skills →
  `skills.load.extraDirs`.
- Changes to skills are picked up on the next agent turn when the watcher is enabled.

### Sandboxed skills and env vars

When a session is **sandboxed**, skill processes run inside the configured sandbox backend. The sandbox does **not** inherit the host `process.env`.

<Warning>
  Global `env` and `skills.entries.<skill>.env`/`apiKey` apply to **host** runs only. Inside a sandbox they have no effect, so a skill that depends on `GEMINI_API_KEY` will fail with `apiKey not configured` unless the sandbox is given the variable separately.
</Warning>

Use one of:

- `agents.defaults.sandbox.docker.env` for the Docker backend (or per-agent `agents.list[].sandbox.docker.env`).
- Bake the env into your custom sandbox image or remote sandbox environment.

## Related

<CardGroup cols={2}>
  <Card title="Skills" href="/tools/skills" icon="puzzle-piece">
    What skills are and how they load.
  </Card>
  <Card title="Creating skills" href="/tools/creating-skills" icon="hammer">
    Authoring custom skill packs.
  </Card>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    Native command catalog and chat directives.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full `skills` and `agents.skills` schema.
  </Card>
</CardGroup>
