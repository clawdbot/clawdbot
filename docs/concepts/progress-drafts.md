---
summary: "Progress drafts: one visible work-in-progress message that updates while an agent runs"
read_when:
  - Configuring visible progress updates for long-running chat turns
  - Choosing between partial, block, and progress streaming modes
  - Explaining how OpenClaw updates one channel message while work is in progress
  - Troubleshooting progress drafts, standalone progress messages, or finalization fallback
title: "Progress drafts"
---

Progress drafts turn one channel message into a live status line while an
agent works, instead of a stack of temporary "still working" replies. Set
`channels.<channel>.streaming.mode: "progress"` and OpenClaw creates the
message once real work starts, edits it as the agent reads, plans, calls
tools, or waits for approval, then turns it into the final answer.

```text
Working...
📖 from docs/concepts/progress-drafts.md
🔎 Web Search: for "discord edit message"
🛠️ Bash: run tests
```

<Note>
  Discord already defaults to `streaming.mode: "progress"` when
  `channels.discord.streaming` is unset, so progress drafts
  show up there without any config. Every other channel defaults to `partial`
  or `off`; see [Streaming and chunking](/concepts/streaming#channel-mapping)
  for the full per-channel default table.
</Note>

## Quick start

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
      },
    },
  },
}
```

Defaults from here: a start delay of 5 seconds, compact progress lines while
useful work happens, and suppression of the older standalone progress messages
for that turn. Raw tool-line drafts use
an automatic one-word label; a status headline omits that redundant title
unless you configure one explicitly.

This page covers the progress-draft experience and its config knobs. For the
full streaming-mode matrix, per-channel runtime notes, and legacy key
migration, see [Streaming and chunking](/concepts/streaming).

## What users see

| Part            | Purpose                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| Status headline | On Discord and Telegram, the model preamble; Discord adds a utility filler.       |
| Label           | Optional starter/status line such as `Working`.                                   |
| Progress lines  | Compact run updates using the same tool icons and detail formatter as `/verbose`. |

For raw tool progress, the label appears once the agent starts meaningful work
and stays busy for the initial delay.
It sits at the top of the rolling progress-line list, so it scrolls away once
enough concrete work lines appear. A status headline shows only the agent's
plain-language status unless a label is configured explicitly. Plain text-only
replies never show a progress draft; a line appears only for real work updates,
for example `🛠️ Bash: run tests`, `🔎 Web Search: for "discord edit message"`,
or `✍️ Write: to /tmp/file`.

The final answer replaces the draft in place when the channel can safely do
that; otherwise OpenClaw sends the final answer through normal delivery and
cleans up or stops updating the draft (see [Finalization](#finalization)).

## Choose a mode

`channels.<channel>.streaming.mode` controls the visible in-progress behavior:

| Mode       | Best for                         | What appears in chat                              |
| ---------- | -------------------------------- | ------------------------------------------------- |
| `off`      | Quiet channels                   | Only the final answer.                            |
| `partial`  | Watching answer text appear      | One draft edited with the latest answer text.     |
| `block`    | Larger answer-preview chunks     | One preview updated or appended in bigger chunks. |
| `progress` | Tool-heavy or long-running turns | One status draft, then the final answer.          |

Pick `progress` when users care more about "what is happening" than watching
answer text stream token by token; `partial` when the answer text itself is
the progress signal; `block` for larger preview chunks. On Discord and
Telegram, `streaming.mode: "block"` is still preview streaming, not normal
block-reply delivery — use `streaming.block.enabled` for that.

## Configure labels

Progress labels live under `channels.<channel>.streaming.progress`. The default
raw tool-line label is `"auto"`, which uses the plain built-in `Working`
label. A status headline hides that implicit label; set
`label: "auto"` explicitly if you want a label above it too:

```text
Working
```

Use a fixed label:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: "Investigating",
        },
      },
    },
  },
}
```

Use your own label pool (still picked at random/by seed when `label: "auto"`):

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: "auto",
          labels: ["Checking", "Reading", "Testing", "Finishing"],
        },
      },
    },
  },
}
```

Hide the label and show only progress lines:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: false,
        },
      },
    },
  },
}
```

## Control progress lines

Progress lines come from real run events: tool starts, item updates, task
plans, approvals, command output, patch summaries, and similar agent activity.
They are enabled by default (`progress.toolProgress`, default `true`).

Tools can also emit typed progress while a single call is still running. That
is how a slow fetch or search updates the visible draft before the tool
returns its final result. The progress update is a partial tool result with
empty model content and explicit public channel metadata:

```json
{
  "content": [],
  "progress": {
    "text": "Fetching page content...",
    "visibility": "channel",
    "privacy": "public",
    "id": "web_fetch:fetching"
  }
}
```

OpenClaw renders only `progress.text` in the channel progress UI. The normal
tool result still arrives later as `content`/`details` and is the only part
returned to the model.

When adding progress to a tool, emit a short, generic message and delay it
until the operation has been pending long enough to be useful. `web_fetch`
does exactly this with a 5-second delay:

```typescript
const clearProgressTimer = scheduleToolProgress(
  onUpdate,
  { text: "Fetching page content...", id: "web_fetch:fetching" },
  5_000,
  { signal },
);

try {
  return await runToolWork();
} finally {
  clearProgressTimer();
}
```

Fast calls show no progress line; long calls show one while still pending;
canceled calls clear the timer before stale progress can appear. Progress text
is a public UI side channel, so it must never include secrets, raw arguments,
fetched content, command output, or page text.

### Detail mode

OpenClaw uses the same formatter for progress drafts and `/verbose`:

```json5
{
  agents: {
    defaults: {
      toolProgressDetail: "explain", // explain | raw
    },
  },
}
```

`"explain"` is the default and keeps drafts stable with concise labels.
`"raw"` appends the underlying command when available, which is useful while
debugging but noisier in chat. For example, a `node --check /tmp/app.js` call
renders differently by mode:

| Mode      | Progress line                                                   |
| --------- | --------------------------------------------------------------- |
| `explain` | `🛠️ check js syntax for /tmp/app.js`                            |
| `raw`     | `🛠️ check js syntax for /tmp/app.js · node --check /tmp/app.js` |

### Command/exec text

`streaming.progress.commandText` (default `"raw"`) controls how much command
detail shows next to exec/bash progress lines, independent of the detail mode
above. Set it to `"status"` to keep a tool-progress line visible while hiding
the command text entirely:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          commandText: "status",
        },
      },
    },
  },
}
```

### Commentary lane

`streaming.progress.commentary` (default `false`) interleaves the model's
pre-tool commentary/preamble narration (💬, for example "I'll check... then
...") with tool lines in the draft. See
[Streaming and chunking](/concepts/streaming#commentary-progress-lane) for the
shared config shape across channels.

With the commentary lane enabled, preambles render only as those interleaved
💬 lines; the status headline below stays out of the way so the lane keeps its
documented shape.

### Status headline

On Discord and Telegram in progress mode, the model's typed pre-tool preamble
becomes the draft's status headline whenever it is available. Other
progress-mode channels keep their existing status behavior. The headline is on
by default and does not bypass the normal activity gate for short turns;
enabling `streaming.progress.commentary` hands preambles to the interleaved
commentary lane instead.

On Discord, when a utility model resolves for the agent — an explicit
[`utilityModel`](/gateway/config-agents#utilitymodel), or the primary
provider's declared small-model default (OpenAI → `gpt-5.6-luna`,
Anthropic → `claude-haiku-4-5`) — it supplies a short plain-language filler
when the model emits no preamble or has been quiet for about 20 seconds
(Telegram's headline is preamble-only today):

```text
Updating the default model in your config, then restarting the gateway to pick
it up. One agent listing call failed and is being retried.
```

Utility narration is on by default (`streaming.progress.narration`, default
`true`) and never falls back to the primary model: it runs only with an explicit
`utilityModel` or a provider-declared default for the agent's primary
provider. Set `utilityModel: ""` to disable utility routing entirely. Tool lines
keep accumulating underneath and return if both status sources stop. Draft
edits still wait for the normal activity gate and an actual
text change, which avoids flashes on fast turns and reduces edit churn in busy
channels. Set `narration: false` to disable only the utility-model filler; model
preamble headlines remain enabled:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          narration: false,
        },
      },
    },
  },
}
```

Narration input is bounded and redacted: the utility model receives the
inbound request text plus the same compact, redacted tool summaries the draft
would render — never raw command output or tool results. With
`commandText: "status"`, narration input also omits exec/bash command text,
matching what the draft shows.

### Line limits

Limit how many lines stay visible (default 8):

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          maxLines: 4,
        },
      },
    },
  },
}
```

Progress lines are compacted automatically to reduce chat-bubble reflow while
the draft is edited, and OpenClaw truncates long lines so repeated draft edits
do not wrap differently on every update. The default per-line budget is 120
characters; prose cuts at a word boundary, while long details such as paths or
raw commands are shortened with a middle ellipsis so the suffix stays visible.

Tune the per-line budget:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          maxLineChars: 160,
        },
      },
    },
  },
}
```

### Rich rendering (Slack)

Slack can render progress lines as structured Block Kit fields instead of
plain text:

```json5
{
  channels: {
    slack: {
      streaming: {
        mode: "progress",
        progress: {
          render: "rich",
        },
      },
    },
  },
}
```

Rich rendering always sends the same plain-text body alongside the Block Kit
fields, so clients that cannot render the richer shape still show the compact
progress text.

### Hide tool/task lines

Keep the single progress draft but hide tool and task lines:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          toolProgress: false,
        },
      },
    },
  },
}
```

With `toolProgress: false`, OpenClaw still suppresses the older standalone
tool-progress messages for that turn — the channel stays visually quiet until
the final answer, except for the label if one is configured.

## Channel behavior

| Channel         | Progress transport                     | Notes                                                                                                                                                     |
| --------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord         | Send one message, then edit it.        | Defaults to `progress` mode; the final answer carries a `-#` activity receipt and the status draft is deleted after the answer lands.                     |
| Matrix          | Send one event, then edit it.          | Account-level streaming config controls account-level drafts.                                                                                             |
| Microsoft Teams | Native Teams stream in personal chats. | `streaming.mode: "block"` maps to Teams block delivery instead.                                                                                           |
| Slack           | Native stream or editable draft post.  | Needs a reply thread target; top-level DMs without one still get draft preview posts and edits.                                                           |
| Telegram        | Send one message, then edit it.        | If a message lands between the progress draft and the answer, the draft reposts below it (post-new-then-delete-old) instead of scroll-jumping the client. |
| Mattermost      | Editable draft post.                   | `block` mode rotates between completed text and tool-activity posts; other modes fold tool activity into the same draft-style post.                       |

Channels without safe edit support fall back to typing indicators or
final-only delivery. See [Streaming and chunking](/concepts/streaming) for the
full runtime-behavior breakdown per channel.

## Finalization

When the final answer is ready, OpenClaw tries to keep the chat clean:

- In `progress` mode on Discord, the final answer is sent as a fresh message
  with a small `-#` activity receipt appended (for example
  `-# 🧠 2 thoughts · 🛠️ 5 tool calls · ⏱️ 12s`), and the status draft is
  deleted once that answer is delivered. Busy channels keep no orphaned tool
  log above the reply; error finals keep the draft as the visible record of
  the failed turn.
- If the draft can safely become the final answer (`partial`/`block` modes),
  OpenClaw edits it in place.
- If the channel uses native progress streaming, OpenClaw finalizes that
  stream when the native transport accepts the final text.
- Otherwise (media, an approval prompt, an explicit reply target, too many
  chunks, or a failed edit/send) OpenClaw sends the final answer through the
  normal channel delivery path instead of overwriting the draft.

The fallback is intentional: sending a fresh final answer beats losing text,
mis-threading a reply, or overwriting a draft with a payload the channel
cannot represent safely.

## Troubleshooting

**I only see the final answer.**

Check that `channels.<channel>.streaming.mode` is `progress` for the account
or channel that handled the message. Some group or quote-reply paths disable
draft previews for a turn when the channel cannot safely edit the right
message.

**I see the label but no tool lines.**

Check `streaming.progress.toolProgress`. If it is `false`, OpenClaw keeps the
single draft behavior but hides tool and task progress lines.

**I see a fresh final message instead of an edited draft.**

That is the safety fallback described in [Finalization](#finalization). It can
happen for media replies, long answers, explicit reply targets, old Telegram
drafts, missing Slack thread targets, deleted preview messages, or failed
native stream finalization.

**I still see standalone progress messages.**

Progress mode suppresses default standalone tool-progress messages whenever a
draft is active. If standalone messages still appear, confirm the turn is
actually using `progress` mode and not `streaming.mode: "off"` or a channel
path that cannot create a draft for that message.

**Teams behaves differently from Discord or Telegram.**

Microsoft Teams uses a native stream in personal chats instead of the generic
send-and-edit preview transport, and maps `streaming.mode: "block"` to Teams
block delivery because it has no draft-preview block mode like Discord and
Telegram.

## Related

- [Streaming and chunking](/concepts/streaming)
- [Messages](/concepts/messages)
- [Channel configuration](/gateway/config-channels)
- [Discord](/channels/discord)
- [Matrix](/channels/matrix)
- [Microsoft Teams](/channels/msteams)
- [Slack](/channels/slack)
- [Telegram](/channels/telegram)
- [Mattermost](/channels/mattermost)
