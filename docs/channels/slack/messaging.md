---
summary: "Acknowledgement reactions, live streaming previews, and slash commands"
read_when:
  - Changing how OpenClaw acknowledges an inbound Slack message
  - Configuring live progress cards or draft previews
  - Choosing between one slash command and native commands
title: "Slack message behavior"
sidebarTitle: "Message behavior"
---

What a Slack conversation looks like while OpenClaw works, and how commands reach it.

## Ack reactions

`ackReaction` sends an acknowledgement emoji while OpenClaw is processing an inbound message. `ackReactionScope` decides _when_ that emoji is actually sent.

The acknowledgement stays static during work. With `messages.statusReactions.enabled: true`, actual failures briefly show an error reaction before restoring the acknowledgement. Tool calls, thinking, compaction, and long-running tools do not cycle or accumulate reactions, and successful completion does not flash a separate success emoji.

### Emoji (`ackReaction`)

Resolution order:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- agent identity emoji fallback (`agents.entries.*.identity.emoji`, else `"eyes"` / 👀)

Notes:

- Slack expects shortcodes (for example `"eyes"`).
- Use `""` to disable the reaction for the Slack account or globally.

### Scope (`messages.ackReactionScope`)

The Slack provider reads scope from `messages.ackReactionScope` (default `"group-mentions"`). There is no Slack-account or Slack-channel-level override today; the value is global to the gateway.

Values:

- `"all"`: react in DMs and groups, including ambient room events.
- `"direct"`: react in DMs only.
- `"group-all"`: react on every group message except ambient room events (no DMs).
- `"group-mentions"` (default): react in groups, but only when the bot is mentioned (or in group mentionables that opted in). **DMs are excluded.**
- `"off"` / `"none"`: never react.

<Note>
The default scope (`"group-mentions"`) does not fire ack reactions in direct messages or ambient room events. To see the configured `ackReaction` (for example `"eyes"`) on inbound Slack DMs and quiet room events, set `messages.ackReactionScope` to `"all"`. Scope changes apply to the next message without reconnecting Slack.
</Note>

```json5
{
  messages: {
    ackReaction: "eyes",
    ackReactionScope: "all", // react in DMs and groups
  },
}
```

## Text streaming

`channels.slack.streaming` controls live preview behavior:

- `off`: disable live preview streaming.
- `partial`: replace preview text with the latest partial output. Set this to restore the previous default behavior.
- `block`: append chunked preview updates.
- `progress` (default): show structured progress in one native task card when Slack supports it, with a Block Kit session-card fallback.
- `streaming.progress.toolProgress`: `progress` mode is quiet by default (`false`). Set `true` to add one task row (native card) or activity line (Block Kit card) per tool call, plus tool/file/time counters on the Block Kit card. `streaming.preview.toolProgress` controls tool previews in `partial` and `block` modes (default: `true`).
- `streaming.preview.commandText` / `streaming.progress.commandText`: `status` keeps compact tool-progress lines while hiding raw command/exec text (default); set `raw` to opt into command text.

Show the tool log while hiding raw command/exec text:

```json
{
  "channels": {
    "slack": {
      "streaming": {
        "mode": "progress",
        "progress": {
          "toolProgress": true,
          "commandText": "status"
        }
      }
    }
  }
}
```

`channels.slack.streaming.nativeTransport` controls Slack native text streaming when `channels.slack.streaming.mode` is `partial` (default: `true`).

In `progress` mode, Slack's native agent card is the default: the whole turn is one streamed message that interleaves narration with a live plan/task card and finishes with the assistant's answer in that same message. The card shows authored plan steps when the agent publishes a plan, otherwise one stable work-summary row; approval requests and failed commands get their own row. With `progress.toolProgress: true`, it also shows per-tool task rows alongside any authored plan. Routine updates coalesce at one-second intervals; approvals, failures, and completion bypass that delay. A tool failure shows as a red attention row while the turn runs; if the turn still completes successfully, that row settles as `Recovered: …` instead of staying red. The card appears only once a turn does real work — tool or plan activity still running after a short delay — so a plain question is answered without one.

Set `channels.slack.streaming.progress.nativeTaskCards` to `false` to fall back to the Block Kit session card, which posts a separate message showing title, narration, plan checklist, and authored commentary, and finalizes to success or error. With `progress.toolProgress: true` it also lists recent tool activity, tool/file totals, and elapsed time.

Set `channels.slack.streaming.progress.style` to `"compact"` for one plain-text progress draft instead of either card surface. Explicitly setting `progress.toolProgress: false` also selects compact style when `style` is unset; leaving both options unset keeps the default quiet card. Set `style: "card"` to keep a card with `toolProgress: false`. Commentary appears as italic text, and authored reasoning, approval requests, and failures remain visible. The final response is posted as a new message, then the temporary preview is deleted after Slack confirms delivery. Older previews displaced by human replies are cleaned up with it; durable messages and videos stay in the conversation.

For streamed preambles, Slack waits for the first complete preamble before creating the message, so its notification contains the full thought rather than a single token. Once that message exists, later preambles can stream as edits without another notification.

```json5
{
  channels: {
    slack: {
      streaming: {
        mode: "progress",
        progress: {
          style: "compact",
          label: false,
          commentary: true,
          toolProgress: false,
        },
      },
    },
  },
}
```

Compact progress always uses normal final delivery, including for media and errors. Other draft modes use normal delivery when the reply cannot safely replace the draft, including oversized text, split block payloads, custom outbound identity, or an edit failure.

Both surfaces link the session with **Open in OpenClaw**, but only when that link can work: `gateway.publicOrigin` must be set (the externally reachable Gateway origin) and the Control UI must not be disabled via `gateway.controlUi.enabled: false`. Installations that leave `publicOrigin` unset — where there is no way to reach OpenClaw from Slack — get no link rather than a dead one. If the Control UI is served below a path prefix, also set `gateway.controlUi.basePath`.

- A reply thread must be available for native text streaming and Slack session status to appear. Thread selection still follows `replyToMode`.
- Channel, group-chat, and top-level DM roots can still use the normal draft preview when native streaming is unavailable or no reply thread exists.
- Top-level Slack DMs stay off-thread by default, so they do not show Slack's thread-style native stream/status preview; OpenClaw posts and edits a draft preview in the DM instead.
- Custom outbound username/icon settings keep portable previews enabled. OpenClaw keeps the preview or session card app-authored and delivers the customized final separately. Slack does not allow impersonated messages to be deleted.
- Media and non-text payloads fall back to normal delivery.
- Outside compact progress, media/error finals cancel pending preview edits; eligible text/block finals flush only when they can edit the preview in place.
- Native streamed replies wait for Slack's acknowledgement before delivery is marked successful. Each complete reply block flushes separately, including short blocks; routine progress updates still coalesce. A later progress-card finalization failure does not discard an already acknowledged reply.
- Explicit HTTP 429 rate-limit rejections are retried up to twice by default, after Slack's `Retry-After` delay. This also applies to ordinary messages and upload completion; lost responses and server errors are not replayed.
- Definite recipient or scope rejections fall back to normal delivery for buffered text. Ambiguous streaming failures (such as a lost response) report failure without replaying the unacknowledged text, because Slack may already have accepted it. Later payloads use normal delivery.

Use draft preview instead of Slack native text streaming:

```json5
{
  channels: {
    slack: {
      streaming: {
        mode: "partial",
        nativeTransport: false,
      },
    },
  },
}
```

Select Slack native progress task cards explicitly:

```json5
{
  channels: {
    slack: {
      streaming: {
        mode: "progress",
        progress: {
          nativeTaskCards: true,
        },
      },
    },
  },
}
```

Legacy keys:

- `channels.slack.streamMode` (`replace | status_final | append`) is a legacy alias for `channels.slack.streaming.mode`.
- boolean `channels.slack.streaming` is a legacy alias for `channels.slack.streaming.mode` and `channels.slack.streaming.nativeTransport`.
- top-level `channels.slack.chunkMode` and `channels.slack.nativeStreaming` are legacy aliases for `channels.slack.streaming.chunkMode` and `channels.slack.streaming.nativeTransport`.
- Legacy aliases are not read at runtime; run `openclaw doctor --fix` to rewrite persisted Slack streaming config to the canonical keys.

## Typing reaction fallback

`typingReaction` adds a temporary reaction to the inbound Slack message while OpenClaw is processing a reply, then removes it when the run finishes. This is most useful outside of thread replies, which use Slack's `processing` session status.

Resolution order:

- `channels.slack.accounts.<accountId>.typingReaction`
- `channels.slack.typingReaction`

Notes:

- Slack expects shortcodes (for example `"hourglass_flowing_sand"`).
- The reaction is best-effort and cleanup is attempted automatically after the reply or failure path completes.

## Commands and slash behavior

Slash commands appear in Slack as either a single configured command or multiple native commands. Configure `channels.slack.slashCommand` to change command defaults:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

```txt
/openclaw /help
```

Native commands require [additional manifest settings](/channels/slack/manifest-and-scopes#additional-manifest-settings) in your Slack app and are enabled with `channels.slack.commands.native: true` or `commands.native: true` in global configurations instead.

- Native command auto-mode is **off** for Slack so `commands.native: "auto"` does not enable Slack native commands.

```txt
/help
```

Native argument menus render as one of the following, in priority order:

- 3-5 short-enough options: an overflow ("...") menu
- more than 100 options, with async option filtering available: external select
- 1-2 options, or any option whose encoded value is too long for a select: button blocks
- otherwise (6-100 options, or more than 100 without async filtering): static select menu, chunked at 100 options per menu

```txt
/think
```

Slash sessions use isolated keys like `agent:<agentId>:slack:slash:<userId>` and still route command executions to the target conversation session using `CommandTargetSessionKey`.
