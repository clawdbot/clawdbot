---
summary: "How the mac app embeds the gateway WebChat and how to debug it"
read_when:
  - Debugging mac WebChat view or loopback port
title: "WebChat (macOS)"
---

The macOS menu bar app embeds the WebChat UI as a native SwiftUI view. It
connects to the Gateway and defaults to the **main session** for the selected
agent (with a session switcher for other sessions).

- **Local mode**: connects directly to the local Gateway WebSocket.
- **Remote mode**: forwards the Gateway control port over SSH and uses that
  tunnel as the data plane.

## Launch & debugging

- Manual: Lobster menu → “Open Chat”.
- Auto‑open for testing:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (subsystem `ai.openclaw`, category `WebChatSwiftUI`).

## How it is wired

- Data plane: Gateway WS methods `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` and events `chat`, `agent`, `presence`, `tick`, `health`.
- `chat.history` returns display-normalized transcript rows: inline directive
  tags are stripped from visible text, plain-text tool-call XML payloads
  (including `<tool_call>...</tool_call>`,
  `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`,
  `<function_calls>...</function_calls>`, and truncated tool-call blocks) and
  leaked ASCII/full-width model control tokens are stripped, pure
  silent-token assistant rows such as exact `NO_REPLY` / `no_reply` are
  omitted, and oversized rows can be replaced with placeholders.
- Session: defaults to the primary session (`main`, or `global` when scope is
  global). The UI can switch between sessions.
- Onboarding uses a dedicated session to keep first‑run setup separate.

## Security surface

- Remote mode forwards only the Gateway WebSocket control port over SSH.

## Known limitations

- The UI is optimized for chat sessions (not a full browser sandbox).
