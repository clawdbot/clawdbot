---
summary: "Agent tool surface for Clawdbot (browser, canvas, nodes, cron) replacing clawdbot-* skills"
read_when:
  - Adding or modifying agent tools
  - Retiring or changing clawdbot-* skills
---

# Tools (Clawdbot)

Clawdbot exposes **first-class agent tools** for browser, canvas, nodes, and cron.
These replace the old `clawdbot-*` skills: the tools are typed, no shelling,
and the agent should rely on them directly.

## Disabling tools

You can globally allow/deny tools via `agent.tools` in `clawdbot.json`
(deny wins). This prevents disallowed tools from being sent to providers.

```json5
{
  agent: {
    tools: {
      deny: ["browser"]
    }
  }
}
```

## Tool inventory

### `bash`
Run shell commands in the workspace.

Core parameters:
- `command` (required)
- `yieldMs` (auto-background after timeout, default 10000)
- `background` (immediate background)
- `timeout` (seconds; kills the process if exceeded, default 1800)
- `elevated` (bool; run on host if elevated mode is enabled/allowed)
- Need a real TTY? Use the tmux skill.

Notes:
- Returns `status: "running"` with a `sessionId` when backgrounded.
- Use `process` to poll/log/write/kill/clear background sessions.

### `process`
Manage background bash sessions.

Core actions:
- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notes:
- `poll` returns new output and exit status when complete.
- `log` supports line-based `offset`/`limit` (omit `offset` to grab the last N lines).

### `browser`
Control the dedicated clawd browser.

Core actions:
- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (returns image block + `MEDIA:<path>`)
- `act` (UI actions: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profile management:
- `profiles` — list all browser profiles with status
- `create-profile` — create new profile with auto-allocated port (or `cdpUrl`)
- `delete-profile` — stop browser, delete user data, remove from config (local only)
- `reset-profile` — kill orphan process on profile's port (local only)

Common parameters:
- `controlUrl` (defaults from config)
- `profile` (optional; defaults to `browser.defaultProfile`)
Notes:
- Requires `browser.enabled=true` (default is `true`; set `false` to disable).
- Uses `browser.controlUrl` unless `controlUrl` is passed explicitly.
- All actions accept optional `profile` parameter for multi-instance support.
- When `profile` is omitted, uses `browser.defaultProfile` (defaults to "clawd").
- Profile names: lowercase alphanumeric + hyphens only (max 64 chars).
- Port range: 18800-18899 (~100 profiles max).
- Remote profiles are attach-only (no start/stop/reset).
- `snapshot` defaults to `ai`; use `aria` for the accessibility tree.
- `act` requires `ref` from `snapshot --format ai`; use `evaluate` for rare CSS selector needs.
- Avoid `act` → `wait` by default; use it only in exceptional cases (no reliable UI state to wait on).
- `upload` can optionally pass a `ref` to auto-click after arming.
- `upload` also supports `inputRef` (aria ref) or `element` (CSS selector) to set `<input type="file">` directly.

### `canvas`
Drive the node Canvas (present, eval, snapshot, A2UI).

Core actions:
- `present`, `hide`, `navigate`, `eval`
- `snapshot` (returns image block + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Notes:
- Uses gateway `node.invoke` under the hood.
- If no `node` is provided, the tool picks a default (single connected node or local mac node).
- A2UI is v0.8 only (no `createSurface`); the CLI rejects v0.9 JSONL with line errors.
- Quick smoke: `clawdbot canvas a2ui push --text "Hello from A2UI"`.

### `nodes`
Discover and target paired nodes; send notifications; capture camera/screen.

Core actions:
- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notes:
- Camera/screen commands require the node app to be foregrounded.
- Images return image blocks + `MEDIA:<path>`.
- Videos return `FILE:<path>` (mp4).
- Location returns a JSON payload (lat/lon/accuracy/timestamp).

### `image`
Analyze an image with the configured image model.

Core parameters:
- `image` (required path or URL)
- `prompt` (optional; defaults to "Describe the image.")
- `model` (optional override)
- `maxBytesMb` (optional size cap)

Notes:
- Only available when `agent.imageModel` is configured (primary or fallbacks).
- Uses the image model directly (independent of the main chat model).

### `cron`
Manage Gateway cron jobs and wakeups.

Core actions:
- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (enqueue system event + optional immediate heartbeat)

Notes:
- `add` expects a full cron job object (same schema as `cron.add` RPC).
- `update` uses `{ id, patch }`.

### `gateway`
Restart the running Gateway process (in-place).

Core actions:
- `restart` (sends `SIGUSR1` to the current process; `clawdbot gateway`/`gateway-daemon` restart in-place)

Notes:
- Use `delayMs` (defaults to 2000) to avoid interrupting an in-flight reply.

### `sessions_list` / `sessions_history` / `sessions_send`
List sessions, inspect transcript history, or send to another session.

Core parameters:
- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = none)
- `sessions_history`: `sessionKey`, `limit?`, `includeTools?`
- `sessions_send`: `sessionKey`, `message`, `timeoutSeconds?` (0 = fire-and-forget)

Notes:
- `main` is the canonical direct-chat key; global/unknown are hidden.
- `messageLimit > 0` fetches last N messages per session (tool messages filtered).
- `sessions_send` waits for final completion when `timeoutSeconds > 0`.
- `sessions_send` runs a reply‑back ping‑pong (reply `REPLY_SKIP` to stop; max turns via `session.agentToAgent.maxPingPongTurns`, 0–5).
- After the ping‑pong, the target agent runs an **announce step**; reply `ANNOUNCE_SKIP` to suppress the announcement.

### `discord`
Send Discord reactions, stickers, or polls.

Core actions:
- `react` (`channelId`, `messageId`, `emoji`)
- `reactions` (`channelId`, `messageId`, optional `limit`)
- `sticker` (`to`, `stickerIds`, optional `content`)
- `poll` (`to`, `question`, `answers`, optional `allowMultiselect`, `durationHours`, `content`)
- `permissions` (`channelId`)
- `readMessages` (`channelId`, optional `limit`/`before`/`after`/`around`)
- `sendMessage` (`to`, `content`, optional `mediaUrl`, `replyTo`)
- `editMessage` (`channelId`, `messageId`, `content`)
- `deleteMessage` (`channelId`, `messageId`)
- `threadCreate` (`channelId`, `name`, optional `messageId`, `autoArchiveMinutes`)
- `threadList` (`guildId`, optional `channelId`, `includeArchived`, `before`, `limit`)
- `threadReply` (`channelId`, `content`, optional `mediaUrl`, `replyTo`)
- `pinMessage`/`unpinMessage` (`channelId`, `messageId`)
- `listPins` (`channelId`)
- `searchMessages` (`guildId`, `content`, optional `channelId`/`channelIds`, `authorId`/`authorIds`, `limit`)
- `memberInfo` (`guildId`, `userId`)
- `roleInfo` (`guildId`)
- `emojiList` (`guildId`)
- `roleAdd`/`roleRemove` (`guildId`, `userId`, `roleId`)
- `channelInfo` (`channelId`)
- `channelList` (`guildId`)
- `voiceStatus` (`guildId`, `userId`)
- `eventList` (`guildId`)
- `eventCreate` (`guildId`, `name`, `startTime`, optional `endTime`, `description`, `channelId`, `entityType`, `location`)
- `timeout` (`guildId`, `userId`, optional `durationMinutes`, `until`, `reason`)
- `kick` (`guildId`, `userId`, optional `reason`)
- `ban` (`guildId`, `userId`, optional `reason`, `deleteMessageDays`)

Notes:
- `to` accepts `channel:<id>` or `user:<id>`.
- Polls require 2–10 answers and default to 24 hours.
- `reactions` returns per-emoji user lists (limited to 100 per reaction).
- `discord.actions.*` gates Discord tool actions; `roles` + `moderation` default to `false`.
- `searchMessages` follows the Discord preview spec (limit max 25, channel/author filters accept arrays).
- The tool is only exposed when the current surface is Discord.

## Parameters (common)

Gateway-backed tools (`canvas`, `nodes`, `cron`):
- `gatewayUrl` (default `ws://127.0.0.1:18789`)
- `gatewayToken` (if auth enabled)
- `timeoutMs`

Browser tool:
- `controlUrl` (defaults from config)

## Recommended agent flows

Browser automation:
1) `browser` → `status` / `start`
2) `snapshot` (ai or aria)
3) `act` (click/type/press)
4) `screenshot` if you need visual confirmation

Canvas render:
1) `canvas` → `present`
2) `a2ui_push` (optional)
3) `snapshot`

Node targeting:
1) `nodes` → `status`
2) `describe` on the chosen node
3) `notify` / `camera_snap` / `screen_record`

## Safety

- Avoid `system.run` (not exposed as a tool).
- Respect user consent for camera/screen capture.
- Use `status/describe` to ensure permissions before invoking media commands.

## How the model sees tools (pi-mono internals)

Tools are exposed to the model in **two parallel channels**:

1) **System prompt text**: a human-readable list + guidelines.
2) **Provider tool schema**: the actual function/tool declarations sent to the model API.

In pi-mono:
- System prompt builder: `packages/coding-agent/src/core/system-prompt.ts`
  - Builds the `Available tools:` list from `toolDescriptions`.
  - Appends skills and project context.
- Tool schemas passed to providers:
  - OpenAI: `packages/ai/src/providers/openai-responses.ts` (`convertTools`)
  - Anthropic: `packages/ai/src/providers/anthropic.ts` (`convertTools`)
  - Gemini: `packages/ai/src/providers/google-shared.ts` (`convertTools`)
- Tool execution loop:
  - Agent loop: `packages/ai/src/agent/agent-loop.ts`
  - Validates tool arguments and executes tools, then appends `toolResult` messages.

In Clawdbot:
- System prompt append: `src/agents/system-prompt.ts`
- Tool list injected via `createClawdbotCodingTools()` in `src/agents/pi-tools.ts`
