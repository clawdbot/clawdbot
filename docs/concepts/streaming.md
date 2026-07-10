---
summary: "Streaming + chunking behavior (block replies, channel preview streaming, mode mapping)"
read_when:
  - Explaining how streaming or chunking works on channels
  - Changing block streaming or channel chunking behavior
  - Debugging duplicate/early block replies or channel preview streaming
title: "Streaming and chunking"
---

OpenClaw has two independent streaming layers, and there is **no true
token-delta streaming** to channel messages today:

- **Block streaming (channels):** emit completed **blocks** as the assistant
  writes. These are normal channel messages, not token deltas.
- **Preview streaming (Telegram/Discord/Slack/Matrix/Mattermost/MS Teams):**
  update a temporary **preview message** while generating (send + edits/appends).

## Block streaming (channel messages)

Block streaming sends assistant output in coarse chunks as it becomes available.

```text
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

- `text_delta/events`: model stream events (may be sparse for non-streaming models).
- `chunker`: `EmbeddedBlockChunker` applying min/max bounds + break preference.
- `channel send`: actual outbound messages (block replies).

**Controls** (all under `agents.defaults` unless noted):

| Key                                                          | Values / shape                                                          | Default    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------- |
| `blockStreamingDefault`                                      | `"on"` / `"off"`                                                        | `"off"`    |
| `blockStreamingBreak`                                        | `"text_end"` / `"message_end"`                                          | -          |
| `blockStreamingChunk`                                        | `{ minChars, maxChars, breakPreference? }`                              | -          |
| `blockStreamingCoalesce`                                     | `{ minChars?, maxChars?, idleMs? }` (merge streamed blocks before send) | -          |
| `*.blockStreaming` (channel override)                        | `true` / `false`, forces block streaming per channel (and per account)  | -          |
| `*.textChunkLimit` (e.g. `channels.whatsapp.textChunkLimit`) | number, hard cap                                                        | 4000       |
| `*.chunkMode`                                                | `"length"` / `"newline"`                                                | `"length"` |
| `channels.discord.maxLinesPerMessage`                        | number, soft line cap that splits tall replies to avoid UI clipping     | 17         |

`chunkMode: "newline"` splits on blank lines (paragraph boundaries), not every
newline, before falling back to length chunking once the text exceeds the
limit.

**Boundary semantics** for `blockStreamingBreak`:

- `text_end`: stream blocks as soon as the chunker emits; flush on each `text_end`.
- `message_end`: wait until the assistant message finishes, then flush buffered
  output. Still uses the chunker if the buffered text exceeds `maxChars`, so it
  can emit multiple chunks at the end.

### Media delivery with block streaming

Streaming media must use structured payload fields such as `mediaUrl` or
`mediaUrls`; streamed text is not parsed as an attachment command. When block
streaming sends media early, OpenClaw remembers that delivery for the turn. If
the final assistant payload repeats the same media URL, final delivery strips
the duplicate media instead of sending the attachment again.

Exact duplicate final payloads are suppressed. If the final payload adds
distinct text around media that was already streamed, OpenClaw still sends the
new text while keeping the media single-delivery. This prevents duplicate voice
notes or files on channels such as Telegram.

## Chunking algorithm (low/high bounds)

Block chunking is implemented by `EmbeddedBlockChunker`:

- **Low bound:** don't emit until buffer >= `minChars` (unless forced).
- **High bound:** prefer splits before `maxChars`; if forced, split at `maxChars`.
- **Break preference chain:** `paragraph` -> `newline` -> `sentence` ->
  whitespace -> hard break.
- **Code fences:** never split inside fences; when forced at `maxChars`, close
  and reopen the fence to keep Markdown valid.

`maxChars` is clamped to the channel `textChunkLimit`, so you cannot exceed
per-channel caps.

## Coalescing (merge streamed blocks)

When block streaming is enabled, OpenClaw can **merge consecutive block
chunks** before sending them, reducing single-line spam while still providing
progressive output.

- Coalescing waits for **idle gaps** (`idleMs`) before flushing.
- Buffers are capped by `maxChars` and flush if they exceed it.
- `minChars` prevents tiny fragments from sending until enough text accumulates
  (final flush always sends remaining text).
- Joiner is derived from `blockStreamingChunk.breakPreference`: `paragraph` ->
  `\n\n`, `newline` -> `\n`, `sentence` -> space.
- Channel overrides are available via `*.blockStreamingCoalesce` (including
  per-account configs).
- Discord, Signal, and Slack default coalesce to `{ minChars: 1500, idleMs: 1000 }`
  unless overridden.

## Human-like pacing between blocks

When block streaming is enabled, add a **randomized pause** between block
replies, after the first block, so multi-bubble responses feel more natural.

| `agents.defaults.humanDelay.mode` | Behavior                |
| --------------------------------- | ----------------------- |
| `off` (default)                   | No pause                |
| `natural`                         | 800-2500ms random pause |
| `custom`                          | `minMs`/`maxMs`         |

Override per agent via `agents.list[].humanDelay`. Applies only to **block
replies**, not final replies or tool summaries.

## "Stream chunks or everything"

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`
  (emit as you go). Non-Telegram channels also need `*.blockStreaming: true`.
- **Stream everything at end:** `blockStreamingBreak: "message_end"` (flush
  once, possibly multiple chunks if very long).
- **No block streaming:** `blockStreamingDefault: "off"` (only final reply).

Block streaming is **off unless** `*.blockStreaming` is explicitly set to
`true`. Channels can stream a live preview (`channels.<channel>.streaming`)
without block replies. The `blockStreaming*` defaults live under
`agents.defaults`, not the config root.

## Preview streaming modes

Canonical key: `channels.<channel>.streaming` (nested `{ mode, ... }`; a
top-level boolean is a legacy alias).

| Mode       | Behavior                                                              |
| ---------- | --------------------------------------------------------------------- |
| `off`      | Disable preview streaming                                             |
| `partial`  | Single preview replaced with latest text                              |
| `block`    | Preview updates in chunked/appended steps                             |
| `progress` | Progress/status preview during generation, final answer at completion |

`streaming.mode: "block"` is a preview-streaming mode for edit-capable
channels such as Discord and Telegram; it does not by itself enable channel
block delivery there. Use `streaming.block.enabled` (or the legacy
`blockStreaming` channel key) for normal block replies. Microsoft Teams is the
exception: it has no draft-preview block transport, so `streaming.mode:
"block"` disables native streaming entirely and the reply lands as regular
block delivery instead of native partial/progress streaming. Mattermost also
differs: in `block` mode it rotates the preview between completed text and
tool-activity blocks, so earlier blocks stay visible as separate posts
instead of being overwritten in one editable draft.

### Channel mapping

| Channel    | `off` | `partial` | `block` | `progress`              |
| ---------- | ----- | --------- | ------- | ----------------------- |
| Telegram   | Yes   | Yes       | Yes     | editable progress draft |
| Discord    | Yes   | Yes       | Yes     | editable progress draft |
| Slack      | Yes   | Yes       | Yes     | Yes                     |
| Mattermost | Yes   | Yes       | Yes     | Yes                     |
| MS Teams   | Yes   | Yes       | Yes     | native progress stream  |

Preview chunk config (`streaming.preview.chunk.*`, e.g. under
`channels.discord.streaming` or `channels.telegram.streaming`) defaults to
`minChars: 200`, `maxChars: 800` (clamped to the channel `textChunkLimit`), and
`breakPreference: "paragraph"`.

Slack-only:

- `channels.slack.streaming.nativeTransport` toggles Slack native streaming API
  calls (`chat.startStream`/`chat.appendStream`/`chat.stopStream`) when
  `channels.slack.streaming.mode="partial"` (default: `true`).
- Slack native streaming and Slack assistant thread status require a reply
  thread target. Top-level DMs do not show that thread-style preview, but can
  still use Slack draft preview posts and edits.

### Legacy key migration

| Channel  | Legacy keys                                                 | Status                                                                                                                                                       |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telegram | `streamMode`, scalar/boolean `streaming`                    | Detected and migrated to `streaming.mode` by doctor/config compatibility paths                                                                               |
| Discord  | `streamMode`, boolean `streaming`                           | Runtime aliases for the `streaming` enum; run `openclaw doctor --fix` to rewrite persisted config                                                            |
| Slack    | `streamMode`; boolean `streaming`; legacy `nativeStreaming` | Runtime aliases for `streaming.mode` (and `streaming.nativeTransport` for the boolean/legacy forms); run `openclaw doctor --fix` to rewrite persisted config |

## Runtime behavior

### Telegram

- Uses `sendMessage` + `editMessageText` preview updates across DMs and
  group/topics; final text edits the active preview in place. Telegram
  ephemeral 30-second "typing" drafts (`sendMessageDraft`) are not used for
  answer streaming.
- Short initial previews are still debounced for push-notification UX, but
  materialize after a bounded delay so active runs do not stay visually silent.
- Long finals reuse the preview message for the first chunk and send only the
  remaining chunks.
- `block` mode rotates the preview into a new message at
  `streaming.preview.chunk.maxChars` (default 800, capped at Telegram's 4096
  edit limit); other modes grow one preview up to 4096 characters.
- `progress` mode keeps tool progress in an editable status draft, materializes
  the status label when answer streaming is active but no tool line is
  available yet, clears the draft at completion, and sends the final answer
  through normal delivery.
- If the final edit fails before the completed text is confirmed, OpenClaw uses
  normal final delivery and cleans up the stale preview.
- Preview streaming is skipped when Telegram block streaming is explicitly
  enabled, to avoid double-streaming.
- `/reasoning stream` can write reasoning to a transient preview that is
  deleted after final delivery.
- Telegram selected quote replies are an exception: when `replyToMode` is not
  `"off"` and selected quote text is present, OpenClaw skips the answer preview
  stream for that turn (the final answer must go through the native quote-reply
  path) so tool-progress preview lines cannot render. Current-message replies
  without selected quote text still keep preview streaming. See
  [Telegram channel docs](/channels/telegram) for details.

### Discord

- Uses send + edit preview messages.
- `block` mode uses draft chunking (`draftChunk`).
- Preview streaming is skipped when Discord block streaming is explicitly
  enabled.
- `progress` mode appends a small `-#` activity receipt (thought/tool-call
  counts and elapsed time) to the final answer and deletes the status draft
  once that answer is delivered, so busy channels keep no orphaned tool log
  above the reply. Error finals keep the draft as the record of the failed
  turn.
- Final media, error, and explicit-reply payloads cancel pending previews
  without flushing a new draft, then use normal delivery.

### Slack

- `partial` can use Slack native streaming (`chat.startStream`/`append`/`stop`)
  when available.
- `block` uses append-style draft previews.
- `progress` uses status preview text, then the final answer.
- Top-level DMs without a reply thread use draft preview posts and edits
  instead of Slack native streaming.
- Native and draft preview streaming suppress block replies for that turn, so a
  Slack reply is streamed by one delivery path only.
- Final media/error payloads and progress finals do not create throwaway draft
  messages; only text/block finals that can edit the preview flush pending
  draft text.

### Mattermost

- In `partial` mode, streams thinking and partial reply text into a single draft
  preview post that finalizes in place when the final answer is safe to send.
- In `progress` mode, streams thinking and tool activity into a single status
  preview that finalizes in place when the final answer is safe to send.
- In `block` mode, rotates between completed text and tool-activity posts;
  parallel and consecutive tool updates share the current tool-activity post.
- Falls back to sending a fresh final post if the preview post was deleted or
  is otherwise unavailable at finalize time.
- Final media/error payloads cancel pending preview updates before normal
  delivery instead of flushing a temporary preview post.

### Matrix

- Draft previews finalize in place when the final text can reuse the preview
  event.
- Media-only, error, and reply-target-mismatch finals cancel pending preview
  updates before normal delivery; an already-visible stale preview is redacted.

## Tool-progress preview updates

Preview streaming can also include **tool-progress** updates: short status
lines like "searching the web", "reading file", or "calling tool" that appear
in the same preview message while tools are running, ahead of the final reply.
In Codex app-server mode, Codex preamble/commentary messages use this same
preview path, so short "I am checking..." progress notes can stream into the
editable draft without becoming part of the final answer. This keeps
multi-step tool turns visually alive instead of silent between the first
thinking preview and the final answer.

Long-running tools may emit typed progress before they return. For example,
`web_fetch` arms a five-second timer when it starts: if the fetch is still
pending, the preview shows `Fetching page content...`; if the fetch finishes or
is canceled before then, no progress line is emitted. The later final tool
result is still delivered normally to the model.

Supported surfaces:

- **Discord**, **Slack**, **Telegram**, and **Matrix** stream tool-progress and
  Codex preamble updates into the live preview edit by default when preview
  streaming is active. Microsoft Teams uses its native progress stream in
  personal chats.
- Telegram has shipped with tool-progress preview updates enabled since
  `v2026.4.22`; keeping them enabled preserves that released behavior.
- **Mattermost** folds tool activity into one preview post in `partial` and
  `progress` modes, or one tool-activity post between text blocks in `block`
  mode (see above).
- Tool-progress edits follow the active preview streaming mode; they are
  skipped when preview streaming is `off` or when block streaming has taken
  over the message. On Telegram, `streaming.mode: "off"` is final-only: generic
  progress chatter is also suppressed instead of delivered as standalone status
  messages, while approval prompts, media payloads, and errors still route
  normally.
- To keep preview streaming but hide tool-progress lines, set
  `streaming.preview.toolProgress` to `false` for that channel (default
  `true`). To keep tool-progress lines visible while hiding command/exec text,
  set `streaming.preview.commandText` to `"status"` or
  `streaming.progress.commandText` to `"status"`; the default is `"raw"` to
  preserve released behavior. This policy is shared by draft/progress channels
  that use OpenClaw's compact progress renderer, including Discord, Matrix,
  Microsoft Teams, Mattermost, Slack draft previews, and Telegram. To disable
  preview edits entirely, set `streaming.mode` to `off`.

## Progress draft rendering

Progress-mode drafts (`streaming.progress.*`) are bounded and configurable per
channel:

| Key                               | Default       | Behavior                                                       |
| --------------------------------- | ------------- | -------------------------------------------------------------- |
| `streaming.progress.maxLines`     | `8`           | Max compact progress lines kept below the draft label          |
| `streaming.progress.maxLineChars` | `120`         | Max characters per compact line before truncation (word-aware) |
| `streaming.progress.label`        | `"auto"`      | Draft title; a custom string, or `false` to hide it            |
| `streaming.progress.labels`       | built-in pool | Candidate labels used when `label: "auto"`                     |

### Commentary progress lane

Beyond tool-progress, the compact progress renderer can surface one more lane
in the draft:

- **`streaming.progress.commentary`** - render the model's pre-tool
  **commentary** (a short "I'll check... then..." narration) interleaved with
  tool lines in the progress draft.

```json
{
  "channels": {
    "discord": {
      "streaming": { "mode": "progress", "progress": { "commentary": true } }
    }
  }
}
```

Keep progress lines visible but hide raw command/exec text:

```json
{
  "channels": {
    "telegram": {
      "streaming": {
        "mode": "partial",
        "preview": {
          "toolProgress": true,
          "commandText": "status"
        }
      }
    }
  }
}
```

Use the same shape under another compact progress channel key, for example
`channels.discord`, `channels.matrix`, `channels.msteams`,
`channels.mattermost`, or Slack draft previews. For progress-draft mode, put
the same policy under `streaming.progress`:

```json
{
  "channels": {
    "telegram": {
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

## Related

- [Message lifecycle refactor](/concepts/message-lifecycle-refactor) - target shared preview, edit, stream, and finalization design
- [Progress drafts](/concepts/progress-drafts) - visible work-in-progress messages that update during long turns
- [Messages](/concepts/messages) - message lifecycle and delivery
- [Retry](/concepts/retry) - retry behavior on delivery failure
- [Channels](/channels) - per-channel streaming support
