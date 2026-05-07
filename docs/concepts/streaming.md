---
summary: "Streaming + chunking behavior (block replies, channel preview streaming, mode mapping)"
read_when:
  - Explaining how streaming or chunking works on channels
  - Changing block streaming or channel chunking behavior
  - Debugging duplicate/early block replies or channel preview streaming
title: "Streaming and chunking"
---

OpenClaw has two separate streaming layers:

- **Block streaming (channels):** emit completed **blocks** as the assistant writes. These are normal channel messages (not token deltas).
- **Preview streaming (Telegram/Discord/Slack):** update a temporary **preview message** while generating.

There is **no true token-delta streaming** to channel messages today. Preview streaming is message-based (send + edits/appends).

## Block streaming (channel messages)

Block streaming sends assistant output in coarse chunks as it becomes available.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: model stream events (may be sparse for non-streaming models).
- `chunker`: `EmbeddedBlockChunker` applying min/max bounds + break preference.
- `channel send`: actual outbound messages (block replies).

**Controls:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default off).
- Channel overrides: `*.blockStreaming` (and per-account variants) to force `"on"`/`"off"` per channel.
- `agents.defaults.blockStreamingBreak`: `"text_end"` or `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (merge streamed blocks before send).
- Channel hard cap: `*.textChunkLimit` (e.g., `channels.whatsapp.textChunkLimit`).
- Channel chunk mode: `*.chunkMode` (`length` default, `newline` splits on blank lines (paragraph boundaries) before length chunking).
- Discord soft cap: `channels.discord.maxLinesPerMessage` (default 17) splits tall replies to avoid UI clipping.

**Boundary semantics:**

- `text_end`: stream blocks as soon as chunker emits; flush on each `text_end`.
- `message_end`: wait until assistant message finishes, then flush buffered output.

`message_end` still uses the chunker if the buffered text exceeds `maxChars`, so it can emit multiple chunks at the end.

### Media delivery with block streaming

`MEDIA:` directives are normal delivery metadata. When block streaming sends a
media block early, OpenClaw remembers that delivery for the turn. If the final
assistant payload repeats the same media URL, the final delivery strips the
duplicate media instead of sending the attachment again.

Exact duplicate final payloads are suppressed. If the final payload adds
distinct text around media that was already streamed, OpenClaw still sends the
new text while keeping the media single-delivery. This prevents duplicate voice
notes or files on channels such as Telegram when an agent emits `MEDIA:` during
streaming and the provider also includes it in the completed reply.

## Chunking algorithm (low/high bounds)

Block chunking is implemented by `EmbeddedBlockChunker`:

- **Low bound:** don't emit until buffer >= `minChars` (unless forced).
- **High bound:** prefer splits before `maxChars`; if forced, split at `maxChars`.
- **Break preference:** `paragraph` → `newline` → `sentence` → `whitespace` → hard break.
- **Code fences:** never split inside fences; when forced at `maxChars`, close + reopen the fence to keep Markdown valid.

`maxChars` is clamped to the channel `textChunkLimit`, so you can't exceed per-channel caps.

## Coalescing (merge streamed blocks)

When block streaming is enabled, OpenClaw can **merge consecutive block chunks**
before sending them out. This reduces "single-line spam" while still providing
progressive output.

- Coalescing waits for **idle gaps** (`idleMs`) before flushing.
- Buffers are capped by `maxChars` and will flush if they exceed it.
- `minChars` prevents tiny fragments from sending until enough text accumulates
  (final flush always sends remaining text).
- Joiner is derived from `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space).
- Channel overrides are available via `*.blockStreamingCoalesce` (including per-account configs).
- Default coalesce `minChars` is bumped to 1500 for Signal/Slack/Discord unless overridden.

## Human-like pacing between blocks

When block streaming is enabled, you can add a **randomized pause** between
block replies (after the first block). This makes multi-bubble responses feel
more natural.

- Config: `agents.defaults.humanDelay` (override per agent via `agents.list[].humanDelay`).
- Modes: `off` (default), `natural` (800-2500ms), `custom` (`minMs`/`maxMs`).
- Applies only to **block replies**, not final replies or tool summaries.

## "Stream chunks or everything"

This maps to:

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emit as you go). Non-Telegram channels also need `*.blockStreaming: true`.
- **Stream everything at end:** `blockStreamingBreak: "message_end"` (flush once, possibly multiple chunks if very long).
- **No block streaming:** `blockStreamingDefault: "off"` (only final reply).

**Channel note:** Block streaming is **off unless**
`*.blockStreaming` is explicitly set to `true`. Channels can stream a live preview
(`channels.<channel>.streaming`) without block replies.

Config location reminder: the `blockStreaming*` defaults live under
`agents.defaults`, not the root config.

## Preview streaming modes

Canonical key: `channels.<channel>.streaming`

Modes:

- `off`: disable preview streaming.
- `partial`: single preview that is replaced with latest text.
- `block`: preview updates in chunked/appended steps.
- `progress`: progress/status preview during generation, final answer at completion.

`streaming.mode: "block"` is a preview-streaming mode for edit-capable channels
such as Discord and Telegram. It does not enable channel block delivery there.
Use `streaming.block.enabled` or the legacy `blockStreaming` channel key when
you want normal block replies. Microsoft Teams is the exception: it has no
draft-preview block transport, so `streaming.mode: "block"` maps to Teams block
delivery instead of native partial/progress streaming.

### Channel mapping

| Channel    | `off` | `partial` | `block` | `progress`              |
| ---------- | ----- | --------- | ------- | ----------------------- |
| Telegram   | ✅    | ✅        | ✅      | editable progress draft |
| Discord    | ✅    | ✅        | ✅      | editable progress draft |
| Slack      | ✅    | ✅        | ✅      | ✅                      |
| Mattermost | ✅    | ✅        | ✅      | ✅                      |
| MS Teams   | ✅    | ✅        | ✅      | native progress stream  |

Slack-only:

- `channels.slack.streaming.nativeTransport` toggles Slack native streaming API calls when `channels.slack.streaming.mode="partial"` (default: `true`).
- Slack native streaming and Slack assistant thread status require a reply thread target. Top-level DMs do not show that thread-style preview, but they can still use Slack draft preview posts and edits.

Legacy key migration:

- Telegram: legacy `streamMode` and scalar/boolean `streaming` values are detected and migrated by doctor/config compatibility paths to `streaming.mode`.
- Discord: `streamMode` + boolean `streaming` remain runtime aliases for the `streaming` enum; run `openclaw doctor --fix` to rewrite persisted config.
- Slack: `streamMode` remains a runtime alias for `streaming.mode`; boolean `streaming` remains a runtime alias for `streaming.mode` plus `streaming.nativeTransport`; legacy `nativeStreaming` remains a runtime alias for `streaming.nativeTransport`. Run `openclaw doctor --fix` to rewrite persisted config.

### Runtime behavior

Telegram:

- Uses `sendMessage` + `editMessageText` preview updates across DMs and group/topics.
- Final text edits the active preview in place; long finals reuse that message for the first chunk and send only the remaining chunks.
- `progress` mode keeps tool progress in an editable status draft, clears that draft at completion, and sends the final answer through normal delivery.
- If the final edit fails before the completed text is confirmed, OpenClaw uses normal final delivery and cleans up the stale preview.
- Preview streaming is skipped when Telegram block streaming is explicitly enabled (to avoid double-streaming).
- `/reasoning stream` can write reasoning to a transient preview that is deleted after final delivery.

Discord:

- Uses send + edit preview messages.
- `block` mode uses draft chunking (`draftChunk`).
- Preview streaming is skipped when Discord block streaming is explicitly enabled.
- Final media, error, and explicit-reply payloads cancel pending previews without flushing a new draft, then use normal delivery.

Slack:

- `partial` can use Slack native streaming (`chat.startStream`/`append`/`stop`) when available.
- `block` uses append-style draft previews.
- `progress` uses status preview text, then final answer.
- Top-level DMs without a reply thread use draft preview posts and edits instead of Slack native streaming.
- Native and draft preview streaming suppress block replies for that turn, so a Slack reply is streamed by one delivery path only.
- Final media/error payloads and progress finals do not create throwaway draft messages; only text/block finals that can edit the preview flush pending draft text.

Mattermost:

- Streams thinking, tool activity, and partial reply text into a single draft preview post that finalizes in place when the final answer is safe to send.
- Falls back to sending a fresh final post if the preview post was deleted or is otherwise unavailable at finalize time.
- Final media/error payloads cancel pending preview updates before normal delivery instead of flushing a temporary preview post.

Matrix:

- Draft previews finalize in place when the final text can reuse the preview event.
- Media-only, error, and reply-target-mismatch finals cancel pending preview updates before normal delivery; an already-visible stale preview is redacted.

### Tool-progress preview updates

Preview streaming can also include **tool-progress** updates - short status lines like "searching the web", "reading file", or "calling tool" - that appear in the same preview message while tools are running, ahead of the final reply. This keeps multi-step tool turns visually alive rather than silent between the first thinking preview and the final answer.

Supported surfaces:

- **Discord**, **Slack**, **Telegram**, and **Matrix** stream tool-progress into the live preview edit by default when preview streaming is active. Microsoft Teams uses its native progress stream in personal chats.
- Telegram has shipped with tool-progress preview updates enabled since `v2026.4.22`; keeping them enabled preserves that released behavior.
- **Mattermost** already folds tool activity into its single draft preview post (see above).
- Tool-progress edits follow the active preview streaming mode; they are skipped when preview streaming is `off` or when block streaming has taken over the message. On Telegram, `streaming.mode: "off"` is final-only: generic progress chatter is also suppressed instead of being delivered as standalone status messages, while approval prompts, media payloads, and errors still route normally.
- To keep preview streaming but hide tool-progress lines, set `streaming.preview.toolProgress` to `false` for that channel. To keep tool-progress lines visible while hiding command/exec text, set `streaming.preview.commandText` to `"status"` or `streaming.progress.commandText` to `"status"`; the default is `"raw"` to preserve released behavior. This policy is shared by draft/progress channels that use OpenClaw's compact progress renderer, including Discord, Matrix, Microsoft Teams, Mattermost, Slack draft previews, and Telegram. To disable preview edits entirely, set `streaming.mode` to `off`.
- Telegram selected quote replies are an exception: when `replyToMode` is not `"off"` and selected quote text is present, OpenClaw skips the answer preview stream for that turn so tool-progress preview lines cannot render. Current-message replies without selected quote text still keep preview streaming. See [Telegram channel docs](/channels/telegram) for details.

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

Use the same shape under another compact progress channel key, for example `channels.discord`, `channels.matrix`, `channels.msteams`, `channels.mattermost`, or Slack draft previews. For progress-draft mode, put the same policy under `streaming.progress`:

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
