---
summary: "Audio clips, inbound file handling, chunking, and delivery targets"
read_when:
  - Sending voice clips or files to OpenClaw in Slack
  - Raising or lowering the Slack media size cap
  - Debugging a Slack attachment that was skipped
title: "Slack media and attachments"
sidebarTitle: "Media and attachments"
---

How Slack files reach the agent turn, and how OpenClaw sends text and media back.

## Voice input

To speak to OpenClaw in Slack today, send a Slack audio clip to the OpenClaw app. Slackbot's dictation microphone is a separate Slack-owned feature, not an app API.

- **[Slackbot voice dictation](https://slack.com/help/articles/202026038-How-to-use-Slackbot)** lives inside the user's private Slackbot conversation. Slack turns the recording into a Slackbot prompt but does not emit an audio file, dictation event, prompt, or input-source marker to third-party Slack apps through the Events API. The OpenClaw Slack plugin cannot enable or receive it.
- **[Slack audio clips](https://slack.com/help/articles/4406235165587-Record-audio-and-video-clips-in-Slack)** are stored Slack files that can be posted in an OpenClaw DM, channel, or thread. OpenClaw downloads an accessible clip with the bot token, normalizes Slack's clip MIME metadata, and sends it through the shared [audio transcription pipeline](/nodes/audio). The recommended app manifest includes the required `files:read` scope.

Audio clips and Slackbot dictation have different privacy semantics: clips follow Slack file-retention policy and OpenClaw downloads them for transcription, while Slack says dictation audio is not stored.

In a channel with `requireMention: true`, a captionless audio clip can satisfy the gate by speaking a configured mention pattern (`agents.entries.*.groupChat.mentionPatterns`, falling back to `messages.groupChat.mentionPatterns`). OpenClaw authorizes the sender before downloading or transcribing the clip, then admits it only when the transcript matches. A failed or nonmatching speculative transcript is discarded with the downloaded clip; it is not retained in channel history. Native Slack `@bot` identity cannot be inferred from speech, so configure a spoken-name pattern or include a typed mention. If transcript echoing is enabled, the echo is sent only after admission.

## Media, chunking, and delivery

<AccordionGroup>
  <Accordion title="Inbound attachments">
    Slack file attachments are downloaded from Slack-hosted private URLs (token-authenticated request flow) and written to the media store when fetch succeeds and size limits permit. File placeholders include the Slack `fileId` so agents can fetch the original file with `download-file`.

    Downloads use bounded idle and total timeouts. If Slack file retrieval stalls or fails, OpenClaw keeps processing the message and falls back to the file placeholder.

    Runtime inbound size cap defaults to `20MB` unless overridden by `channels.slack.mediaMaxMb`.

  </Accordion>

  <Accordion title="Outbound text and files">
    - text chunks use `channels.slack.textChunkLimit` (default `8000`, capped at Slack's own message-length limit)
    - `channels.slack.streaming.chunkMode="newline"` enables paragraph-first splitting
    - file sends use Slack upload APIs and can include thread replies (`thread_ts`)
    - long file captions use the first Slack-safe text chunk as the upload comment and send remaining chunks as follow-up messages
    - outbound media cap follows `channels.slack.mediaMaxMb` when configured; otherwise channel sends use MIME-kind defaults from media pipeline

    Native Block Kit sections retain all fields even when their combined accessibility text exceeds the preferred text chunk size. Slack's block limits and the 40,000-character message text hard limit still apply.

  </Accordion>

  <Accordion title="Delivery targets">
    Preferred explicit targets:

    - `user:<id>` for DMs
    - `channel:<id>` for channels

    Text/block-only Slack DMs can post directly to user IDs; file uploads and threaded sends open the DM via Slack conversation APIs first because those paths require a concrete conversation ID.

  </Accordion>
</AccordionGroup>

## Attachment media reference

Slack can attach downloaded media to the agent turn when Slack file downloads succeed and size limits permit. Audio clips can be transcribed, image files can pass through the media-understanding path or directly to a vision-capable reply model, and other files remain available as downloadable file context.

### Supported media types

| Media type                     | Source               | Current behavior                                                                  | Notes                                                                     |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Slack audio clips              | Slack file URL       | Downloaded and routed through shared audio transcription                          | Requires `files:read` and a working `tools.media.audio` model or CLI      |
| JPEG / PNG / GIF / WebP images | Slack file URL       | Downloaded and attached to the turn for vision-capable handling                   | Per-file cap: `channels.slack.mediaMaxMb` (default 20 MB)                 |
| PDF files                      | Slack file URL       | Downloaded and exposed as file context for tools such as `download-file` or `pdf` | Slack inbound does not convert PDFs into image-vision input automatically |
| Other files                    | Slack file URL       | Downloaded when possible and exposed as file context                              | Binary files are not treated as image input                               |
| Thread replies                 | Thread starter files | Root-message files can be hydrated as context when the reply has no direct media  | File-only starters use an attachment placeholder                          |
| Multi-file messages            | Multiple Slack files | Each file is evaluated independently                                              | Slack processing is capped at eight files per message                     |

### Inbound pipeline

When a Slack message with file attachments arrives:

1. OpenClaw downloads the file from Slack's private URL using the bot token.
2. The file is written to the media store on success.
3. Downloaded media paths and content types are added to the inbound context.
4. Audio clips are routed to the shared transcription pipeline; image-capable model/tool paths can use image attachments from the same context.
5. Other files remain available as file metadata or media references for tools that can handle them.

### Thread-root attachment inheritance

When a message arrives in a thread (has a `thread_ts` parent):

- If the reply itself has no direct media and the included root message has files, Slack can hydrate the root files as thread-starter context.
- Root files are hydrated only while seeding a new or reset thread session. Later text-only replies reuse the existing session context and do not reattach root files as fresh media.
- Direct reply attachments take precedence over root-message attachments.
- A root message that has only files and no text is represented with an attachment placeholder so the fallback can still include its files.

### Multi-attachment handling

When a single Slack message contains multiple file attachments:

- Each attachment is processed independently through the media pipeline.
- Downloaded media references are aggregated into the message context.
- Processing order follows Slack's file order in the event payload.
- A failure in one attachment's download does not block others.
- Failed or blocked files remain in the agent context with a bounded reason, and each failed file produces one warning after any URL refresh retry.
- Files beyond the eight-file limit are not downloaded. Their references carry an `omitted: 8-file limit` reason. Long unavailable-file lists are visibly truncated, while the notice retains the total unavailable attachment count.

### Size, download, and model limits

- **Size cap**: Default 20 MB per file. Configurable via `channels.slack.mediaMaxMb`.
- **Audio transcription cap**: the selected audio-capable `tools.media.models[]` entry's `maxBytes` also applies when the downloaded file is sent to a transcription provider or CLI.
- **Download failures**: Files that Slack cannot serve, expired URLs, inaccessible files, oversize files, and Slack auth/login HTML responses are skipped instead of being reported as unsupported formats.
- **Vision model**: Image analysis uses the active reply model when it supports vision, or the image model configured at `agents.defaults.imageModel`.

### Known limits

| Scenario                                      | Current behavior                                                                   | Workaround                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Expired Slack file URL                        | File skipped; no error shown                                                       | Re-upload the file in Slack                                                   |
| Audio transcription unavailable               | Clip remains attached but no transcript is produced                                | Configure `tools.media.audio` or install a supported local transcription CLI  |
| Captionless clip does not pass a mention gate | Dropped after private speculative transcription; transcript and download discarded | Configure a spoken-name mention pattern, add a typed bot mention, or use a DM |
| Vision model not configured                   | Image attachments are stored as media references, but not analyzed as images       | Configure `agents.defaults.imageModel` or use a vision-capable reply model    |
| Very large images (> 20 MB by default)        | Skipped per size cap                                                               | Increase `channels.slack.mediaMaxMb` if Slack allows                          |
| Forwarded/shared attachments                  | Text and Slack-hosted image/file media are best-effort                             | Re-share directly in the OpenClaw thread                                      |
| PDF attachments                               | Stored as file/media context, not automatically routed through image vision        | Use `download-file` for file metadata or the `pdf` tool for PDF analysis      |

### Related documentation

- [Media understanding pipeline](/nodes/media-understanding)
- [Audio and voice notes](/nodes/audio)
- [PDF tool](/tools/pdf)
