---
summary: "Agent-driven desktop control on a paired macOS node via the computer tool and computer.act node command"
read_when:
  - Letting the gateway agent see and control a Mac desktop
  - Arming, permissions, or safety for computer use
  - Extending the computer.act node command or its fulfillers
title: "Computer use"
---

Computer use lets the gateway agent see and control a paired **macOS** desktop: it captures a screenshot with the existing `screen.snapshot` node command and drives the pointer and keyboard through a single dangerous node command, `computer.act`. The action set follows the core Anthropic computer-use actions; optional `computer_20251124` zoom is not exposed. A vision-capable model drives it through the built-in `computer` agent tool.

The agent emits one uniform command, `computer.act`; it cannot tell how a node fulfills it. A macOS node fulfills `computer.act` in-process with the embedded Peekaboo automation engine (correct TCC permissions, no extra process). Other platforms can fulfill the same command later without changing the agent-facing contract.

## Requirements

- A paired **macOS** node (the OpenClaw macOS app running in node mode).
- macOS app setting **Allow Computer Control** enabled (default: off).
- macOS **Accessibility** permission granted to OpenClaw (for pointer/keyboard injection) and **Screen Recording** permission (for `screen.snapshot`).
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

## The `computer.act` node command

`computer.act` is the single node command the tool routes input through (`node.invoke` with `command: "computer.act"`). It is:

- **Dangerous by default**: listed in the built-in dangerous node commands and excluded from the runtime allowlist until explicitly armed. A macOS node may still declare it at pairing so the surface is approved once.
- **macOS-only** today: only advertised by a macOS node that has **Allow Computer Control** enabled.

Reads reuse `screen.snapshot`; there is no second capture path. See [Camera and screen nodes](/nodes/camera) for the shared capture command.

## Enable and arm

1. In the macOS app, enable **Settings → Allow Computer Control**. Then open **Settings → Permissions** and grant **Accessibility** and **Screen Recording** in macOS System Settings.
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

   Arming requires `operator.admin` (or the owner) and auto-expires. The legacy `/phone arm all` group intentionally excludes desktop control; use the explicit `computer` group. Arming only toggles what the gateway may invoke; the macOS app still enforces its **Allow Computer Control** setting and OS permissions.

For persistent authorization, add `computer.act` to `gateway.nodes.allowCommands` **and remove it from** `gateway.nodes.denyCommands`; the deny list wins. Persistent authorization does not auto-expire. Entries already present before `/phone arm` remain after `/phone disarm`; do not convert a temporary grant to persistent while it is armed.

## Safety

- Before authorization, every layer (tool policy, gateway command policy, macOS setting, Accessibility, and Screen Recording) must agree. Once armed, actions execute without a per-action confirmation until expiry or `/phone disarm`.
- Screenshots are model-only and never auto-sent to chat (issue [#44759](https://github.com/openclaw/openclaw/issues/44759)).
- Treat screen content as untrusted; it can carry prompt injection.

## Relationship to other desktop-control paths

This is the agent-driven path. See [Peekaboo bridge](/platforms/mac/peekaboo) for how it relates to the PeekabooBridge host, Codex Computer Use, and the direct `cua-driver` MCP.
