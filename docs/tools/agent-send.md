---
summary: "Run agent turns from the CLI and optionally deliver replies to channels"
read_when:
  - You want to trigger agent runs from scripts or the command line
  - You need to deliver agent replies to a chat channel programmatically
title: "Agent send"
---

`openclaw agent` runs a single agent turn from the command line without needing
an inbound chat message. Use it for scripted workflows, testing, and
programmatic delivery.

## Quick start

<Steps>
  <Step title="Run a simple agent turn">
    ```bash
    openclaw agent --message "What is the weather today?"
    ```

    This sends the message through the Gateway and prints the reply.

  </Step>

  <Step title="Target a specific agent or session">
    ```bash
    # Target a specific agent
    openclaw agent --agent ops --message "Summarize logs"

    # Target a phone number (derives session key)
    openclaw agent --to +15555550123 --message "Status update"

    # Reuse an existing session
    openclaw agent --session-id abc123 --message "Continue the task"
    ```

  </Step>

  <Step title="Deliver the reply to a channel">
    ```bash
    # Deliver to WhatsApp (default channel)
    openclaw agent --to +15555550123 --message "Report ready" --deliver

    # Deliver to Slack
    openclaw agent --agent ops --message "Generate report" \
      --deliver --reply-channel slack --reply-to "#reports"
    ```

  </Step>
</Steps>

## Flags

| Flag                          | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `--message \<text\>`          | Message to send (required)                                  |
| `--to \<dest\>`               | Derive session key from a target (phone, chat id)           |
| `--agent \<id\>`              | Target a configured agent (uses its `main` session)         |
| `--session-id \<id\>`         | Reuse an existing session by id                             |
| `--local`                     | Force local embedded runtime (skip Gateway)                 |
| `--deliver`                   | Send the reply to a chat channel                            |
| `--channel \<name\>`          | Delivery channel (whatsapp, telegram, discord, slack, etc.) |
| `--reply-to \<target\>`       | Delivery target override                                    |
| `--reply-channel \<name\>`    | Delivery channel override                                   |
| `--reply-account \<id\>`      | Delivery account id override                                |
| `--thinking \<level\>`        | Set thinking level for the selected model profile           |
| `--verbose \<on\|full\|off\>` | Set verbose level                                           |
| `--timeout \<seconds\>`       | Override agent timeout                                      |
| `--json`                      | Output structured JSON                                      |

## Behavior

- By default, the CLI goes **through the Gateway**. Add `--local` to force the
  embedded runtime on the current machine.
- If the Gateway is unreachable, the CLI **falls back** to the local embedded run.
- Session selection: `--to` derives the session key (group/channel targets
  preserve isolation; direct chats collapse to `main`).
- Thinking and verbose flags persist into the session store.
- Output: plain text by default, or `--json` for structured payload + metadata.

## Examples

```bash
# Simple turn with JSON output
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json

# Turn with thinking level
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium

# Deliver to a different channel than the session
openclaw agent --agent ops --message "Alert" --deliver --reply-channel telegram --reply-to "@admin"
```

## Related

- [Agent CLI reference](/cli/agent)
- [Sub-agents](/tools/subagents) — background sub-agent spawning
- [Sessions](/concepts/session) — how session keys work
