---
summary: "CLI reference for `openclaw transcripts` (list, show, and export stored transcripts)"
read_when:
  - You want to read stored transcript summaries from the terminal
  - You need the path to a transcripts markdown summary
  - You are debugging the core transcripts storage layout
title: "Transcripts CLI"
---

# `openclaw transcripts`

Inspector and export command for durable meeting transcripts. Google Meet,
Microsoft Teams, and Zoom browser participants capture notes automatically;
the `transcripts` agent tool also supports provider capture and manual import.

Canonical transcript state lives in the shared SQLite database at
`$OPENCLAW_STATE_DIR/state/openclaw.sqlite`. `show` and `path` explicitly
materialize user-facing artifacts under the state directory:

```text
$OPENCLAW_STATE_DIR/transcripts/YYYY-MM-DD/<session>/
  metadata.json
  transcript.jsonl
  summary.json
  summary.md
```

These files are exports, not a second runtime store. OpenClaw does not read them
back during capture, summarization, or listing. Default state directory is
`~/.openclaw`; override with `OPENCLAW_STATE_DIR`. The date directory comes
from the session start time; the session directory is a filesystem-safe slug
derived from the session id.

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

| Command                       | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| `list`                        | List stored sessions.                                |
| `show <session>`              | Print and materialize `summary.md`.                  |
| `path <session>`              | Materialize and print the `summary.md` path.         |
| `path <session> --dir`        | Materialize all artifacts and print their directory. |
| `path <session> --metadata`   | Materialize and print `metadata.json`.               |
| `path <session> --transcript` | Materialize and print `transcript.jsonl`.            |
| `--json`                      | Print machine-readable output (any subcommand).      |

`<session>` accepts either a bare session id or a date-qualified selector
(`YYYY-MM-DD/<session>`). Use the qualified form when the same session id
occurs on more than one day, for example `openclaw transcripts show
2026-05-22/standup`. Default session ids include a timestamp and random
suffix; give a session a fixed id only when that id is unique within the day.

If the filesystem-safe export name exceeds 255 bytes, OpenClaw shortens it
to a prefix plus a deterministic SHA-256 hash of the complete original session
ID. Only the derived export name and its selector change; the raw session ID,
provider stop handle, and stored notes stay intact. Names that already fit
remain unchanged. Use the selector printed by `list` for the shortened name.
For existing sessions with oversized stored names, run `openclaw doctor --fix`
to repair their derived selectors without changing stored notes.

## Output

`list` prints one tab-separated line per session: selector, start time, title,
summary path.

```text
2026-05-22/standup  2026-05-22T09:00:00.000Z  Weekly standup  /Users/user/.openclaw/transcripts/2026-05-22/standup/summary.md
```

The selector is the safest value to pass back to `show` or `path`.

`list --json` returns objects with `sessionId`, `selector`, `date`, `title`,
`startedAt`, `stoppedAt`, `source`, `path`, `summaryPath`, `hasSummary`.
Stored meeting source URLs contain only the origin and path; query strings,
fragments, and embedded credentials are removed before persistence.

`show --json` returns the stored session metadata, selector, session
directory, summary path, and summary Markdown text.

`path --json` returns the selected path and whether that artifact could be
materialized. Metadata and transcript exports always exist for a stored
session; a summary path reports `exists: false` until the session has a summary.

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

The tool's `status` action lists active capture subscriptions, not historical
notes. When a provider ends or replaces a subscription, OpenClaw records
`stoppedAt` and stores its summary; the transcript remains available to `list`,
`show`, and the tool's `summarize` action. A temporary transport disconnect does
not end a subscription. Stopping historical notes does not stop a newer capture
or change the recorded stop time.

Provider-driven completion stores the summary without exporting files. Explicit
tool stop, import, summarize, and configured auto-start shutdown also attempt to
materialize `summary.md`.
If terminal persistence fails, `status` reports the ended capture under
`pendingFinalization`, separately from active captures. Use the tool's `stop`
action for that session to retry persistence without stopping the provider again.

A session can appear in `list` without a summary while capture is still active,
if a provider failed during stop, or if metadata was stored before any utterances
arrived.

Use `path <session> --transcript` to inspect the raw append-only transcript,
or run the `transcripts` tool's `summarize` action to regenerate the Markdown
summary.

Summaries are saved in SQLite before optional artifact export. If export fails,
the saved summary remains available even when `summary.md` is missing. Configured
auto-start captures log warnings during shutdown for failed exports or provider
stop errors. Correct the export destination problem, then run
`openclaw transcripts path <session>` or `openclaw transcripts show <session>`
to retry the export; an intended path in a warning is not proof of an exported file.

Historical sessions without complete account-owner metadata remain on a local
recovery path. Recover an agent-owned row with a local turn for that agent; a row
with no agent attribution requires a local main-agent turn. Sources without
account binding retain main-agent access across their normal surfaces. Missing
providers, partial owner metadata, and accountless historical sources also stay
on this local recovery path.

```bash
openclaw agent --agent <owning-agent-or-main> --local --message \
  "Use transcripts summarize for session <session>."
```

## Upgrading the legacy file store

OpenClaw releases that predate the SQLite store wrote canonical runtime state
directly beneath `$OPENCLAW_STATE_DIR/transcripts/`. Run:

```bash
openclaw doctor --fix
```

Doctor imports the complete legacy tree into SQLite, verifies row counts and
ordering, records migration receipts, and moves the verified source tree to a
timestamped `transcripts.migrated-*` archive. Runtime commands do not fall back
to the legacy files. Keep the archive until you have verified the imported
sessions and any exports you rely on.

## Configuration

Meeting transcript capture is enabled by default. To opt out globally:

```json
{
  "transcripts": {
    "enabled": false
  }
}
```

- `enabled` (default `true`): enable automatic meeting notes, the transcripts
  tool, and configured auto-start sources. Set it to `false` when meeting
  notes should not be persisted on the host. An explicitly requested meeting
  `transcribe` mode keeps its existing bounded live-caption tail, but does not
  write durable rows while this setting is false.
  Configure auto-start sources with `transcripts.autoStart`. Each entry is
  enabled by being present; omit an entry to disable that source. `discord-voice`
  is the bundled auto-start-capable source and requires `guildId` and
  `channelId`. When exactly one configured Discord account has credentials and
  voice enabled, OpenClaw selects it automatically. When multiple accounts are
  voice-capable, OpenClaw selects a capable `channels.discord.defaultAccount`.
  Otherwise, set `accountId` to the corresponding key under
  `channels.discord.accounts`; an omitted account is rejected as ambiguous:

```json
{
  "transcripts": {
    "enabled": true,
    "autoStart": [
      {
        "providerId": "discord-voice",
        "accountId": "work",
        "guildId": "1234567890",
        "channelId": "2345678901"
      }
    ]
  }
}
```

The meeting provider ids are `google-meet`, `teams`, and `zoom`. Their aliases
are `googlemeet`/`meet`, `teams-meetings`/`microsoft-teams`/`msteams`, and
`zoom-meetings`, respectively. Meeting providers attach to an already-active
meeting bot session; normal meeting joins do not need an `autoStart` entry.
