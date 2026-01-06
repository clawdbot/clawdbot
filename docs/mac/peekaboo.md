---
summary: "Plan for integrating Peekaboo automation into Clawdbot via PeekabooBridge (socket-based TCC broker)"
read_when:
  - Hosting PeekabooBridge in Clawdbot.app
  - Integrating Peekaboo as a submodule
  - Changing PeekabooBridge protocol/paths
---
# Peekaboo Bridge in Clawdbot (macOS UI automation broker)

## TL;DR
- **Peekaboo removed its XPC helper** and now exposes privileged automation via a **UNIX domain socket bridge** (`PeekabooBridge` / `PeekabooBridgeHost`, socket name `bridge.sock`).
- Clawdbot integrates by **optionally hosting the same bridge** inside **Clawdbot.app** (user-toggleable). The primary client is the **`peekaboo` CLI** (installed via npm); Clawdbot does not need its own `ui …` CLI surface.
- For **visualizations**, we keep them in **Peekaboo.app** (best UX); Clawdbot stays a thin broker host. No visualizer toggle in Clawdbot.

Non-goals:
- No auto-launching Peekaboo.app.
- No onboarding deep links from the automation endpoint (Clawdbot onboarding already handles permissions).
- No AI provider/agent runtime dependencies in Clawdbot (avoid pulling Tachikoma/MCP into the Clawdbot app/CLI).

## Big refactor (Dec 2025): XPC → Bridge
Peekaboo’s privileged execution moved from “CLI → XPC helper” to “CLI → socket bridge host”. For Clawdbot this is a win:
- It matches the existing “local socket + codesign checks” approach.
- It lets us piggyback on **either** Peekaboo.app’s permissions **or** Clawdbot.app’s permissions (whichever is running).
- It avoids “two apps with two TCC bubbles” unless needed.

Reference (Peekaboo submodule): `Peekaboo/docs/bridge-host.md`.

## Architecture
### Processes
- **Bridge hosts** (provide TCC-backed automation):
  - **Peekaboo.app** (preferred; also provides visualizations + controls)
  - **Claude.app** (secondary; lets `peekaboo` reuse Claude Desktop’s granted permissions)
  - **Clawdbot.app** (secondary; “thin host” only)
- **Bridge clients** (trigger single actions):
  - `peekaboo …` (preferred; humans + agents)
  - Optional: Clawdbot/Node shells out to `peekaboo` when it needs UI automation/capture

### Host discovery (client-side)
Order is deliberate:
1. Peekaboo.app host (full UX)
2. Claude.app host (piggyback on Claude Desktop permissions)
3. Clawdbot.app host (piggyback on Clawdbot permissions)

Socket paths (convention; exact paths must match Peekaboo):
- Peekaboo: `~/Library/Application Support/Peekaboo/bridge.sock`
- Claude: `~/Library/Application Support/Claude/bridge.sock`
- Clawdbot: `~/Library/Application Support/clawdbot/bridge.sock`

No auto-launch: if a host isn’t reachable, the command fails with a clear error (start Peekaboo.app, Claude.app, or Clawdbot.app).

Override (debugging): set `PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock`.

### Protocol shape
- **Single request per connection**: connect → write one JSON request → half-close → read one JSON response → close.
- **Timeout**: 10 seconds end-to-end per action (client enforced; host should also enforce per-operation).
- **Errors**: human-readable string by default; structured envelope in `--json`.

## Dependency strategy (submodule)
Integrate Peekaboo via git submodule (nested submodules are OK).

Path in Clawdbot repo:
- `./Peekaboo` (Swabble-style; keep stable so SwiftPM path deps don’t churn).

What Clawdbot should use:
- **Client side**: `PeekabooBridge` (socket client + protocol models).
- **Host side (Clawdbot.app)**: `PeekabooBridgeHost` + the minimal Peekaboo services needed to implement operations.

What Clawdbot should *not* embed:
- **Visualizer UI**: keep it in Peekaboo.app for now (toggle + controls live there).
- **XPC**: don’t reintroduce helper targets; use the bridge.

## IPC / CLI surface
### No `clawdbot ui …`
We avoid a parallel “Clawdbot UI automation CLI”. Instead:
- `peekaboo` is the user/agent-facing CLI surface for automation and capture.
- Clawdbot.app can host PeekabooBridge as a **thin TCC broker** so Peekaboo can piggyback on Clawdbot permissions when Peekaboo.app isn’t running.

### Diagnostics
Use Peekaboo’s built-in diagnostics to see which host would be used:
- `peekaboo bridge status`
- `peekaboo bridge status --verbose`
- `peekaboo bridge status --json`

### Output format
Peekaboo commands default to human text output. Add `--json` for a structured envelope.

### Timeouts
Default timeout for UI actions: **10 seconds** end-to-end (client enforced; host should also enforce per-operation).

## Coordinate model (multi-display)
Requirement: coordinates are **per screen**, not global.

Standardize for the CLI (agent-friendly): **top-left origin per screen**.

Proposed request shape:
- Requests accept `screenIndex` + `{x, y}` in that screen’s local coordinate space.
- Clawdbot.app converts to global CG coordinates using `NSScreen.screens[screenIndex].frame.origin`.
- Responses should echo both:
  - The resolved `screenIndex`
  - The local `{x, y}` and bounds
  - Optionally the global `{x, y}` for debugging

Ordering: use `NSScreen.screens` ordering consistently (documented in the CLI help + JSON schema).

## Targeting (per app/window)
Expose window/app targeting in the UI surface (align with Peekaboo targeting):
- frontmost
- by app name / bundle id
- by window title substring
- by (app, index)

Peekaboo CLI targeting (agent-friendly):
- `--bundle-id <id>` for app targeting
- `--window-index <n>` (0-based) for disambiguating within an app when capturing

All “see/click/type/scroll/wait” requests should accept a target (default: frontmost).

## “See” + click packs (Playwright-style)
Behavior stays aligned with Peekaboo:
- `peekaboo see` returns element IDs (e.g. `B1`, `T3`) with bounds/labels.
- Follow-up actions reference those IDs without re-scanning.

`peekaboo see` should:
- capture (optionally targeted) window/screen
- return a screenshot **file path** (default: temp directory)
- return a list of elements (text or JSON)

Snapshot lifecycle requirement:
- Host apps are long-lived, so snapshot state should be **in-memory by default**.
- Snapshot scoping: “implicit snapshot” is **per target bundle id** (reuse last snapshot for that app when snapshot id is omitted).

Practical flow (agent-friendly):
- `peekaboo list apps` / `peekaboo list windows` provide bundle-id context for targeting.
- `peekaboo see --bundle-id X` updates the implicit snapshot for `X`.
- `peekaboo click --bundle-id X --on B1` reuses the most recent snapshot for `X` when `--snapshot-id` is omitted.

## Visualizer integration
Keep visualizations in **Peekaboo.app** for now.
- Clawdbot hosts the bridge, but does not render overlays.
- Any “visualizer enabled/disabled” setting is controlled in Peekaboo.app.

## Screenshots (legacy → Peekaboo takeover)
Clawdbot should not grow a separate screenshot CLI surface.

Migration plan:
- Use `peekaboo capture …` / `peekaboo see …` (returns a file path, default temp directory).
- Once Clawdbot’ legacy screenshot plumbing is replaced, remove it cleanly (no aliases).

## Permissions behavior
If required permissions are missing:
- return `ok=false` with a short human error message (e.g., “Accessibility permission missing”)
- do not try to open System Settings from the automation endpoint

## Security (socket auth)
Both hosts must enforce:
- filesystem perms on the socket path (owner read/write only)
- server-side caller validation:
  - require the caller’s code signature TeamID to be `Y5PE65HELJ`
  - optional bundle-id allowlist for tighter scoping

Debug-only escape hatch (development convenience):
- “allow same-UID callers” means: *skip codesign checks for clients running under the same Unix user*.
- This must be **opt-in**, **DEBUG-only**, and guarded by an env var (Peekaboo uses `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`).

## Next integration steps (after this doc)
1. Add Peekaboo as a git submodule (nested submodules OK).
2. Host `PeekabooBridgeHost` inside Clawdbot.app behind a single setting (“Enable Peekaboo Bridge”, default on).
3. Ensure Clawdbot hosts the bridge at `~/Library/Application Support/clawdbot/bridge.sock` and speaks the PeekabooBridge JSON protocol.
4. Validate with `peekaboo bridge status --verbose` that Peekaboo can select Clawdbot as the fallback host (no auto-launch).
5. Keep all protocol decisions aligned with Peekaboo (coordinate system, element IDs, snapshot scoping, error envelopes).
