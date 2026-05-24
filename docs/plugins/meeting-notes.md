---
summary: "Meeting Notes plugin: capture transcripts from Discord voice and imported meeting sources, then write summaries"
read_when:
  - You want OpenClaw to take meeting notes
  - You are wiring Discord voice, Google Meet, Slack huddles, or another meeting source into notes
  - You need the meeting_notes tool contract
title: "Meeting Notes plugin"
---

The Meeting Notes plugin is the generic notes layer for live calls and imported
meeting transcripts. It owns transcript storage, summary rendering, and the
`meeting_notes` tool. Channel plugins own capture, authentication, and
platform-specific meeting joins.

Use this page when you want OpenClaw to capture Discord voice notes today, when
you want to import a transcript from another meeting system, or when you are
building a Google Meet, Slack huddle, Zoom, or calendar-owned source provider.

## Source model

Meeting sources register `meetingNotesSourceProviders` through the plugin SDK.
The first live provider is `discord-voice`; the built-in `manual-transcript`
provider imports post-meeting transcripts.

- `live-audio`: source joins or listens to a call and streams final utterances.
- `live-caption`: source reads captions from a browser or meeting surface.
- `posthoc-transcript`: source imports a transcript or notes artifact after the meeting.
- `recording-stt`: source transcribes a recording before importing utterances.

This keeps Discord, Google Meet, Slack huddles, and future meeting surfaces out
of the notes engine. Each source supplies speaker-labeled utterances; Meeting
Notes writes the artifacts and summary.

## Install and enable

Meeting Notes is an external source plugin in this repository. It is not part of
the core OpenClaw npm package and becomes available only when the plugin is
installed as a plugin or loaded from a source checkout that contains
`extensions/meeting-notes`.

Once the plugin is loaded, it is enabled by default unless one of these settings
blocks it:

- `plugins.enabled: false` disables all plugins.
- `plugins.deny` contains `meeting-notes`.
- `plugins.allow` is set and does not contain `meeting-notes`.
- `plugins.entries.meeting-notes.enabled: false` disables this plugin entry.
- `plugins.entries.meeting-notes.config.enabled: false` keeps the plugin loaded
  but disables the `meeting_notes` tool and auto-start service.

The normal user config file is `~/.openclaw/openclaw.json`. The `plugins`
section controls plugin loading, and the nested `entries.<pluginId>.config`
object is passed to that plugin as plugin-specific config. A separate
`config: { ... }` block under `meeting-notes` is expected; it is how plugins
receive their own options without adding core config keys.

Use this shape when your config has a plugin allowlist:

```json5
{
  plugins: {
    allow: ["discord", "meeting-notes"],
    entries: {
      "meeting-notes": {
        enabled: true,
        config: {
          enabled: true,
          maxUtterances: 2000,
          autoStart: [],
        },
      },
    },
  },
}
```

Run a config check after editing:

```bash
openclaw config validate
```

Gateway config hot reload applies plugin allowlist and plugin-entry changes.
Restart the Gateway if you are also changing the source plugin itself, installing
new plugin files, or changing Discord voice credentials.

## Configuration

Meeting Notes has three plugin config fields:

- `enabled`: `true` by default. Set `false` to leave the plugin installed but
  disable the tool and auto-start service.
- `maxUtterances`: `2000` by default. Summary generation reads only the newest
  N utterances from `transcript.jsonl`; valid values are clamped to `1` through
  `10000`.
- `autoStart`: empty by default. Each entry starts a live notes source when the
  Gateway starts or reloads the plugin.

An `autoStart` entry accepts:

- `providerId`: required. Use `discord-voice` for Discord voice.
- `enabled`: optional, default `true`. Set `false` to keep an entry without
  starting it.
- `sessionId`: optional. If omitted, OpenClaw generates a timestamped id.
- `title`: optional human-readable title for summaries and CLI output.
- `accountId`: optional source account id when more than one account exists.
- `guildId`: provider-specific Discord guild id.
- `channelId`: provider-specific Discord voice channel id.
- `meetingUrl`: provider-specific meeting URL for browser or calendar sources.

Use `autoStart` when OpenClaw should begin notes capture automatically on
gateway startup:

```json5
{
  plugins: {
    entries: {
      "meeting-notes": {
        config: {
          autoStart: [
            {
              providerId: "discord-voice",
              guildId: "123",
              channelId: "456",
              title: "Weekly planning",
            },
          ],
        },
      },
    },
  },
}
```

Auto-start retries startup failures up to 12 times with a five-second delay.
This lets the notes service wait for channel plugins such as Discord to finish
initializing. Sessions that were started by auto-start are stopped and summarized
when the plugin service stops cleanly.

Discord voice capture still needs normal Discord voice setup and permissions.
See [Discord voice](/channels/discord#voice-mode).

## Discord voice

Discord is the first live source. The Discord plugin owns the voice connection,
speaker detection, audio decoding, and transcription. Meeting Notes receives
final speaker-labeled utterances and persists them.

For Discord live capture:

- Enable and configure the Discord plugin first.
- Configure Discord voice mode so OpenClaw can join the target voice channel.
- Use `providerId: "discord-voice"`.
- Provide `guildId` and `channelId`.
- Add `accountId` only when you run more than one Discord account.

The transcription model is not chosen by Meeting Notes. In Discord `stt-tts`
voice mode, STT uses `tools.media.audio`; `voice.model` controls the agent reply
model, not transcription. In realtime voice modes, transcription follows the
configured realtime provider and model. See [Discord voice](/channels/discord#voice-mode)
for the current Discord voice model and provider knobs.

## Google Meet, Slack huddles, and other sources

Meeting Notes is intentionally source-neutral. Google Meet, Slack huddles, Zoom,
calendar recordings, or browser caption capture should be separate source
providers that register with the plugin SDK.

Recommended source choices:

- Google Meet live browser/caption support: implement a `live-caption` provider
  that accepts `meetingUrl` and emits final caption utterances.
- Google Meet recordings or downloaded transcripts: implement
  `posthoc-transcript` or use `manual-transcript` until a provider exists.
- Slack huddles today: import post-meeting huddle notes or transcript artifacts.
  Slack does not expose a general bot-join live huddle audio API.
- Slack huddles later: keep the Slack-owned source provider responsible for
  Slack auth, artifact lookup, and transcript normalization.

The notes engine should not contain platform joins, browser automation, Slack
API polling, or Discord voice logic. Those belong to the owning source plugin.

## Tool

Use `meeting_notes` with an `action`:

- `status`: list registered providers and active sessions.
- `start`: start a live notes session.
- `stop`: stop a live session and write `summary.md`.
- `import`: import a transcript and write `summary.md`.
- `summarize`: regenerate a summary for an existing session.

Discord live notes require `providerId: "discord-voice"`, plus `guildId` and
`channelId`. `accountId` is optional when only one Discord account is active.

```json
{
  "action": "start",
  "providerId": "discord-voice",
  "guildId": "123",
  "channelId": "456",
  "title": "Weekly planning"
}
```

Stop by session id:

```json
{
  "action": "stop",
  "sessionId": "meeting-2026-05-22T10-00-00-000Z-a1b2c3d4"
}
```

Import a transcript:

```json
{
  "action": "import",
  "providerId": "manual-transcript",
  "title": "Design review",
  "transcript": "Alex: We decided to ship the Discord source first.\nSam: Action item: add Slack huddle import later."
}
```

`manual-transcript` splits plain transcript text into utterances. Use it for
copied Google Meet notes, Slack huddle summaries, calendar transcripts, or any
source that already produced text.

## Storage layout

Artifacts are stored under the OpenClaw state directory:

```text
$OPENCLAW_STATE_DIR/meeting-notes/YYYY-MM-DD/<session>/
  metadata.json
  transcript.jsonl
  summary.json
  summary.md
```

If `OPENCLAW_STATE_DIR` is unset, the default state directory is
`~/.openclaw`. A normal local install therefore writes notes under
`~/.openclaw/meeting-notes/...`.

Each file has one job:

- `metadata.json`: session id, source provider, title, start time, stop time,
  and provider metadata.
- `transcript.jsonl`: append-only speaker utterances. Each line is one JSON
  object with the utterance text and the session id.
- `summary.json`: structured summary data used by tooling, including the
  speaker-labeled transcript window used for the generated summary.
- `summary.md`: human-readable notes for terminals, editors, and document
  workflows, including a speaker-labeled transcript section.

The date directory comes from the session start time, so multiple meetings per
day stay grouped. If a human session id repeats across days, use the
date-qualified selector from `openclaw meeting-notes list`, such as
`2026-05-22/standup`.

By default, OpenClaw generates timestamped session ids:

```text
meeting-2026-05-22T10-00-00-000Z-a1b2c3d4
```

That means ten meetings on the same day become ten sibling directories:

```text
~/.openclaw/meeting-notes/2026-05-22/
  meeting-2026-05-22T09-00-00-000Z-a1b2c3d4/
  meeting-2026-05-22T10-30-00-000Z-b2c3d4e5/
  meeting-2026-05-22T13-00-00-000Z-c3d4e5f6/
```

Configure `sessionId` only when that id is unique for the day. Human ids such as
`standup` are fine for one recurring meeting per day. If the same id appears on
multiple days, use the date-qualified selector in the CLI.

## CLI access

Use the read-only CLI to find or print stored summaries:

```bash
openclaw meeting-notes list
openclaw meeting-notes show <session>
openclaw meeting-notes path <session>
openclaw meeting-notes path <session> --transcript
```

See [Meeting Notes CLI](/cli/meeting-notes) for the full command reference.

## Long meetings

For long meetings, utterances are appended to `transcript.jsonl` as they arrive.
Summary generation reads a bounded window controlled by
`plugins.entries.meeting-notes.config.maxUtterances` (default: `2000`) so a
multi-hour call does not require unbounded summary memory.

This means the transcript can keep growing on disk, while summarization stays
bounded. Increase `maxUtterances` when you need more of a multi-hour meeting in
the generated summary and speaker-labeled transcript section. Decrease it when
summaries are too slow or too large.

Current summaries are generated when a session stops, after an import, or when
the `summarize` action runs. They are not continuously rewritten for every
utterance.

## Troubleshooting

### `meeting_notes` is missing

Check that the plugin is installed or loaded from source, and that plugin
loading does not exclude it:

```bash
openclaw config validate
openclaw meeting-notes list
```

If `plugins.allow` is set, it must include `meeting-notes`. If `plugins.deny`
contains `meeting-notes`, remove it.

### Auto-start does not join Discord

Confirm the `autoStart` entry uses `providerId: "discord-voice"` and includes
both `guildId` and `channelId`. If you run multiple Discord accounts, include
`accountId`. Also verify Discord voice works outside Meeting Notes by joining
the same voice channel through the Discord voice commands.

### Summary is missing

Live sessions write `summary.md` when stopped. Stop the session with
`meeting_notes` action `stop`, then inspect it:

```bash
openclaw meeting-notes list
openclaw meeting-notes path <session>
```

Use `meeting_notes` action `summarize` to regenerate `summary.md` for an
existing stored session.

### Selector is ambiguous

If you reused a human session id such as `standup`, use the date-qualified
selector shown by `openclaw meeting-notes list`:

```bash
openclaw meeting-notes show 2026-05-22/standup
```

## Related

- [Meeting Notes CLI](/cli/meeting-notes)
- [Discord voice](/channels/discord#voice-mode)
- [Plugin management](/tools/plugin)
- [Plugin architecture](/plugins/architecture)
