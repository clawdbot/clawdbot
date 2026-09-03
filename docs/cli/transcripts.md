---
summary: "CLI reference for `openclaw transcripts` (list, show, and export stored transcripts)"
read_when:
  - You want to read stored transcript summaries from the terminal
  - You need the path to a transcripts markdown summary
  - You are debugging the core transcripts storage layout
  - You want an agent or the Control UI to read past meeting notes
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

Use the selector printed by `list` to address an exact capture. An existing
canonical selector takes priority over a raw session ID with the same text.
Otherwise, `show` and `path` accept `YYYY-MM-DD/<raw-session-id>`, keeping the
entire suffix literal, including punctuation and slashes. For example:

```bash
openclaw transcripts show '2026-05-22/notes: room/one'
```

If neither qualified form finds a capture, the complete input is matched as a
literal raw session ID or export slug, case-sensitively. A date-like prefix in
a raw ID does not prevent this lookup. Multiple matches require a dated
selector; no raw ID is sanitized to choose a capture. Default session IDs
include a timestamp and random suffix; give a session a fixed ID only when
that ID is unique within the day.

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

## Tool selectors

### Reading notes from any session

Ask an agent to list past meetings and read their notes with the `transcripts`
tool. Reads are not tied to the agent session that captured the meeting.
Operator callers can read all meetings on the Gateway. Channel callers can read
only meetings allowed by the source provider; Discord voice reads remain within
the caller's guild. These read permissions do not change capture or summary
write permissions.

```json validate=false
{ "action": "list", "limit": 20 }
```

`list` returns newest meetings first, with a selector, start time, title or
provider name, utterance count, and participants. `limit` defaults to 20 and
accepts integers from 1 to 50. The text is bounded; structured results are in
`details.sessions`.

```json validate=false
{ "action": "show", "selector": "2026-05-22/notes-room-one" }
```

`show` returns the stored notes Markdown and session details. Its text is capped
at 12,000 characters; a truncation marker points to
`openclaw transcripts show <selector>` for the full notes. A capture without a
summary reports that notes are not available yet, including whether it is active.
Reading notes does not regenerate the summary or export artifacts.

### Selecting a capture

The `transcripts` tool returns both the unchanged raw `sessionId` and a canonical
`selector` from start, import, stop, and summarize. Authorized `status` results
include selectors for active captures and entries awaiting finalization. Its
model-facing text shows up to three complete selectors, prioritizing captures
awaiting finalization and reporting any omitted count. Structured status details
retain the full authorized list. Prefer `selector` for subsequent show, stop,
or summarize calls:

```json validate=false
{ "action": "summarize", "selector": "2026-05-22/notes-room-one" }
```

Show, stop, and summarize require exactly one of `selector` or `sessionId`. Other
actions reject `selector`; start and import continue to accept raw IDs through
`sessionId`. Explicit `selector` input accepts canonical selectors and the
historical date/raw-ID form above, but never falls back to the whole input as a
raw ID.

Legacy `sessionId` input considers qualified and raw/slug meanings together. If
they identify different captures, the tool reports ambiguity without listing
candidate details. This stays ambiguous after a capture ends. Use a selector
returned by start, import, or authorized list/status, or inspect `openclaw transcripts
list` locally and pass the desired value in the `selector` field. Both sides of
a raw-ID/selector collision remain addressable by their own canonical selector.

Without a conflicting qualified meaning or a different raw-ID/slug candidate,
legacy `sessionId` selects the current exact raw-ID capture for stop and
summarize, even when historical captures reuse that ID. With no current capture,
repeated historical IDs require a dated selector. An explicit selector for an
older capture does not stop its newer same-ID sibling.

`show` selects and authorizes the durable capture, using live state only to report
whether capture is active. Repeated historical IDs require a dated selector even
when one capture is active.

## Gateway and Control UI reads

Open **Meetings** in the [Control UI](/web/control-ui#meetings-page) to browse
captured meetings and notes without a terminal. The page and other Gateway
clients use two read-only RPC methods:

| Method             | Parameters                                            | Result                                                                                                                                                    |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcripts.list` | Optional `limit` (1–200, default 50) and `providerId` | Newest-first `sessions`, including participants, utterance counts, active state, summary availability, and an overview preview of at most 280 characters. |
| `transcripts.get`  | Required `selector`; optional `includeUtterances`     | One `session`, stored `summary` and its Markdown when available, and optional bounded `utterances`.                                                       |

Both methods require `operator.read` and expose meetings across one trusted
Gateway domain, not just the current agent or chat session. Use separate Gateway
domains when readers need isolation. Source locators contain only `providerId`,
`accountId`, `guildId`, `channelId`, and `meetingUrl` when present, never arbitrary
capture metadata. See [Gateway protocol](/gateway/protocol).

The stored summary Markdown is the canonical notes text, matching the CLI's
`show` output. RPC reads do not materialize files. Utterances are omitted unless
requested and bounded by the capture limit of 2,000; each utterance text is also
sanitized and bounded. Summary participants and model/heuristic provenance are
shown when available; older summaries need not contain them.

## JSON output

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

Meeting notes use the owning agent's utility model first, then its primary model
when needed. If no model is available, a request times out, or the model returns
invalid output, OpenClaw saves deterministic heuristic notes instead. Model
generation enhances the notes; it does not gate saving them. Notes include an
overview, participants, decisions, action items, risks, and finally the transcript,
so bounded readers see the notes before long transcripts.
Participants come from speaker labels in first-appearance order, not model guesses.
Summary JSON records `source` as `model` or `heuristic` and, for model notes, the
model reference used.

The model receives at most 48,000 transcript characters, preserving the beginning
and end when the middle must be omitted. Stored utterances remain intact. Use
`transcripts summarize` (the agent tool's `summarize` action) to regenerate notes
from the stored transcript, including after changing model configuration.

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
        "channelId": "2345678901",
        "whenOccupied": true
      }
    ]
  }
}
```

`whenOccupied` defaults to `false`: capture starts with the Gateway and continues
until stopped. Set it to `true` to wait for humans, then capture one meeting per
occupancy episode. It also starts when humans are already present at startup;
bots never count. After the last human leaves, a fixed 30-second grace period
allows short reconnects without splitting the meeting. A human returning during
that grace cancels the stop. Otherwise, OpenClaw stops capture and generates notes.

Occupancy episodes use generated IDs; an entry's `sessionId` is ignored. To
continue a meeting across a Gateway restart, OpenClaw reopens the most recent
session for the same provider, account, guild, and channel when it stopped within
the last 10 minutes. The session keeps its original ID and start time, and new
utterances append to it. A later return within that window also reuses the meeting;
outside the window, capture gets a new ID.

The provider must report occupancy. `discord-voice` supports it; an unsupported
provider logs a warning and skips the entry instead of capturing continuously.
Configure at most one `whenOccupied: true` entry per Discord account and guild,
even when the channel IDs differ: a Discord bot can occupy only one voice channel
per guild. Later conflicting entries are skipped with a warning. For the complete
listen-only setup, see [Discord meeting notes](/channels/discord#meeting-notes).

The meeting provider ids are `google-meet`, `teams`, and `zoom`. Their aliases
are `googlemeet`/`meet`, `teams-meetings`/`microsoft-teams`/`msteams`, and
`zoom-meetings`, respectively. Meeting providers attach to an already-active
meeting bot session; normal meeting joins do not need an `autoStart` entry.
