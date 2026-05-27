---
summary: "CLI reference for `openclaw transcripts` (list, show, and locate stored transcripts)"
read_when:
  - You want to read stored transcript summaries from the terminal
  - You need the path to a transcripts markdown summary
  - You are debugging the core transcripts storage layout
title: "Transcripts CLI"
---

# `openclaw transcripts`

Inspect transcripts written by OpenClaw's core `transcripts` tool. This CLI is
read-only; capture, import, and summarization are owned by the agent tool and
configured auto-start sources.

Use the CLI when you want to find yesterday's notes, open the Markdown file in
an editor, feed a transcript to another tool, or debug where a session landed on
disk. It does not start or stop capture.

Artifacts live under the OpenClaw state directory:

```text
$OPENCLAW_STATE_DIR/transcripts/YYYY-MM-DD/<session>/
  metadata.json
  transcript.jsonl
  summary.json
  summary.md
```

The default state directory is `~/.openclaw`; set `OPENCLAW_STATE_DIR` to use a
different one. The date directory comes from the session start time, and the
session directory is a safe filesystem segment derived from the session id.

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

- `list`: list stored sessions, date-qualified selector, start time, title, and `summary.md` path.
- `show <session>`: print the stored `summary.md`.
- `path <session>`: print the `summary.md` path.
- `path <session> --dir`: print the session directory.
- `path <session> --metadata`: print `metadata.json`.
- `path <session> --transcript`: print `transcript.jsonl`.
- `--json`: print machine-readable output.

When a human session id repeats across days, use the date-qualified selector
from `list`, for example `openclaw transcripts show 2026-05-22/standup`.
Default session ids include a timestamp and random suffix; configure fixed
session ids only when they are unique within the day.

## Output

`list` prints one session per line:

```text
2026-05-22/standup  2026-05-22T09:00:00.000Z  Weekly standup  /Users/alex/.openclaw/transcripts/2026-05-22/standup/summary.md
```

The output is tab-separated. The columns are selector, start time, title, and
summary path. The selector is the safest value to pass back to `show` or `path`.

`list --json` prints objects with:

- `sessionId`
- `selector`
- `date`
- `title`
- `startedAt`
- `stoppedAt`
- `source`
- `path`
- `summaryPath`
- `hasSummary`

`show --json` returns the stored session metadata, selector, session directory,
summary path, and summary Markdown text. `path --json` returns the selected path
and whether that file exists.

## Many meetings per day

Transcripts groups sessions by date, then by session id. Ten meetings on one
day become ten sibling folders:

```text
~/.openclaw/transcripts/2026-05-22/
  transcript-2026-05-22T09-00-00-000Z-a1b2c3d4/
  transcript-2026-05-22T10-30-00-000Z-b2c3d4e5/
  standup/
```

Use default generated ids for most automation. Use a fixed id such as `standup`
only when the same id will not be used twice on the same date.

## Missing summaries

Live sessions write `summary.md` when the session stops. Imported transcripts
write `summary.md` immediately after import. A session can still appear in
`list` without a summary when capture is active, a provider failed during stop,
or metadata was written before any utterances arrived.

Use `path <session> --transcript` to inspect the append-only transcript, and use
the `transcripts` tool action `summarize` to regenerate the Markdown summary.

## Configuration

Transcript capture is opt-in because live sources can join and record meeting
audio. Enable the tool with top-level `transcripts.enabled`:

```json
{
  "transcripts": {
    "enabled": true,
    "maxUtterances": 2000
  }
}
```

Configure auto-start sources with `transcripts.autoStart` in `openclaw.json`.
Each entry is enabled by being present; omit an entry to disable that source.

```json
{
  "transcripts": {
    "enabled": true,
    "autoStart": [
      {
        "providerId": "discord-voice",
        "guildId": "1234567890",
        "channelId": "2345678901"
      },
      {
        "providerId": "slack-huddle",
        "accountId": "workspace",
        "channelId": "C123"
      }
    ]
  }
}
```
