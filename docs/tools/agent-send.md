---
summary: "Design notes for a direct `clawdbot agent` CLI subcommand without WhatsApp delivery"
read_when:
  - Adding or modifying the agent CLI entrypoint
---
# `clawdbot agent` (direct-to-agent invocation)

`clawdbot agent` lets you talk to the **embedded** agent runtime directly (no chat send unless you opt in), while reusing the same session store and thinking/verbose persistence as inbound auto-replies.

## Behavior
- Required: `--message <text>`
- Session selection:
  - If `--session-id` is given, reuse it.
  - Else if `--to <e164>` is given, derive the session key from `session.scope` (direct chats collapse to `main`, or `global` when scope is global).
- Runs the embedded Pi agent (configured via `agent`).
- Thinking/verbose:
  - Flags `--thinking <off|minimal|low|medium|high|xhigh>` (codex models only) and `--verbose <on|off>` persist into the session store.
- Output:
  - Default: prints text (and `MEDIA:<url>` lines) to stdout.
  - `--json`: prints structured payloads + meta.
- Optional: `--deliver` sends the reply back to the selected provider (`whatsapp`, `telegram`, `discord`, `signal`, `imessage`).
