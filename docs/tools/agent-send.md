---
summary: "Direct `moltbot agent` CLI runs (with optional delivery)"
read_when:
  - Adding or modifying the agent CLI entrypoint
---
# `moltbot agent` (direct agent runs)

`moltbot agent` runs a single agent turn without needing an inbound chat message.
By default it goes **through the Gateway**; add `--local` to force the embedded
runtime on the current machine.

## Behavior

- Required: `--message <text>`
- Session selection:
  - `--to <dest>` derives the session key (group/channel targets preserve isolation; direct chats collapse to `main`), **or**
  - `--session-id <id>` reuses an existing session by id, **or**
  - `--agent <id>` targets a configured agent directly (uses that agent's `main` session key)
- Runs the same embedded agent runtime as normal inbound replies.
- Thinking/verbose flags persist into the session store.
- Output:
  - default: prints reply text (plus `MEDIA:<url>` lines)
  - `--json`: prints structured payload + metadata
- Optional delivery back to a channel with `--deliver` + `--channel` (target formats match `moltbot message --target`).
- Use `--reply-channel`/`--reply-to`/`--reply-account` to override delivery without changing the session.

If the Gateway is unreachable, the CLI **falls back** to the embedded local run.

## Examples

```bash
moltbot agent --to +15555550123 --message "status update"
moltbot agent --agent ops --message "Summarize logs"
moltbot agent --session-id 1234 --message "Summarize inbox" --thinking medium
moltbot agent --to +15555550123 --message "Trace logs" --verbose on --json
moltbot agent --to +15555550123 --message "Summon reply" --deliver
moltbot agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flags

- `--local`: run locally (requires model provider API keys in your shell)
- `--deliver`: send the reply to the chosen channel
- `--channel`: delivery channel (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, default: `whatsapp`)
- `--reply-to`: delivery target override
- `--reply-channel`: delivery channel override
- `--reply-account`: delivery account id override
- `--thinking <off|minimal|low|medium|high|xhigh>`: persist thinking level (GPT-5.2 + Codex models only)
- `--verbose <on|full|off>`: persist verbose level
- `--timeout <seconds>`: override agent timeout
- `--json`: output structured JSON
