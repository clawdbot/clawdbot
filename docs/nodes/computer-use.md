---
summary: "Capability-based desktop control through the computer tool and computer.act node command"
read_when:
  - Letting the gateway agent see and control a paired desktop
  - Arming, permissions, or safety for computer use
  - Extending the computer.act node command or its fulfillers
title: "Computer use"
---

Computer use lets the gateway agent see and control a capable paired desktop. Eligibility is capability-based: the connected node must advertise both `computer.act` and `screen.snapshot`, whose result must include a `displayFrameId`. The tool captures a screenshot as its reference frame, then drives the pointer and keyboard through the dangerous `computer.act` command. The action set follows the core Anthropic computer-use actions; optional `computer_20251124` zoom is not exposed. A vision-capable model drives it through the built-in `computer` agent tool.

The agent emits one uniform command, `computer.act`; it cannot tell how a node fulfills it. The bundled macOS app handles the command in-process with embedded Peekaboo services plus narrow CoreGraphics primitives (correct TCC permissions, no extra process). Windows and Linux can use the optional, experimental `cua-computer` plugin with a separately installed `cua-driver` binary. Both fulfillers use the same pairing and arming policy.

## Requirements

- A paired, connected node advertising both `computer.act` and `screen.snapshot`, with `screen.snapshot` returning `displayFrameId`.
- **macOS fulfiller:** app setting **Allow Computer Control** enabled (default: off).
- **macOS fulfiller:** **Accessibility** permission granted to OpenClaw (for pointer/keyboard injection) and **Screen Recording** permission (for `screen.snapshot`).
- **Windows/Linux fulfiller:** bundled `cua-computer` plugin enabled and a compatible `cua-driver` 0.10.x executable installed.
- The `computer.act` command armed on the gateway (it is dangerous and disarmed by default).
- A vision-capable agent model.
- Tool policy that exposes `computer`. The default `coding` profile does not. Add `computer` to `tools.alsoAllow`; sandboxed agents also need it in `tools.sandbox.tools.alsoAllow`.

## The `computer` agent tool

The built-in `computer` tool takes one action per call. Coordinates are non-negative integer pixels in the most recent screenshot; the node maps them to display points. Coordinate actions must echo the screenshot result's `frameId`, and an explicit `screenIndex` must match that frame. OpenClaw also carries a node-issued display identity from the screenshot into the action, so a display reconnect or geometry change fails closed instead of silently retargeting the same index. These checks reject guessed tokens and tokens from another delivered frame or display. A token is not a freshness guarantee: apps can change pixels on the same display after capture, so take a new screenshot whenever the scene may have changed.

- Reads: `screenshot`.
- Pointer: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag` (with `startCoordinate`), `left_mouse_down`, `left_mouse_up`.
- Scroll: `scroll` with `scrollDirection` (`up|down|left|right`) and `scrollAmount` (wheel ticks).
- Keyboard: `type` (text), `key` (combo such as `cmd+shift+t` or `Return`), `hold_key` (`text` combo held for `duration` seconds).
- Pacing: `wait` (`duration` seconds).

Modifier keys ride the `text` field on click and scroll actions (`shift`, `ctrl`, `alt`, `cmd`). After an input action the tool returns a fresh screenshot so the model can observe the result. If more than one computer-capable node is connected, pass `node` explicitly.

Screenshots are kept **model-only**: they are never auto-delivered to the chat channel. Treat all on-screen content as untrusted input; the tool warns the model not to follow on-screen instructions that conflict with the user's request.

## Windows and Linux (experimental, via cua-driver)

The bundled `cua-computer` plugin provides an experimental fulfiller for Windows and Linux node hosts. It is disabled by default and requires the prerelease 0.10.x driver contract:

1. Install a `cua-driver` 0.10.x binary from the [upstream releases](https://github.com/trycua/cua/releases) and make it available on `PATH`. To use another executable location, set `plugins.entries.cua-computer.config.driverPath`.
2. Enable the plugin:

   ```bash
   openclaw plugins enable cua-computer
   ```

3. Start `openclaw node run` from the interactive desktop session. The plugin starts the local driver daemon lazily when the first capture or action arrives.

This fulfiller currently controls only the primary display. X11/XWayland is the first-line Linux path. Native Wayland remains an upstream opt-in: set `CUA_DRIVER_RS_ENABLE_WAYLAND` yourself before starting the node; OpenClaw never sets it automatically. KDE/KWin is unsupported by the upstream native-Wayland input path. `hold_key`, `left_mouse_down`, and `left_mouse_up` are unavailable because cua-driver 0.10.x has no cross-platform desktop-scope hold contract. Modifier-held scrolling and dragging are unavailable on both platforms, and modifier-held clicks are unavailable on Linux. The `key` action accepts named keys, letters, and modifier combos (for example `cmd+c` or `Return`); digit and punctuation keys are rejected because the driver drops their layout-dependent shift state, so send that text through the `type` action instead. Text typing cannot be cancelled partway through a `type_text` driver call.

Because cua-driver reports no stable display identity, frame authorization binds to the driver connection plus the live primary-display geometry. A daemon or session reconnect invalidates outstanding frames, but a same-geometry primary-display substitution that keeps the connection open cannot be detected; prefer a stable single-display session for this fulfiller.

OpenClaw disables cua-driver telemetry and update checks for the `mcp` and `serve` processes it manages. It does not download or update the driver binary.

### Troubleshooting

The `cua-computer` fulfiller surfaces typed error codes in the tool result and node logs. Common ones:

| Code                                                 | Cause                                                                                                                                                           | Fix                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMPUTER_DRIVER_UNAVAILABLE`                        | The `cua-driver` binary is not on `PATH` (or `driverPath` is wrong), the daemon did not become ready in time, or the node is not Windows/Linux.                 | Install `cua-driver` 0.10.x on `PATH` or set `driverPath`. Run `openclaw node run` inside the interactive desktop session; on Linux ensure an X11 `DISPLAY` (or a `WAYLAND_DISPLAY` with `CUA_DRIVER_RS_ENABLE_WAYLAND`) is present. |
| `COMPUTER_DRIVER_UNSUPPORTED`                        | The connected driver is not `cua-driver` 0.10.x, or its capability/schema version differs.                                                                      | Install a supported 0.10.x build. The plugin re-probes about 30 seconds after you correct it, so no node restart is needed.                                                                                                          |
| `COMPUTER_REFUSED_<code>`                            | The driver refused the action with a structured code such as `background_unavailable`, `background_occluded`, or `foreground_unavailable` (KDE/KWin Wayland).   | Bring the target window forward, switch to X11, or use a supported compositor. See the compatibility notes above.                                                                                                                    |
| `COMPUTER_STALE_FRAME`                               | The coordinates referenced a screenshot that is no longer current (context compaction, a display geometry change, or a reference-width change).                 | Take a fresh `screenshot` before the coordinate action.                                                                                                                                                                              |
| `COMPUTER_UNSUPPORTED_ACTION`                        | An action this fulfiller cannot faithfully deliver: `hold_key`, `left_mouse_down`, `left_mouse_up`, modifier-held drag/scroll, or modifier-held click on Linux. | Use a supported action. cua-driver 0.10.x has no desktop-scope held-input contract.                                                                                                                                                  |
| `COMPUTER_UNSUPPORTED_DISPLAY`                       | A non-primary `screenIndex`, a capture/screen geometry mismatch, or a cursor outside the primary display.                                                       | Drive the primary display only.                                                                                                                                                                                                      |
| `COMPUTER_UNSUPPORTED_KEY`                           | A `key` value the driver cannot reproduce reliably: a digit or punctuation key whose shift state is layout-dependent, or an unknown key.                        | Send that text through the `type` action instead.                                                                                                                                                                                    |
| `COMPUTER_DRIVER_ERROR` / `COMPUTER_INVALID_REQUEST` | The driver failed without a structured code, or the action arguments were malformed.                                                                            | Check the driver state and retake a screenshot; correct the action arguments.                                                                                                                                                        |

## The `computer.act` node command

`computer.act` is the single node command the tool routes input through (`node.invoke` with `command: "computer.act"`). It is:

- **Dangerous by default**: listed in the built-in dangerous node commands and excluded from the runtime allowlist until explicitly armed. macOS, Windows, and Linux desktop nodes may still declare it at pairing so the surface is approved once.
- **Capability-based**: the tool requires a connected node to advertise both `computer.act` and `screen.snapshot`. The bundled macOS app and the opt-in experimental `cua-computer` plugin fulfill the same command pair.

Reads reuse `screen.snapshot`; there is no second capture path. See [Camera and screen nodes](/nodes/camera) for the shared capture command.

## Enable and arm

1. Enable the platform fulfiller: on macOS, enable **Settings → Allow Computer Control**, then grant **Accessibility** and **Screen Recording** under **Settings → Permissions**; on Windows/Linux, follow the experimental `cua-computer` setup above.
2. Approve the pairing update on the gateway (a new command forces re-pairing).
3. Expose the tool to the vision-capable agent. For the default `coding` profile:

   ```json5
   {
     tools: {
       alsoAllow: ["computer"],
       // Sandboxed agents need this second gate too:
       sandbox: { tools: { alsoAllow: ["computer"] } },
     },
   }
   ```

4. Arm `computer.act` for a bounded window. The `phone-control` plugin exposes a `computer` group:

   ```text
   /phone arm computer 30m
   /phone status
   /phone disarm
   ```

   Arming requires `operator.admin` (or the owner) and auto-expires. The legacy `/phone arm all` group intentionally excludes desktop control; use the explicit `computer` group. Arming only toggles what the gateway may invoke; the node app still enforces its platform-specific settings and OS permissions, including **Allow Computer Control**, Accessibility, and Screen Recording on macOS.

For persistent authorization, add `computer.act` to `gateway.nodes.commands.allow` **and remove it from** `gateway.nodes.commands.deny`; the deny list wins. Persistent authorization does not auto-expire. Entries already present before `/phone arm` remain after `/phone disarm`; do not convert a temporary grant to persistent while it is armed.

Authorization is deliberately split between enabling and use. Arming or
persistently configuring `computer.act` requires administrative authority.
Once armed, an authenticated operator with `operator.write` can invoke
`computer.act` through `node.invoke` until the grant expires or is disarmed;
there is no per-action admin check. Approving a node that declares
`computer.act` only records the surface so it can be armed later and does not
enable invocation by itself.

## Safety

- Before authorization, every layer (tool policy, gateway command policy, node-app setting, and platform permissions) must agree. For the current macOS fulfiller, that includes **Allow Computer Control**, Accessibility, and Screen Recording. Once armed, actions execute without a per-action confirmation until expiry or `/phone disarm`.
- The macOS fulfiller posts text one grapheme at a time, so cancellation, disconnect, pause, disable, or endpoint replacement stops it before the next grapheme. The experimental cua-driver fulfiller cannot cancel a `type_text` call mid-typing.
- Screenshots are model-only and never auto-sent to chat (issue [#44759](https://github.com/openclaw/openclaw/issues/44759)).
- Treat screen content as untrusted; it can carry prompt injection.

## Relationship to other desktop-control paths

This is the agent-driven path. See [Peekaboo bridge](/platforms/mac/peekaboo) for how it relates to the PeekabooBridge host, Codex Computer Use, and the direct `cua-driver` MCP.
