# PR #124429 exact-head real Gateway proof

Head: `7f9a1a56eba2bb47f4499632ec6ef6772f3a424e`

The branch was rebased onto `origin/main` before this capture and the literal documentation-bearing head was rebuilt by the Gateway's stale-build guard.

## Live transport

```text
GET http://127.0.0.1:39160/health
{"ok":true,"status":"live"}

Gateway WebSocket client build:
2026.8.1-7f9a1a56eba2-2026-08-16T18-50-24.840Z
```

## Real Control UI observations

Connected to the isolated Gateway with the bundled Control UI in headed Chromium.

- Control UI build details: `2026.8.1 · codex/pr-12442…@a8319f1`.
- Agent Context overview showed `Skills Filter: 2 selected` for inherited defaults `github, weather`.
- The Skills panel showed `This agent inherits the default skill allowlist.` and disabled `Enable All`.
- Toggling `browser-automation` changed the panel to `This agent uses a custom skill allowlist.` and saved through the live Gateway.
- `Reload Config` preserved the checked `browser-automation` state.

The Gateway recorded live `skills.status`, `config.set`, and config hot-reload events at the same `7f9a1a56eba` build.

## Inspectable artifacts

- [Current-head browser screenshot after toggle and reload](pr-124429-current-head.png)
- The captured browser snapshot records the inherited state, `2/54`, and disabled `Enable All` before the toggle; the post-reload snapshot records the custom state, `3/54`, and checked `browser-automation`.
- `GET /health` returned `{"ok":true,"status":"live"}`.
- Gateway log records `build=2026.8.1-7f9a1a56eba2`, `skills.status`, `config.set`, and `config hot reload applied`.

The full local raw snapshots and Gateway log are retained at `/tmp/openclaw-pr124429-exact.9YV5bk/`.
