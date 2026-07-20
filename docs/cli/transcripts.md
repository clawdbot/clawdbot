---
summary: "CLI reference for `openclaw transcripts` (list, show, and locate stored transcripts)"
read_when:
  - You want to read stored transcript summaries from the terminal
  - You need the path to a transcripts markdown summary
  - You are debugging the core transcripts storage layout
title: "Transcripts CLI"
---

# `openclaw transcripts`

Read-only inspector for transcripts written by the `transcripts` agent tool.
Capture, import, and summarization run through that tool, not this CLI.

Artifacts live under the state directory:

```text
$OPENCLAW_STATE_DIR/transcripts/YYYY-MM-DD/<session>/
  metadata.json
  transcript.jsonl
  summary.json
  summary.md
```

Default state directory is `~/.openclaw`; override with `OPENCLAW_STATE_DIR`.
The date directory comes from the session start time; the session directory is
a filesystem-safe slug derived from the session id.

## Commands

```bash
openclaw transcripts list
openclaw transcripts show <session>
openclaw transcripts show YYYY-MM-DD/<session>
openclaw transcripts path <session>
openclaw transcripts path YYYY-MM-DD/<session>
openclaw transcripts path <session> --dir
openclaw transcripts path <session> --metadata
openclaw transcripts path <session> --transcript
openclaw transcripts list --json
openclaw transcripts show <session> --json
openclaw transcripts path <session> --json
```

| Command                       | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| `list`                        | List stored sessions.                           |
| `show <session>`              | Print the stored `summary.md`.                  |
| `path <session>`              | Print the `summary.md` path.                    |
| `path <session> --dir`        | Print the session directory.                    |
| `path <session> --metadata`   | Print `metadata.json`.                          |
| `path <session> --transcript` | Print `transcript.jsonl`.                       |
| `--json`                      | Print machine-readable output (any subcommand). |

`<session>` accepts either a bare session id or a date-qualified selector
(`YYYY-MM-DD/<session>`). Use the qualified form when the same session id
occurs on more than one day, for example `openclaw transcripts show
2026-05-22/standup`. Default session ids include a timestamp and random
suffix; give a session a fixed id only when that id is unique within the day.

## Output

`list` prints one tab-separated line per session: selector, start time, title,
summary path.

```text
2026-05-22/standup  2026-05-22T09:00:00.000Z  Weekly standup  /Users/user/.openclaw/transcripts/2026-05-22/standup/summary.md
```

The selector is the safest value to pass back to `show` or `path`.

`list --json` returns objects with `sessionId`, `selector`, `date`, `title`,
`startedAt`, `stoppedAt`, `source`, `path`, `summaryPath`, `hasSummary`.

`show --json` returns the stored session metadata, selector, session
directory, summary path, and summary Markdown text.

`path --json` returns the selected path and whether that file exists.

## Many sessions per day

Sessions group by date, then by session id. Ten meetings on one day become
ten sibling folders:

```text
~/.openclaw/transcripts/2026-05-22/
  transcript-2026-05-22T09-00-00-000Z-a1b2c3d4/
  transcript-2026-05-22T10-30-00-000Z-b2c3d4e5/
  standup/
```

Use default generated ids for automation. Use a fixed id like `standup` only
when it will not repeat on the same date.

## Missing summaries

Live sessions write `summary.md` when the session stops; imported transcripts
write it immediately after import. A session can appear in `list` without a
summary while capture is still active, if a provider failed during stop, or if
metadata was written before any utterances arrived.

Use `path <session> --transcript` to inspect the raw append-only transcript,
or run the `transcripts` tool's `summarize` action to regenerate the Markdown
summary.

## Configuration

Capture is opt-in (live sources can join and record meeting audio). Enable it
with:

```json
{
  "transcripts": {
    "enabled": true
  }
}
```

- `enabled` (default `false`): turn the tool on.
  Configure auto-start sources with `transcripts.autoStart`. Each entry is
  enabled by being present; omit an entry to disable that source. `discord-voice`
  is the bundled auto-start-capable source and requires `guildId` and
  `channelId`:

```json
{
  "transcripts": {
    "enabled": true,
    "autoStart": [
      {
        "providerId": "discord-voice",
        "guildId": "1234567890",
        "channelId": "2345678901"
      }
    ]
  }
}
```
