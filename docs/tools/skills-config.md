---
summary: "Skills config schema and examples"
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: "Skills Config"
---

# Skills Config

Most skills loader/install configuration lives under `skills` in
`~/.openclaw/openclaw.json`. Agent-specific skill visibility lives under
`agents.defaults.skills` and `agents.list[].skills`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
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

- Native Nano Banana-style setup: `agents.defaults.imageGenerationModel.primary: "google/gemini-3.1-flash-image-preview"`
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
- `load.watch`: watch skill folders and refresh the skills snapshot (default: true).
- `load.watchDebounceMs`: debounce for skill watcher events in milliseconds (default: 250).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun not recommended for WhatsApp/Telegram).
  - `openclaw setup --node-manager` is narrower and currently accepts `npm`,
    `pnpm`, or `bun`. Set `skills.install.nodeManager: "yarn"` manually if you
    want Yarn-backed skill installs.
- `entries.<skillKey>`: per-skill overrides.
- `agents.defaults.skills`: optional default skill allowlist inherited by agents
  that omit `agents.list[].skills`.
- `agents.list[].skills`: optional per-agent final skill allowlist; explicit
  lists replace inherited defaults instead of merging.

Per-skill fields:

- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
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

### Sandboxed skills + env vars

When a session is **sandboxed**, skill processes run inside the configured
sandbox backend. The sandbox does **not** inherit the host `process.env`.

Use one of:

- `agents.defaults.sandbox.docker.env` for the Docker backend (or per-agent `agents.list[].sandbox.docker.env`)
- bake the env into your custom sandbox image or remote sandbox environment

Global `env` and `skills.entries.<skill>.env/apiKey` apply to **host** runs only.
