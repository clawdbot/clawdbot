---
summary: "Agent-driven desktop control on a paired macOS node via the computer tool and computer.act node command"
read_when:
  - Letting the gateway agent see and control a Mac desktop
  - Arming, permissions, or safety for computer use
  - Extending the computer.act node command or its fulfillers
title: "Computer use"
---

Computer use lets the gateway agent see and control a paired **macOS** desktop: it captures a screenshot with the existing `screen.snapshot` node command and drives the pointer and keyboard through a single dangerous node command, `computer.act`. The action set mirrors Anthropic's `computer_20251124` tool, so any vision-capable model can drive it through the built-in `computer` agent tool.

The agent emits one uniform command, `computer.act`; it cannot tell how a node fulfills it. A macOS node fulfills `computer.act` in-process with the embedded Peekaboo automation engine (correct TCC permissions, no extra process). Other platforms can fulfill the same command later without changing the agent-facing contract.

## Requirements

- A paired **macOS** node (the OpenClaw macOS app running in node mode).
- macOS app setting **Allow Computer Control** enabled (default: off).
- macOS **Accessibility** permission granted to OpenClaw (for pointer/keyboard injection) and **Screen Recording** permission (for `screen.snapshot`).
- The `computer.act` command armed on the gateway (it is dangerous and disarmed by default).
- A vision-capable agent model.

## The `computer` agent tool

The built-in `computer` tool takes one action per call. Coordinates are pixels in the most recent screenshot; the node maps them to display points.

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

1. In the macOS app, enable **Settings -> Allow Computer Control**, then grant **Accessibility** and **Screen Recording** when prompted.
2. Approve the pairing update on the gateway (a new command forces re-pairing).
3. Arm `computer.act` for a bounded window. The `phone-control` plugin exposes a `computer` group:

   ```text
   /phone arm computer 30m
   /phone status
   /phone disarm
   ```

   Arming requires `operator.admin` (or the owner) and auto-expires. Arming only toggles what the gateway may invoke; the macOS app still enforces its **Allow Computer Control** setting and Accessibility permission. Operators can equivalently add `computer.act` to `gateway.nodes.allowCommands`.

## Safety

- Nothing is autonomous: `computer.act` stays disarmed until an operator arms it, and every layer (gateway allowlist, macOS setting, Accessibility permission) must agree.
- Screenshots are model-only and never auto-sent to chat (issue [#44759](https://github.com/openclaw/openclaw/issues/44759)).
- Treat screen content as untrusted; it can carry prompt injection.

## Relationship to other desktop-control paths

This is the agent-driven path. See [Peekaboo bridge](/platforms/mac/peekaboo) for how it relates to the PeekabooBridge host, Codex Computer Use, and the direct `cua-driver` MCP.
