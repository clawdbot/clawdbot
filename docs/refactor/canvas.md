---
summary: "Plan and audit checklist for moving Canvas out of core and into a bundled experimental plugin."
read_when:
  - Moving Canvas host, tools, commands, docs, or protocol ownership
  - Auditing whether Canvas is still core-owned
  - Preparing or reviewing the experimental Canvas plugin PR
title: "Canvas plugin refactor"
---

# Canvas plugin refactor

Canvas is low-use and experimental. Treat it as a bundled plugin, not a core feature. Core may keep generic gateway, node, HTTP, auth, config, and native-client plumbing, but Canvas-specific behavior should live under `extensions/canvas`.

## Goal

Move Canvas ownership to `extensions/canvas` while preserving the current paired-node behavior:

- the agent-facing `canvas` tool is registered by the Canvas plugin
- Canvas node commands are allowed only when the Canvas plugin registers them
- A2UI host/source files live under the Canvas plugin
- Canvas document materialization lives under the Canvas plugin
- CLI command implementation lives under the Canvas plugin, or delegates through a plugin-owned runtime barrel
- docs and plugin inventory describe Canvas as experimental and plugin-backed

## Non-goals

- Do not redesign the native app Canvas UI in this refactor.
- Do not remove Canvas protocol/client support from iOS, Android, or macOS unless a separate product decision says Canvas should be deleted.
- Do not build a broad plugin service framework only for Canvas unless at least one other bundled plugin needs the same seam.

## Current branch state

Done:

- Added bundled plugin package in `extensions/canvas`.
- Added `extensions/canvas/openclaw.plugin.json`.
- Moved the agent `canvas` tool from `src/agents/tools/canvas-tool.ts` to `extensions/canvas/src/tool.ts`.
- Removed core registration of `createCanvasTool` from `src/agents/openclaw-tools.ts`.
- Moved Canvas host implementation from `src/canvas-host` to `extensions/canvas/src/host`.
- Kept `extensions/canvas/runtime-api.ts` as the plugin-owned compatibility barrel for tests, packaging, and external public Canvas helpers.
- Moved Canvas document materialization from `src/gateway/canvas-documents.ts` to `extensions/canvas/src/documents.ts`.
- Moved Canvas CLI implementation and A2UI JSONL helpers into `extensions/canvas/src/cli.ts`.
- Moved Canvas host URL and scoped capability helpers into `extensions/canvas/src`.
- Moved Canvas node command defaults out of hardcoded core lists and into plugin `nodeInvokePolicies`.
- Added plugin-owned Canvas host config at `plugins.entries.canvas.config.host`.
- Moved Canvas and A2UI HTTP serving behind Canvas plugin HTTP route registration.
- Added generic plugin WebSocket upgrade dispatch for plugin-owned HTTP routes.
- Replaced Canvas-specific gateway host URL and node capability auth with generic hosted plugin surface and node capability helpers.
- Added plugin-owned hosted media resolvers so Canvas document URLs resolve through the Canvas plugin instead of core importing Canvas document internals.
- Added `api.registerNodeCliFeature(...)` so Canvas can declare `openclaw nodes canvas` as a plugin-owned node feature without manually spelling the parent command path.
- Removed production `src/**` imports of `extensions/canvas/runtime-api.js`.
- Moved the A2UI bundle source from `apps/shared/OpenClawKit/Tools/CanvasA2UI` to `extensions/canvas/src/host/a2ui-app`.
- Moved A2UI build/copy implementation under `extensions/canvas/scripts` and replaced root build wiring with generic bundled-plugin asset hooks.
- Removed the runtime legacy top-level `canvasHost` config alias.
- Kept the Canvas doctor migration so `openclaw doctor --fix` rewrites old `canvasHost` configs into `plugins.entries.canvas.config.host`.
- Removed old-agent Canvas protocol compatibility behind gateway protocol v4. Native clients and gateways now use only `pluginSurfaceUrls.canvas` plus `node.pluginSurface.refresh`; the deprecated `canvasHostUrl`, `canvasCapability`, and `node.canvas.capability.refresh` path is intentionally unsupported in this experimental refactor.
- Updated generated plugin inventory to include Canvas.
- Added plugin reference docs at `docs/plugins/reference/canvas.md`.

Known remaining core-owned Canvas surfaces:

- Native app Canvas handlers under `apps/` still intentionally consume the Canvas plugin surface
- native app Canvas protocol/client handlers under `apps/`
- published artifact output still uses `dist/canvas-host/a2ui` for backwards-compatible runtime lookup, but the copy step is now plugin-owned

## Target shape

`extensions/canvas` should own:

- plugin manifest and package metadata
- agent tool registration
- node invoke command policy
- Canvas host and A2UI runtime
- Canvas A2UI bundle source and asset build/copy scripts
- Canvas document creation and asset resolution
- Canvas CLI implementation
- Canvas docs page and plugin inventory entry

Core should own only generic seams:

- plugin discovery and registration
- generic agent tool registry
- generic node invoke policy registry
- generic gateway HTTP/auth and WebSocket upgrade dispatch
- generic hosted plugin surface URL resolution
- generic hosted media resolver registration
- generic node capability transport
- generic config plumbing
- generic bundled-plugin asset hook discovery

Native apps may keep Canvas command handlers as clients of the protocol. They are not the plugin runtime owner.

## Migration steps

1. Treat `plugins.entries.canvas.config.host` as the plugin-owned config surface.
2. Update docs so Canvas is described as an experimental bundled plugin.
3. Run focused Canvas tests, plugin inventory checks, plugin SDK API checks, and build/type gates affected by runtime boundaries.

## Audit checklist

Before calling the refactor complete:

- `rg "src/canvas-host|../canvas-host"` returns no live source imports.
- `rg "canvas-tool|createCanvasTool" src` finds no core-owned Canvas tool implementation.
- `rg "canvas.present|canvas.snapshot|canvas.a2ui" src/gateway` finds no hardcoded allowlist defaults outside generic plugin policy tests.
- `rg "extensions/canvas/runtime-api" src --glob '!**/*.test.ts'` is empty.
- `rg "canvas-documents" src` is empty.
- `rg "registerNodesCanvasCommands|nodes-canvas" src` is empty; the Canvas plugin registers `openclaw nodes canvas` through nested plugin CLI metadata.
- `rg "createCanvasHostHandler|handleA2uiHttpRequest" src/gateway` returns no gateway runtime ownership.
- `rg "apps/shared/OpenClawKit/Tools/CanvasA2UI|canvas-a2ui-copy|extensions/canvas/src/host/a2ui" scripts .github package.json` finds only compatibility wrappers or plugin-owned paths.
- `pnpm plugins:inventory:check` passes.
- `pnpm plugin-sdk:api:check` passes, or generated API baselines are intentionally updated and reviewed.
- Targeted Canvas tests pass.
- Changed-lanes tests pass for Canvas host/A2UI paths.
- PR body explicitly says Canvas is experimental and plugin-backed.

## Verification commands

Use targeted local checks while iterating:

```sh
pnpm test extensions/canvas/src/host/server.test.ts extensions/canvas/src/host/server.state-dir.test.ts extensions/canvas/src/host/file-resolver.test.ts
pnpm test src/gateway/server.plugin-node-capability-auth.test.ts src/gateway/server-import-boundary.test.ts
pnpm test extensions/canvas/src/config-migration.test.ts src/commands/doctor-legacy-config.migrations.test.ts
pnpm test test/scripts/changed-lanes.test.ts test/scripts/build-all.test.ts extensions/canvas/scripts/bundle-a2ui.test.ts test/scripts/bundled-plugin-assets.test.ts extensions/canvas/scripts/copy-a2ui.test.ts src/infra/run-node.test.ts
pnpm tsgo:extensions
pnpm plugins:inventory:check
pnpm plugin-sdk:api:check
```

Run `pnpm build` before push if runtime barrel, lazy import, packaging, or published plugin surfaces change.
