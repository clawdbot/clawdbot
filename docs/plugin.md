---
summary: "Clawdbot plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
---
# Plugins (Extensions)

## Quick start (new to plugins?)

A plugin is just a **small code module** that extends Clawdbot with extra
features (commands, tools, and Gateway RPC).

Most of the time, you’ll use plugins when you want a feature that’s not built
into core Clawdbot yet (or you want to keep optional features out of your main
install).

Fast path:

1) See what’s already loaded:

```bash
clawdbot plugins list
```

2) Install an official plugin (example: Voice Call):

```bash
clawdbot plugins install @clawdbot/voice-call
```

3) Restart the Gateway, then configure under `plugins.entries.<id>.config`.

See [Voice Call](/plugins/voice-call) for a concrete example plugin.

Clawdbot plugins are **TypeScript modules** loaded at runtime via jiti. They can
register:

- Gateway RPC methods
- Agent tools
- CLI commands
- Background services
- Optional config validation

Plugins run **in‑process** with the Gateway, so treat them as trusted code.

## Discovery & precedence

Clawdbot scans, in order:

1) Global extensions
- `~/.clawdbot/extensions/*.ts`
- `~/.clawdbot/extensions/*/index.ts`

2) Workspace extensions
- `<workspace>/.clawdbot/extensions/*.ts`
- `<workspace>/.clawdbot/extensions/*/index.ts`

3) Config paths
- `plugins.load.paths` (file or directory)

### Package packs

A plugin directory may include a `package.json` with `clawdbot.extensions`:

```json
{
  "name": "my-pack",
  "clawdbot": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

If your plugin imports npm deps, install them in that directory so
`node_modules` is available (`npm install` / `pnpm install`).

## Plugin IDs

Default plugin ids:

- Package packs: `package.json` `name`
- Standalone file: file base name (`~/.../voice-call.ts` → `voice-call`)

If a plugin exports `id`, Clawdbot uses it but warns when it doesn’t match the
configured id.

## Config

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } }
    }
  }
}
```

Fields:
- `enabled`: master toggle (default: true)
- `allow`: allowlist (optional)
- `deny`: denylist (optional; deny wins)
- `load.paths`: extra plugin files/dirs
- `entries.<id>`: per‑plugin toggles + config

Config changes **require a gateway restart**.

## Control UI (schema + labels)

The Control UI uses `config.schema` (JSON Schema + `uiHints`) to render better forms.

Clawdbot augments `uiHints` at runtime based on discovered plugins:

- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`
- Merges optional plugin-provided config field hints under:
  `plugins.entries.<id>.config.<field>`

If you want your plugin config fields to show good labels/placeholders (and mark secrets as sensitive),
provide `configSchema.uiHints`.

Example:

```ts
export default {
  id: "my-plugin",
  configSchema: {
    parse: (v) => v,
    uiHints: {
      "apiKey": { label: "API Key", sensitive: true },
      "region": { label: "Region", placeholder: "us-east-1" },
    },
  },
  register(api) {},
};
```

## CLI

```bash
clawdbot plugins list
clawdbot plugins info <id>
clawdbot plugins install <path>              # add a local file/dir to plugins.load.paths
clawdbot plugins install ./extensions/voice-call # relative path ok
clawdbot plugins install ./plugin.tgz        # install from a local tarball
clawdbot plugins install @clawdbot/voice-call # install from npm
clawdbot plugins enable <id>
clawdbot plugins disable <id>
clawdbot plugins doctor
```

Plugins may also register their own top‑level commands (example: `clawdbot voicecall`).

## Plugin API (overview)

Plugins export either:

- A function: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

### Register a tool

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

### Register a gateway RPC method

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Register CLI commands

```ts
export default function (api) {
  api.registerCli(({ program }) => {
    program.command("mycmd").action(() => {
      console.log("Hello");
    });
  }, { commands: ["mycmd"] });
}
```

### Register background services

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Naming conventions

- Gateway methods: `pluginId.action` (example: `voicecall.status`)
- Tools: `snake_case` (example: `voice_call`)
- CLI commands: kebab or camel, but avoid clashing with core commands

## Skills

Plugins can ship a skill in the repo (`skills/<name>/SKILL.md`). Installed
plugin extensions are scanned for skills automatically
(`~/.clawdbot/extensions/*/skills` and `<workspace>/.clawdbot/extensions/*/skills`),
and you can still override with managed/workspace skills if you need to
customize the instructions.

## Distribution (npm)

Recommended packaging:

- Main package: `clawdbot` (this repo)
- Plugins: separate npm packages under `@clawdbot/*` (example: `@clawdbot/voice-call`)

Publishing contract:

- Plugin `package.json` must include `clawdbot.extensions` with one or more entry files.
- Entry files can be `.js` or `.ts` (jiti loads TS at runtime).
- `clawdbot plugins install <npm-spec>` uses `npm pack`, extracts into `~/.clawdbot/extensions/<id>/`, and enables it in config.
- Config key stability: scoped packages are normalized to the **unscoped** id for `plugins.entries.*`.

## Example plugin: Voice Call

This repo includes a voice‑call plugin (Twilio or log fallback):

- Source: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `clawdbot voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optional `statusCallbackUrl`, `twimlUrl`)
- Config (dev): `provider: "log"` (no network)

See [Voice Call](/plugins/voice-call) and `extensions/voice-call/README.md` for setup and usage.

## Safety notes

Plugins run in-process with the Gateway. Treat them as trusted code:

- Only install plugins you trust.
- Prefer `plugins.allow` allowlists.
- Restart the Gateway after changes.

## Testing plugins

Plugins can (and should) ship tests:

- In-repo plugins can keep Vitest tests under `src/**` (example: `src/plugins/voice-call.plugin.test.ts`).
- Separately published plugins should run their own CI (lint/build/test) and validate `clawdbot.extensions` points at the built entrypoint (`dist/index.js`).
