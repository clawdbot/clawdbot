---
summary: "Run agent turns from the CLI and optionally deliver replies to channels"
read_when:
  - You want to trigger agent runs from scripts or the command line
  - You need to deliver agent replies to a chat channel programmatically
title: "Agent send"
---

`openclaw agent` runs a single agent turn from the command line without an
inbound chat message. Use it for scripted workflows, testing, and
programmatic delivery. Full flag and behavior reference:
[Agent CLI reference](/cli/agent).

## Quick start

<Steps>
  <Step title="Run a simple agent turn">
    ```bash
    openclaw agent --agent main --message "What is the weather today?"
    ```

    Sends the message through the Gateway and prints the reply.

  </Step>

  <Step title="Send a multiline prompt from a file">
    ```bash
    openclaw agent --agent ops --message-file ./task.md
    ```

    Reads a valid UTF-8 file as the agent message body.

  </Step>

  <Step title="Target a specific agent or session">
    ```bash
    # Target a specific agent
    openclaw agent --agent ops --message "Summarize logs"

    # Target a phone number (derives session key)
    openclaw agent --to +15555550123 --message "Status update"

    # Reuse an existing session
    openclaw agent --session-id abc123 --message "Continue the task"

    # Target an exact session key
    openclaw agent --session-key agent:ops:incident-42 --message "Summarize status"
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

| Flag                        | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `--message <text>`          | Inline message to send                                               |
| `--message-file <path>`     | Read the message from a valid UTF-8 file (max 4 MiB)                 |
| `--to <dest>`               | Derive session key from a target (phone, chat id)                    |
| `--session-key <key>`       | Use an explicit session key                                          |
| `--agent <id>`              | Target a configured agent (uses its `main` session)                  |
| `--session-id <id>`         | Reuse an existing session by id                                      |
| `--model <id>`              | Model override for this run (`provider/model` or model id)           |
| `--local`                   | Force local embedded runtime (skip Gateway)                          |
| `--deliver`                 | Send the reply to a chat channel                                     |
| `--channel <name>`          | Delivery channel; with `--agent` + `--to`, also applies DM scope     |
| `--reply-to <target>`       | Delivery target override                                             |
| `--reply-channel <name>`    | Delivery channel override                                            |
| `--reply-account <id>`      | Delivery account id override                                         |
| `--thinking <level>`        | Set thinking level for the selected model profile                    |
| `--verbose <on\|full\|off>` | Persist verbose level for the session (`full` also logs tool output) |
| `--timeout <seconds>`       | Override agent timeout (default 600, or config value)                |
| `--json`                    | Output structured JSON                                               |

## Behavior

- By default, the CLI goes **through the Gateway**. Add `--local` to force the
  embedded runtime on the current machine.
- Pass exactly one of `--message` or `--message-file`. File messages preserve
  multiline content after removing an optional UTF-8 BOM. Files larger than
  4 MiB are rejected before dispatch.
- If the Gateway request fails, the CLI **falls back** to the local embedded
  run; a Gateway timeout falls back with a fresh session instead of racing the
  original transcript.
- Session selection: `--to` derives the session key (group/channel targets
  preserve isolation; direct chats collapse to `main`). With `--agent`,
  `--channel`, and `--to` together, routing follows the channel's canonical
  recipient and `session.dmScope`. Stable outbound-only identities use a
  provider-owned session isolated from the agent's main session.
- `--session-key` selects an explicit key. Agent-prefixed keys must use
  `agent:<agent-id>:<session-key>`, and `--agent` must match that agent id when
  both are supplied. Bare non-sentinel keys are scoped to `--agent` when
  supplied; for example, `--agent ops --session-key incident-42` routes to
  `agent:ops:incident-42`. Without `--agent`, bare non-sentinel keys are scoped
  to the configured default agent. Literal `global` and `unknown` remain
  unscoped only when no `--agent` is supplied; the embedded fallback path
  resolves those sentinel sessions to the configured default agent.
- `--reply-channel` and `--reply-account` affect delivery only.
- Thinking and verbose flags persist into the session store.
- Output: plain text by default, or `--json` for structured payload + metadata.
- With `--json --deliver`, the JSON includes delivery status for sent,
  suppressed, partial, and failed sends. See
  [JSON delivery status](/cli/agent#json-delivery-status).

## Examples

```bash
# Simple turn with JSON output
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json

# Turn with a model override
openclaw agent --agent ops --model openai/gpt-5.4 --message "Summarize logs"

# Turn with thinking level
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium

# Multiline prompt from a file
openclaw agent --agent ops --message-file ./task.md

# Exact session key
openclaw agent --session-key agent:ops:incident-42 --message "Summarize status"

# Legacy key scoped to an agent
openclaw agent --agent ops --session-key incident-42 --message "Summarize status"

# Deliver to a different channel than the session
openclaw agent --agent ops --message "Alert" --deliver --reply-channel telegram --reply-to "@admin"
```

## Related

<CardGroup cols={2}>
  <Card title="Agent CLI reference" href="/cli/agent" icon="terminal">
    Full `openclaw agent` flag and option reference.
  </Card>
  <Card title="Sub-agents" href="/tools/subagents" icon="users">
    Background sub-agent spawning.
  </Card>
  <Card title="Sessions" href="/concepts/session" icon="comments">
    How session keys work and how `--to`, `--agent`, and `--session-id` resolve them.
  </Card>
  <Card title="Slash commands" href="/tools/slash-commands" icon="slash">
    Native command catalog used inside agent sessions.
  </Card>
</CardGroup>
