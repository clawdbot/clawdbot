---
summary: "Session management rules, keys, and persistence for chats"
read_when:
  - Modifying session handling or storage
---
# Session Management

Clawdbot treats **one session as primary**. The canonical key is fixed to `main` for direct chats (or `global` when scope is global); no configuration is required. `session.mainKey` is ignored. Older/local sessions can stay on disk, but only the primary key is used for desktop/web chat and direct agent calls.

## Gateway is the source of truth
All session state is **owned by the gateway** (the “master” Clawdbot). UI clients (macOS app, WebChat, etc.) must query the gateway for session lists and token counts instead of reading local files.

- In **remote mode**, the session store you care about lives on the remote gateway host, not your Mac.
- Token counts shown in UIs come from the gateway’s store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients do not parse JSONL transcripts to “fix up” totals.

## Where state lives
- On the **gateway host**:
  - Store file: `~/.clawdbot/sessions/sessions.json` (legacy: `~/.clawdbot/sessions.json`).
  - Transcripts: `~/.clawdbot/sessions/<SessionId>.jsonl` (one file per session id).
- The store is a map `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries is safe; they are recreated on demand.
- Group entries may include `displayName`, `surface`, `subject`, `room`, and `space` to label sessions in UIs.
- Clawdbot does **not** read legacy Pi/Tau session folders.

## Mapping transports → session keys
- Direct chats (WhatsApp, Telegram, Discord, desktop Web Chat) all collapse to the **primary key** so they share context.
- Multiple phone numbers can map to that same key; they act as transports into the same conversation.
- Group chats isolate state with `surface:group:<id>` keys (rooms/channels use `surface:channel:<id>`); do not reuse the primary key for groups. (Discord display names show `discord:<guildSlug>#<channelSlug>`.)
  - Legacy `group:<surface>:<id>` and `group:<id>` keys are still recognized.
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
        { action: "deny", match: { surface: "discord", chatType: "group" } },
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

## Configuration (optional rename example)
```json5
// ~/.clawdbot/clawdbot.json
{
  session: {
    scope: "per-sender",      // keep group keys separate
    idleMinutes: 120,
    resetTriggers: ["/new", "/reset"],
    store: "~/.clawdbot/sessions/sessions.json",
    // mainKey is ignored; primary key is fixed to "main"
  }
}
```

## Inspecting
- `pnpm clawdbot status` — shows store path and recent sessions.
- `pnpm clawdbot sessions --json` — dumps every entry (filter with `--active <minutes>`).
- `pnpm clawdbot gateway call sessions.list --params '{}'` — fetch sessions from the running gateway (use `--url`/`--token` for remote gateway access).
- Send `/status` in chat to see whether the agent is reachable, how much of the session context is used, current thinking/verbose toggles, and when your WhatsApp web creds were last refreshed (helps spot relink needs).
- Send `/compact` (optional instructions) to summarize older context and free up window space.
- JSONL transcripts can be opened directly to review full turns.

## Tips
- Keep the primary key dedicated to 1:1 traffic; let groups keep their own keys.
- When automating cleanup, delete individual keys instead of the whole store to preserve context elsewhere.
