# PR #124429 exact-head real Gateway proof

Head: `a8319f1e2ca8f69c618c650a33a4beeb632a6a49`

The branch was rebased onto `origin/main` before this capture and the literal head was rebuilt with `pnpm build`.

## Live transport

```text
GET http://127.0.0.1:39159/health
{"ok":true,"status":"live"}

Gateway WebSocket client build:
2026.8.1-a8319f1e2ca8-2026-08-16T18-35-12.558Z
```

## Real Control UI observations

Connected to the isolated Gateway with the bundled Control UI in headed Chromium.

- Control UI build details: `2026.8.1 · codex/pr-12442…@a8319f1`.
- Agent Context overview showed `Skills Filter: 2 selected` for inherited defaults `github, weather`.
- The Skills panel showed `This agent inherits the default skill allowlist.` and disabled `Enable All`.
- Toggling `browser-automation` changed the panel to `This agent uses a custom skill allowlist.` and saved through the live Gateway.
- `Reload Config` preserved the checked `browser-automation` state.

The Gateway recorded live `skills.status`, `config.set`, and config hot-reload events.

Local screenshots and raw snapshots are retained at `/tmp/openclaw-pr124429-rebased.RgCVDl/` (`overview-inherited.png`, `toggle.png`, `toggle-reload.png`, `skills-before.txt`, `final.txt`, `health.json`, and `gateway.log`).
