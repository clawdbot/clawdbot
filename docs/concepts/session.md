---
summary: "Session management rules, keys, and persistence for chats"
read_when:
  - Modifying session handling or storage
---
# Session Management

Clawdbot treats **one direct-chat session per agent** as primary. Direct chats collapse to `agent:<agentId>:<mainKey>` (default `main`), while group/channel chats get their own keys. `session.mainKey` is honored.

## Gateway is the source of truth
All session state is **owned by the gateway** (the “master” Clawdbot). UI clients (macOS app, WebChat, etc.) must query the gateway for session lists and token counts instead of reading local files.

- In **remote mode**, the session store you care about lives on the remote gateway host, not your Mac.
- Token counts shown in UIs come from the gateway’s store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients do not parse JSONL transcripts to “fix up” totals.

## Where state lives
- On the **gateway host**:
  - Store file: `~/.clawdbot/agents/<agentId>/sessions/sessions.json` (per agent).
- Transcripts: `~/.clawdbot/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram topic sessions use `.../<SessionId>-topic-<threadId>.jsonl`).
- The store is a map `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries is safe; they are recreated on demand.
- Group entries may include `displayName`, `channel`, `subject`, `room`, and `space` to label sessions in UIs.
- Clawdbot does **not** read legacy Pi/Tau session folders.

## Session pruning
Clawdbot trims **old tool results** from the in-memory context right before LLM calls by default.
This does **not** rewrite JSONL history. See [/concepts/session-pruning](/concepts/session-pruning).

## Pre-compaction memory flush
When a session nears auto-compaction, Clawdbot can run a **silent memory flush**
turn that reminds the model to write durable notes to disk. This only runs when
the workspace is writable. See [Memory](/concepts/memory) and
[Compaction](/concepts/compaction).

## Mapping transports → session keys
- Direct chats collapse to the per-agent primary key: `agent:<agentId>:<mainKey>`.
  - Multiple phone numbers and channels can map to the same agent main key; they act as transports into one conversation.
- Group chats isolate state: `agent:<agentId>:<channel>:group:<id>` (rooms/channels use `agent:<agentId>:<channel>:channel:<id>`).
  - Telegram forum topics append `:topic:<threadId>` to the group id for isolation.
  - Legacy `group:<id>` keys are still recognized for migration.
- Inbound contexts may still use `group:<id>`; the channel is inferred from `Provider` and normalized to the canonical `agent:<agentId>:<channel>:group:<id>` form.
- Other sources:
  - Cron jobs: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (unless explicitly set by the hook)
  - Node bridge runs: `node-<nodeId>`

## Lifecyle
- Idle expiry: `session.idleMinutes` (default 60). After the timeout a new `sessionId` is minted on the next message.
- Reset triggers: exact `/new` or `/reset` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through. If `/new` or `/reset` is sent alone, Clawdbot runs a short “hello” greeting turn to confirm the reset.
- Manual reset: delete specific keys from the store or remove the JSONL transcript; the next message recreates them.

## Send policy (optional)
Block delivery for specific session types without listing individual ids.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } }
      ],
      default: "allow"
    }
  }
}
```

Runtime override (owner only):
- `/send on` → allow for this session
- `/send off` → deny for this session
- `/send inherit` → clear override and use config rules
Send these as standalone messages so they register.

## Configuration (optional rename example)
```json5
// ~/.clawdbot/clawdbot.json
{
  session: {
    scope: "per-sender",      // keep group keys separate
    idleMinutes: 120,
    resetTriggers: ["/new", "/reset"],
    store: "~/.clawdbot/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  }
}
```

## Inspecting
- `pnpm clawdbot status` — shows store path and recent sessions.
- `pnpm clawdbot sessions --json` — dumps every entry (filter with `--active <minutes>`).
- `clawdbot gateway call sessions.list --params '{}'` — fetch sessions from the running gateway (use `--url`/`--token` for remote gateway access).
- Send `/status` as a standalone message in chat to see whether the agent is reachable, how much of the session context is used, current thinking/verbose toggles, and when your WhatsApp web creds were last refreshed (helps spot relink needs).
- Send `/stop` as a standalone message to abort the current run.
- Send `/compact` (optional instructions) as a standalone message to summarize older context and free up window space. See [/concepts/compaction](/concepts/compaction).
- JSONL transcripts can be opened directly to review full turns.

## Tips
- Keep the primary key dedicated to 1:1 traffic; let groups keep their own keys.
- When automating cleanup, delete individual keys instead of the whole store to preserve context elsewhere.
