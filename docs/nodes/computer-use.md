---
summary: "Capability-based desktop control through the computer tool and computer.act node command"
read_when:
  - Letting the gateway agent see and control a paired desktop
  - Enablement, permissions, or safety for computer use
  - Extending the computer.act node command or its fulfillers
title: "Computer use"
---

Computer use lets the gateway agent see and control a capable paired desktop. Eligibility is capability-based: the connected node must advertise both `computer.act` and `screen.snapshot`, whose result must include a `displayFrameId`. The tool captures a screenshot as its reference frame, then drives the pointer and keyboard through `computer.act`. The action set follows the core Anthropic computer-use actions; optional `computer_20251124` zoom is not exposed. A vision-capable model drives it through the built-in `computer` agent tool.

The agent emits one uniform command, `computer.act`; it cannot tell how a node fulfills it. The bundled macOS app handles the command in-process with embedded Peekaboo services plus narrow CoreGraphics primitives (correct TCC permissions, no extra process). Windows and Linux can use the optional, experimental `cua-computer` plugin, which calls the packaged CUA Driver SDK directly. Both fulfillers use the same durable local enablement and pairing policy.

## Requirements

- A paired, connected node advertising both `computer.act` and `screen.snapshot`, with `screen.snapshot` returning `displayFrameId`.
- **macOS fulfiller:** app setting **Allow Computer Control** enabled. It defaults on; an explicit off choice stays off.
- **macOS fulfiller:** **Accessibility** and Event Posting access granted to OpenClaw (for pointer/keyboard injection), plus **Screen Recording** permission (for `screen.snapshot`).
- **Windows/Linux fulfiller:** bundled `cua-computer` plugin enabled. Its package includes the pinned CUA Driver SDK 0.14.1 runtime; no `cua-driver` executable, daemon, or MCP server is configured.
- The pairing update that includes `computer.act` approved on the gateway.
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

## Windows and Linux (experimental, via CUA Driver SDK)

The bundled `cua-computer` plugin provides an experimental fulfiller for Windows and Linux node hosts. It is disabled by default and uses the pinned CUA Driver SDK 0.14.1 contract directly:

1. Enable the plugin:

   ```bash
   openclaw plugins enable cua-computer
   ```

2. Start `openclaw node run` from the interactive desktop session. The plugin creates its configured SDK runtime lazily, then creates one OpenClaw-owned trusted session for the node-host command execution. It closes that session and shuts down the runtime when the command host stops or restarts.

3. Add `computer.act` to the Gateway allowlist. This plugin registers `computer.act` as a dangerous plugin node command, so enabling the plugin alone is not enough; the operator must opt in explicitly:

   ```json5
   {
     gateway: {
       nodes: { commands: { allow: ["computer.act"] } },
     },
   }
   ```

   Without this entry, `node.invoke` rejects `computer.act` even though the node advertises it.

This fulfiller currently controls only the primary display. `hold_key`, `left_mouse_down`, and `left_mouse_up` are unavailable because the CUA Driver SDK has no desktop-scope held-input contract. Modifier-held clicks, scrolling, and dragging are rejected because the typed desktop methods do not accept modifiers. The `key` action accepts named keys, letters, and modifier combos (for example `cmd+c` or `Return`); digit and punctuation keys are rejected because the driver drops their layout-dependent shift state, so send that text through the `type` action instead. Cancellation is passed to the SDK for each node invocation.

The plugin calls `CuaDriver.createConfigured`, never bare `create()`. Its authorization ceiling, trusted session identifier, TTLs, and desktop scope are fixed by OpenClaw; model-facing `screen.snapshot` and `computer.act` inputs cannot select a session or widen that authority. Because the driver reports no stable display identity, frame authorization binds to the trusted session generation plus live primary-display geometry. A new session invalidates outstanding frames, but a same-geometry primary-display substitution inside one session cannot be detected; prefer a stable single-display session for this fulfiller.

This is a hard replacement of the former 0.10 daemon/MCP integration. OpenClaw does not spawn a CUA process, proxy an MCP client, or fall back to another CUA runtime.

### Troubleshooting

The `cua-computer` fulfiller surfaces typed error codes in the tool result and node logs. Common ones:

| Code                                                 | Cause                                                                                                                                                         | Fix                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPUTER_DRIVER_UNAVAILABLE`                        | The CUA Driver SDK runtime cannot initialize, the node is not Windows/Linux, or its desktop permissions/session are unavailable.                              | Run `openclaw node run` inside the interactive desktop session and check the platform desktop permissions. Reinstall OpenClaw if its bundled CUA Driver SDK package is missing. |
| `COMPUTER_REFUSED_<code>`                            | The driver refused the action with a structured code such as `background_unavailable`, `background_occluded`, or `foreground_unavailable` (KDE/KWin Wayland). | Bring the target window forward, switch to X11, or use a supported compositor. See the compatibility notes above.                                                               |
| `COMPUTER_STALE_FRAME`                               | The coordinates referenced a screenshot that is no longer current (context compaction, a display geometry change, or a reference-width change).               | Take a fresh `screenshot` before the coordinate action.                                                                                                                         |
| `COMPUTER_UNSUPPORTED_ACTION`                        | An action this fulfiller cannot faithfully deliver: `hold_key`, `left_mouse_down`, `left_mouse_up`, or modifier-held click/drag/scroll.                       | Use a supported action. The typed CUA Driver desktop contract has no held-input or modifier argument for these calls.                                                           |
| `COMPUTER_UNSUPPORTED_DISPLAY`                       | A non-primary `screenIndex`, a capture/screen geometry mismatch, or a cursor outside the primary display.                                                     | Drive the primary display only.                                                                                                                                                 |
| `COMPUTER_UNSUPPORTED_KEY`                           | A `key` value the driver cannot reproduce reliably: a digit or punctuation key whose shift state is layout-dependent, or an unknown key.                      | Send that text through the `type` action instead.                                                                                                                               |
| `COMPUTER_DRIVER_ERROR` / `COMPUTER_INVALID_REQUEST` | The driver failed without a structured code, or the action arguments were malformed.                                                                          | Check the driver state and retake a screenshot; correct the action arguments.                                                                                                   |

## The `computer.act` node command

`computer.act` is the single node command the tool routes input through (`node.invoke` with `command: "computer.act"`). It is:

- **Locally enabled**: the node advertises it only while Computer Control is enabled. The gateway can approve that advertised surface once at pairing.
- **Capability-based**: the tool requires a connected node to advertise both `computer.act` and `screen.snapshot`. The bundled macOS app and the opt-in experimental `cua-computer` plugin fulfill the same command pair.

Reads reuse `screen.snapshot`; there is no second capture path. See [Camera and screen nodes](/nodes/camera) for the shared capture command.

## Authorization

1. Enable the platform fulfiller: on macOS, **Settings → Allow Computer Control** starts enabled, then grant **Accessibility** and **Screen Recording** under **Settings → Permissions**; on Windows/Linux, follow the experimental `cua-computer` setup above.
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

Once the node-local control is enabled and the pairing update is approved, `computer.act` is durably available while the node continues to advertise it. There is no lease, expiry, or arm/disarm command. Disabling Computer Control locally removes the advertised command and the node rechecks the toggle at invocation time.

On macOS, default-on means a paired gateway can drive pointer and keyboard input as soon as the required macOS grants exist. There is no per-action confirmation. Turn off **Allow Computer Control** before pairing, or at any later time, to stop advertising and accepting `computer.act`.

`gateway.nodes.commands.deny` remains an explicit global revocation and always wins. For the macOS fulfiller, `computer.act` does not need a `gateway.nodes.commands.allow` entry. The experimental `cua-computer` plugin registers `computer.act` as a dangerous plugin node command, so once that plugin is enabled the operator must add it to `gateway.nodes.commands.allow` (see the Windows/Linux setup above); the plugin registration excludes it from the default allowlist regardless of platform. An authenticated operator with `operator.write` can invoke an enabled, paired command through `node.invoke`; there is no per-action admin check.

## Safety

- Every layer (tool policy, gateway command policy, pairing, node-app setting, and platform permissions) must agree. For the current macOS fulfiller, that includes **Allow Computer Control**, Accessibility, and Screen Recording. Actions execute while those durable controls remain enabled; there is no per-action confirmation.
- The macOS fulfiller posts text one grapheme at a time, so cancellation, disconnect, pause, disable, or endpoint replacement stops it before the next grapheme. The experimental CUA Driver fulfiller passes node cancellation to the SDK for each call.
- Screenshots are model-only and never auto-sent to chat (issue [#44759](https://github.com/openclaw/openclaw/issues/44759)).
- Treat screen content as untrusted; it can carry prompt injection.

## macOS permission troubleshooting

The Computer Control status in **Settings → General → Capabilities** checks Accessibility, Event Posting, and Screen Recording separately. Screen capture can work while input remains denied because macOS stores those grants in separate TCC buckets.

If the status says **Accessibility grant may be stale**, OpenClaw may already appear enabled under **System Settings → Privacy & Security → Accessibility** even though macOS rejects it. This happens when the Accessibility entry is pinned to an older app build. Select OpenClaw in that list, remove it with **−**, then re-add `/Applications/OpenClaw.app`. Quit and reopen OpenClaw after changing the grant because macOS can cache Accessibility trust for the lifetime of the process.

## Relationship to other desktop-control paths

This is the agent-driven path. See [Peekaboo bridge](/platforms/mac/peekaboo) for how it relates to the PeekabooBridge host, Codex Computer Use, and the direct `cua-driver` MCP.
