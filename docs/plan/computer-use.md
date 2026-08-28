---
summary: Default background computer use via a two-provider seam (CUA + Peekaboo) behind one typed computer.act v2 contract, app-owned TCC, cloud-gateway/multi-node ready.
title: Computer use plan
read_when:
  - Implementing or reviewing computer.act v2, the node provider seam, or the CUA/Peekaboo adapters
  - Changing macOS embedded driver spawning, provider selection UX, or managed driver artifacts
  - Extending Peekaboo or CUA integration surfaces
---

## Status

Active campaign, started 2026-08-13. Owner-directed (steipete): build autonomously
end to end, live-test everything, ship fully. Tracker table below is the source of
truth and is updated as work lands. Derived from RFC 0025
(openclaw/rfcs `rfcs/0025-default-pluggable-computer-use.md`, RomneyDa) with the
owner rulings recorded under Decisions. Coordinate with RFC author before
each wave lands (check live PRs to avoid collisions with in-flight maintainer work).

## Problem

At campaign start, OpenClaw's computer use was foreground-only everywhere: the
macOS fulfiller drove the shared cursor via embedded Peekaboo + CGEvent primitives,
and the `cua-computer` plugin used only CUA's global desktop scope
(`scope:"desktop"`, no `delivery_mode`). Both CUA and Peekaboo already had real
background window-scoped input (no cursor move, no focus steal, no Space switch),
semantic observation (AX tree + screenshot + element refs), and structured
verification. None of that reached the model. The CUA adapter mapped 8 of the
pinned driver's 58 unique tools across its platform registries; Peekaboo's 26-tool
MCP surface (background-default clicks, `see` frame binding, `verify_state`) was
not reachable through `computer.act` at all.

## Goals

- One typed `computer.act` v2 contract (portable actions: window/element/browser
  targets, `deliveryMode: background|foreground`, verification envelope) carried
  over the existing node protocol. Cloud gateway + many paired desktop nodes works
  unchanged — provider processes live on the node.
- Two first-class macOS providers behind one adapter seam in the app-owned
  TypeScript node worker: CUA (`cua-driver serve --embedded`, app-spawned, TCC via
  responsibility chain) and Peekaboo (`peekaboo mcp` or in-process
  PeekabooAutomationKit). Settings picker; exact capability advertisement per
  provider; no per-call fallback between them.
- Windows/Linux via the same bundled plugin: CUA daemon + MCP proxy supervised by
  the node host; Windows companion PR in `openclaw/openclaw-windows-node`.
- Model guidance (skill profile) teaching the background-first ladder:
  observe window -> background element action -> background pixel -> foreground ->
  desktop, driven by structured `effect`/refusal results.
- Live-tested at every stage; UI changes ship with screenshots/video.

## Non-goals

- Raw provider MCP passthrough to the model (rejected in RFC 0025; breaks
  multi-node caching, arming, and skills).
- Reimplementing driver internals in TS/Swift.
- Recording/replay + browser-isolation parity for Peekaboo (optional capability
  families; CUA-only at first).
- Wayland-beyond-upstream, Windows elevated/UIAccess targets in v1.

## Decisions (owner rulings, 2026-08-13)

1. **No backward compatibility.** v2 replaces the v1 `computer.act` payload in
   place under the same command names. Old node + new gateway (or reverse) gets a
   typed `COMPUTER_CONTRACT_MISMATCH` rejection — a visible outcome, not silent
   degradation. No dual wire contract, no v1 preservation lane. (Supersedes RFC
   delivery rule "shipped v1 wire contract remains green".)
2. **Production LOC is a hard constraint.** The provider seam replaces the
   duplicate per-plugin command registration; the CUA plugin refactor deletes the
   desktop-scope-only branches it obsoletes; Peekaboo adapter reuses the same
   mapping core (frame binding, refusal codes, queueing) rather than forking it.
   Target: net-new production LOC bounded by deletions elsewhere; every wave
   reports its delta.
3. **Peekaboo is ours to change.** Gaps close upstream in Peekaboo
   (middle/triple click, hold/mouse-down/up, `get_cursor_position`; browser tool
   shape may align toward the v2 browser family) instead of adapter warts.
4. **Bundle CUA on macOS** (38 MB universal binary, re-signed with our Developer
   ID inside OpenClaw.app Resources — upstream's recommended embedding shape;
   avoids Gatekeeper friction). Windows/Linux use digest-pinned managed download
   per RFC OC-10A.
5. **Both providers ship together on macOS** with a Settings picker
   (CUA recommended / Peekaboo). Provider selection is node-local; switch ends the
   active execution and rotates provider generation.
6. **`invoke_menu` joins the v2 action union** (both providers support it; RFC
   omitted it). Recording + browser families are optional capability families —
   a provider without them is first-class, not degraded.

## Architecture

```text
Model ── one computer tool (typed v2 actions, capability-filtered)
  Gateway (cloud OK) ── node.invoke("computer.act") over node protocol
    Desktop node
      node-host provider seam (one registration for screen.snapshot + computer.act)
        ├─ CUA adapter ── cua-driver mcp ──socket── cua-driver serve --embedded
        │    (macOS: app-spawned, TCC responsibility chain; Win/Linux: node-host
        │     supervised, interactive session required)
        └─ Peekaboo adapter ── peekaboo mcp / PeekabooAutomationKit (macOS only)
```

Key invariants (all existing, preserved): frame/observation binding
(`displayFrameId` -> v2 `observationId`+`elementRef`, generation-scoped), dangerous
command arming, pairing approval, serialized actions, model-only screenshots,
cancellation releases held input. TCC: OpenClaw.app probes and holds
Accessibility + Screen Recording at startup; app-spawned driver children inherit
via the macOS responsibility chain — no new permission UX.

Provider capability truth (verified in source, 2026-08-14):

- CUA 0.19.3: the generated contract manifest contains 23 tools; the installed
  macOS runtime exposes 53; and the pinned Windows/Linux registries expose 54/57,
  for 58 unique runtime tool names across platforms. Background delivery is
  selected per call with typed refusals (`background_unavailable`,
  `background_occluded`, `background_uipi_blocked`,
  `off_space_or_ax_unresolved`); SkyLight per-pid posting on macOS, synthetic
  pointer injection on Windows, XTest/libei on Linux (Wayland cannot target
  background windows — capability-gated). Embedded host mode, inherited IPC
  (#2410, PR 2545) and the protected-consent adapter (#2411, PR 2578) are all
  contained in v0.13.1+ (verified via tag containment) — the pinned 0.19.3
  needs no bump.
- Peekaboo revision `a2fb1676`: 26 MCP tools; background-default clicks
  (AX-action-first, pid-routed events, window-routed pointer); `see` = screenshot +
  element map + `reference_id` (maps to observation binding); `verify_state`
  structured predicates without focus; app/window/menu/dialog/space management;
  CDP browser tool into user Chrome with explicit connect consent. Missing vs v2:
  middle/triple click, held input, cursor position, recording.

## Status update 2026-08-25/26

- **CUA live vertical PASSED on production** (2026-08-25): headless node host on
  steipete-studio-sf (current-main build, bundled cua-driver v0.22.1, TCC via the
  Aqua terminal chain) registered on the production clawstudio Gateway as
  `prov=cua-computer` with `computer.act`; `list_windows` (300 windows),
  `get_window_state` (AXTextArea projected with elementRef + value), then a
  background `type` into a non-frontmost TextEdit returned `effect=confirmed`
  `route=accessibility` with `value_readback`; re-observation showed the typed
  text and TextEdit was never frontmost. Raw `nodes invoke` requires an
  `executionId` the agent tool normally supplies.
- **macOS node-channel silent failure fixed** (#129925, af9b0c7): a node-host
  worker that exits at startup no longer silently kills the node channel forever
  (startup exits now consume the retry budget and latch; the channel dials
  without the worker surface; node-channel state + failure reason render in the
  menu). Root cause was captured from live os_log: the managed node CLI refused
  the machine's newer state-DB schema and the app respawned it invisibly every
  ~14s.
- **Managed node-CLI schema drift repaired fleet-wide** (2026-08-26): dev-main
  apps migrate shared state DBs past every npm-published CLI (schema 10 vs 8),
  so the managed `openclaw-mac-node` channel on all five Macs was rebuilt from
  current main (`pnpm pack` for workspace-dep rewrite -> `npm install -g
--prefix releases/<sha>` -> version stamp -> atomic `current` flip). Follow-ups
  open: roll the fixed app build to the fleet; webview auth=none with stale
  cached webchat; gateway rows reporting connected with no live socket.

## Workstreams and tracker

Waves follow RFC 0025's implementation plan, compressed by the no-compat ruling.
Status: `todo | in-progress | pr | partial | landed | blocked`.

| ID         | Work                                                                                                                                                                                | Repo                  | Status  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0-FIX     | Parity matrix + pinned fixtures: CUA 23-tool contract manifest / 58 unique runtime tools + 26 Peekaboo tools classified against the v2 union; recorded tools/list + result fixtures | openclaw              | landed  | landed #123469 (d9646ad): 58 CUA + 26 Peekaboo tools, +1059 test-only LOC                                                                                                                                                                                                                                                                                                                                                               |
| W0-PIN     | Pick + pin CUA release with embedded/inherited-IPC support; dependency bump (needs Dependency Guard approval)                                                                       | openclaw              | landed  | resolved: 0.19.3 already contains #2410+#2411                                                                                                                                                                                                                                                                                                                                                                                           |
| W1-PROTO   | v2 types: action union (+`invoke_menu`), target union, capability descriptor, result envelope, closed error codes; **replaces** v1 params in place                                  | openclaw              | landed  | landed #123544 (d19c755)                                                                                                                                                                                                                                                                                                                                                                                                                |
| W1-TOOL    | Built-in computer tool v2: capability-filtered schema, observation refs, result projection, no auto-retry                                                                           | openclaw              | landed  | landed #123544: v1 651 / v2 742 tokens                                                                                                                                                                                                                                                                                                                                                                                                  |
| W1-SEAM    | Node-host provider seam: one registration, provider selection, generation, lifecycle close path; absorbs cua-computer's direct registration                                         | openclaw              | landed  | landed #123509 (848a7e3): seam+contract, prod +348/-217                                                                                                                                                                                                                                                                                                                                                                                 |
| W2-CUA     | CUA plugin refactor onto seam: full v2 mapping (window/element/background), session-per-execution, deletes desktop-scope-only adapter                                               | openclaw              | landed  | landed #123604 (2af5eca): full v2 adapter, prod +1129/-41                                                                                                                                                                                                                                                                                                                                                                               |
| W2-MAC     | macOS app: bundle + re-sign driver, direct `serve --embedded` spawn, private socket handoff to worker, TCC restart handling                                                         | openclaw              | landed  | landed #123635 (19ace68): app-owned daemon + picker + orphan reaping, live-proven                                                                                                                                                                                                                                                                                                                                                       |
| W2-PKB     | Peekaboo adapter on the same seam (macOS): see/click/type/press/set_value/verify_state/app/window/menu mapping                                                                      | openclaw              | landed  | landed #123801 (4a6edc0): native v2; live vertical completed by W3-GATE                                                                                                                                                                                                                                                                                                                                                                 |
| W2-PKB-UP  | Peekaboo upstream: middle/triple click, hold_key + mouse down/up in BackgroundInputDriver, get_cursor_position; optional browser-shape alignment                                    | Peekaboo              | pr      | Peekaboo#485 draft: middle/triple click, held input, cursor position                                                                                                                                                                                                                                                                                                                                                                    |
| W2-UX      | Settings -> Computer Use provider picker + readiness checklist (both apps: macOS now, Tauri Linux later)                                                                            | openclaw              | landed  | landed #124093 (a4f61d1): readiness checklist + screenshots                                                                                                                                                                                                                                                                                                                                                                             |
| W3-GATE    | Integration gate: live vertical on macOS (both providers): observe window -> background element click/type -> verify                                                                | openclaw              | landed  | live agent-tool -> Gateway -> Mac-node proof: both providers kept frontmost app/cursor unchanged and changed target content; CUA confirmed type readback, Peekaboo confirmed `set_value` after honest unverifiable click/type evidence. **Clean-room status unverified** — no headless path to `operator.write` existed when #123991 ran, so it likely used a UI approval or machine-local prior approvals; re-verify once W3-RIG lands |
| W3-RIG     | Headless live rig: `nodes`/`approve`/`proof` must complete without a UI approval                                                                                                    | openclaw              | pr      | root cause: the rig CLI device is pinned to whichever scope set its **first** contact requested — `src/cli/nodes-cli/rpc.ts` asks `["operator.read","n"]`, the proof runner asks `operator.write`, and a device may never approve its own upgrade; proven symmetric (either order deadlocks the other). Fix owned outside this campaign                                                                                                 |
| W3-LINUX   | Live Linux X11 vertical for the CUA provider                                                                                                                                        | openclaw              | partial | repairs landed #124128 (abf0ef6); vertical blocked on GTK3 editable-role mapping                                                                                                                                                                                                                                                                                                                                                        |
| W3-SKILL   | Version-pinned skill profile: background-first ladder, result precedence, no CLI/daemon instructions                                                                                | openclaw              | landed  | landed #123949 (d674907): capability-filtered ladder guidance                                                                                                                                                                                                                                                                                                                                                                           |
| W4-BROWSER | CUA browser family (isolated profile first; existing-profile gated on consent adapter)                                                                                              | openclaw              | landed  | landed #123960 (aa7a2fb): nine actions, isolated profiles only                                                                                                                                                                                                                                                                                                                                                                          |
| W4-REC     | CUA recording/resources family with node-owned roots                                                                                                                                | openclaw              | landed  | landed #124035 (079bb34): host-owned resource handles                                                                                                                                                                                                                                                                                                                                                                                   |
| W4-ART     | Managed artifacts: Win/Linux digest-pinned download, atomic update + rollback                                                                                                       | openclaw              | landed  | landed #123986 (a32a7ae): verification+doctor; no downloader needed                                                                                                                                                                                                                                                                                                                                                                     |
| W4-WIN     | Windows companion CUA host PR                                                                                                                                                       | openclaw-windows-node | todo    | RFC WIN-1; after W1-SEAM/W2-CUA                                                                                                                                                                                                                                                                                                                                                                                                         |
| W5-SEC     | Security closure: high-risk action classification, socket ownership audit, hostile-arg tests                                                                                        | openclaw              | landed  | landed #124112 (af99d1a): fixed arbitrary launch_app hole                                                                                                                                                                                                                                                                                                                                                                               |
| W5-TRUST   | Write down the trust model: Gateway as authorization chokepoint, driver as effector, and the honest limits of the socket boundary                                                   | openclaw              | landed  | landed #124355 (289a9ca): states why the daemon runs unrestricted, what the 0600-socket-in-0700-dir does and does not protect (same-user processes are inside the boundary), and that loopback confers no trust                                                                                                                                                                                                                         |
| W5-HYG     | Split the built-in computer tool by responsibility; retire its grandfathered `max-lines` suppression                                                                                | openclaw              | landed  | landed #124358 (c348815): 1,542 lines -> 243-line orchestrator + schema/request/result/node/guidance/shared-leaf modules; suppression and its baseline entry both deleted, 0 madge cycles                                                                                                                                                                                                                                               |
| W5-REF     | Converge both providers' opaque-ref lifecycles on the contract, with a shared case fixture so drift fails CI                                                                        | openclaw              | landed  | landed #124374 (62deb87): native refs key on stable window identity (windowID + processIdentity) and refresh in place; 8-case shared fixture drives production code on both providers; prod +15                                                                                                                                                                                                                                         |
| W5-ACC     | Packaged cross-platform acceptance + default-provider rollout                                                                                                                       | openclaw              | todo    | RFC OC-11/12                                                                                                                                                                                                                                                                                                                                                                                                                            |

Production LOC ledger (updated per landed PR): net target ≤ +1500 for the whole
campaign excluding tests/fixtures, funded by deleting the v1-only branches, the
duplicate registration path, and the eight-tool adapter.

## Live testing matrix

Every wave carries live proof; unit fixtures alone never advance the tracker.

- **macOS both providers**: dev gateway (isolated `OPENCLAW_STATE_DIR`, own port)
  - signed local OpenClaw.app build on one of the owner's Macs. Scenario:
    background-click + type into a non-frontmost TextEdit window while frontmost app
    keeps focus; assert frontmost app unchanged, cursor position unchanged,
    `verify_state`/`effect` confirms the edit. Video via screen recording for
    UX-visible changes.
  - W3-GATE executed on 2026-08-14 through the real agent tool and paired-node
    route. Peekaboo preserved Finder as frontmost and its cursor position. CUA
    preserved VLC and its cursor position. Both changed the background target.
    CUA returned confirmed accessibility value readback; Peekaboo honestly marked
    click/type delivery unverifiable and confirmed the follow-up background
    `set_value` with verified change evidence.
- **Linux CUA**: Crabbox Xvfb host (recipe proven in PR #117205): node registers
  command pair, real screenshot + frame id, background window action against
  xterm/gtk test app; Wayland smoke on Sway only.
- **Windows**: openclaw-windows-node companion on a Windows box/VM
  (Parallels lab); Session 0 rejection probe over SSH.
- **Multi-node**: two paired Macs + cloud gateway; explicit `node` selection,
  frame tokens do not cross nodes, provider generation rotates on app restart.
- **Skew probe** (no-compat ruling): old app + new gateway must produce the typed
  contract-mismatch error in the tool result, not silence.

## Risks

- CUA prerelease churn: everything pins to one accepted release + fixtures;
  version skew refuses closed.
- v2 union token cost: measured in W1-TOOL; split into tool family only if a
  provider cannot consume one discriminated union reliably.
- Private-socket embedding: owner-only dir, 0600, ownership validated, pre-existing
  path rejected; upgrade to inherited IPC when the pinned release supports it.
- Dependency Guard approvals (CUA bump, new Peekaboo dep surface) interrupt
  autonomy; batch them per wave.
- Collision with RFC author's in-flight work: check live PRs before each wave.
