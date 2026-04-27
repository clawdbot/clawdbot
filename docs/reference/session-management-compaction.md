---
summary: "Deep dive: session store + transcripts, lifecycle, and (auto)compaction internals"
read_when:
  - You need to debug session ids, transcript JSONL, or sessions.json fields
  - You are changing auto-compaction behavior or adding “pre-compaction” housekeeping
  - You want to implement memory flushes or silent system turns
title: "Session management deep dive"
---

OpenClaw manages sessions end-to-end across these areas:

- **Session routing** (how inbound messages map to a `sessionKey`)
- **Session store** (`sessions.json`) and what it tracks
- **Transcript persistence** (`*.jsonl`) and its structure
- **Transcript hygiene** (provider-specific fixups before runs)
- **Context limits** (context window vs tracked tokens)
- **Compaction** (manual and auto-compaction) and where to hook pre-compaction work
- **Silent housekeeping** (memory writes that should not produce user-visible output)

If you want a higher-level overview first, start with:

- [Session management](/concepts/session)
- [Compaction](/concepts/compaction)
- [Memory overview](/concepts/memory)
- [Memory search](/concepts/memory-search)
- [Session pruning](/concepts/session-pruning)
- [Transcript hygiene](/reference/transcript-hygiene)

---

## Source of truth: the Gateway

OpenClaw is designed around a single **Gateway process** that owns session state.

- UIs (macOS app, web Control UI, TUI) should query the Gateway for session lists and token counts.
- In remote mode, session files are on the remote host; “checking your local Mac files” won’t reflect what the Gateway is using.

---

## Two persistence layers

OpenClaw persists sessions in two layers:

1. **Session store (`sessions.json`)**
   - Key/value map: `sessionKey -> SessionEntry`
   - Small, mutable, safe to edit (or delete entries)
   - Tracks session metadata (current session id, last activity, toggles, token counters, etc.)

2. **Transcript (`<sessionId>.jsonl`)**
   - Append-only transcript with tree structure (entries have `id` + `parentId`)
   - Stores the actual conversation + tool calls + compaction summaries
   - Used to rebuild the model context for future turns

---

## On-disk locations

Per agent, on the Gateway host:

- Store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram topic sessions: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw resolves these via `src/config/sessions.ts`.

---

## Store maintenance and disk controls

Session persistence has automatic maintenance controls (`session.maintenance`) for `sessions.json` and transcript artifacts:

- `mode`: `warn` (default) or `enforce`
- `pruneAfter`: stale-entry age cutoff (default `30d`)
- `maxEntries`: cap entries in `sessions.json` (default `500`)
- `rotateBytes`: rotate `sessions.json` when oversized (default `10mb`)
- `resetArchiveRetention`: retention for `*.reset.<timestamp>` transcript archives (default: same as `pruneAfter`; `false` disables cleanup)
- `maxDiskBytes`: optional sessions-directory budget
- `highWaterBytes`: optional target after cleanup (default `80%` of `maxDiskBytes`)

Enforcement order for disk budget cleanup (`mode: "enforce"`):

1. Remove oldest archived or orphan transcript artifacts first.
2. If still above the target, evict oldest session entries and their transcript files.
3. Keep going until usage is at or below `highWaterBytes`.

In `mode: "warn"`, OpenClaw reports potential evictions but does not mutate the store/files.

Run maintenance on demand:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

---

## Cron sessions and run logs

Isolated cron runs also create session entries/transcripts, and they have dedicated retention controls:

- `cron.sessionRetention` (default `24h`) prunes old isolated cron run sessions from the session store (`false` disables).
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` prune `~/.openclaw/cron/runs/<jobId>.jsonl` files (defaults: `2_000_000` bytes and `2000` lines).

When cron force-creates a new isolated run session, it sanitizes the previous
`cron:<jobId>` session entry before writing the new row. It carries safe
preferences such as thinking/fast/verbose settings, labels, and explicit
user-selected model/auth overrides. It drops ambient conversation context such
as channel/group routing, send or queue policy, elevation, origin, and ACP
runtime binding so a fresh isolated run cannot inherit stale delivery or
runtime authority from an older run.

---

## Session keys (`sessionKey`)

A `sessionKey` identifies _which conversation bucket_ you’re in (routing + isolation).

Common patterns:

- Main/direct chat (per agent): `agent:<agentId>:<mainKey>` (default `main`)
- Group: `agent:<agentId>:<channel>:group:<id>`
- Room/channel (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` or `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (unless overridden)

The canonical rules are documented at [/concepts/session](/concepts/session).

---

## Session ids (`sessionId`)

Each `sessionKey` points at a current `sessionId` (the transcript file that continues the conversation).

Rules of thumb:

- **Reset** (`/new`, `/reset`) creates a new `sessionId` for that `sessionKey`.
- **Daily reset** (default 4:00 AM local time on the gateway host) creates a new `sessionId` on the next message after the reset boundary.
- **Idle expiry** (`session.reset.idleMinutes` or legacy `session.idleMinutes`) creates a new `sessionId` when a message arrives after the idle window. When daily + idle are both configured, whichever expires first wins.
- **System events** (heartbeat, cron wakeups, exec notifications, gateway bookkeeping) may mutate the session row but do not extend daily/idle reset freshness. Reset rollover discards queued system-event notices for the previous session before the fresh prompt is built.
- **Thread parent fork guard** (`session.parentForkMaxTokens`, default `100000`) skips parent transcript forking when the parent session is already too large; the new thread starts fresh. Set `0` to disable.

Implementation detail: the decision happens in `initSessionState()` in `src/auto-reply/reply/session.ts`.

---

## Session store schema (`sessions.json`)

The store’s value type is `SessionEntry` in `src/config/sessions.ts`.

Key fields (not exhaustive):

- `sessionId`: current transcript id (filename is derived from this unless `sessionFile` is set)
- `sessionStartedAt`: start timestamp for the current `sessionId`; daily reset
  freshness uses this. Legacy rows may derive it from the JSONL session header.
- `lastInteractionAt`: last real user/channel interaction timestamp; idle reset
  freshness uses this so heartbeat, cron, and exec events do not keep sessions
  alive. Legacy rows without this field fall back to the recovered session start
  time for idle freshness.
- `updatedAt`: last store-row mutation timestamp, used for listing, pruning, and
  bookkeeping. It is not the authority for daily/idle reset freshness.
- `sessionFile`: optional explicit transcript path override
- `chatType`: `direct | group | room` (helps UIs and send policy)
- `provider`, `subject`, `room`, `space`, `displayName`: metadata for group/channel labeling
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (per-session override)
- Model selection:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Token counters (best-effort / provider-dependent):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: how often auto-compaction completed for this session key
- `memoryFlushAt`: timestamp for the last pre-compaction memory flush
- `memoryFlushCompactionCount`: compaction count when the last flush ran

The store is safe to edit, but the Gateway is the authority: it may rewrite or rehydrate entries as sessions run.

---

## Transcript structure (`*.jsonl`)

Transcripts are managed by `@mariozechner/pi-coding-agent`’s `SessionManager`.

The file is JSONL:

- First line: session header (`type: "session"`, includes `id`, `cwd`, `timestamp`, optional `parentSession`)
- Then: session entries with `id` + `parentId` (tree)

Notable entry types:

- `message`: user/assistant/toolResult messages
- `custom_message`: extension-injected messages that _do_ enter model context (can be hidden from UI)
- `custom`: extension state that does _not_ enter model context
- `compaction`: persisted compaction summary with `firstKeptEntryId` and `tokensBefore`
- `branch_summary`: persisted summary when navigating a tree branch

OpenClaw intentionally does **not** “fix up” transcripts; the Gateway uses `SessionManager` to read/write them.

---

## Context windows vs tracked tokens

Two different concepts matter:

1. **Model context window**: hard cap per model (tokens visible to the model)
2. **Session store counters**: rolling stats written into `sessions.json` (used for /status and dashboards)

If you’re tuning limits:

- The context window comes from the model catalog (and can be overridden via config).
- `contextTokens` in the store is a runtime estimate/reporting value; don’t treat it as a strict guarantee.

For more, see [/token-use](/reference/token-use).

---

## Compaction: what it is

Compaction summarizes older conversation into a persisted `compaction` entry in the transcript and keeps recent messages intact.

After compaction, future turns see:

- The compaction summary
- Messages after `firstKeptEntryId`

Compaction is **persistent** (unlike session pruning). See [/concepts/session-pruning](/concepts/session-pruning).

## Compaction chunk boundaries and tool pairing

When OpenClaw splits a long transcript into compaction chunks, it keeps
assistant tool calls paired with their matching `toolResult` entries.

- If the token-share split lands between a tool call and its result, OpenClaw
  shifts the boundary to the assistant tool-call message instead of separating
  the pair.
- If a trailing tool-result block would otherwise push the chunk over target,
  OpenClaw preserves that pending tool block and keeps the unsummarized tail
  intact.
- Aborted/error tool-call blocks do not hold a pending split open.

---

## When auto-compaction happens (Pi runtime)

In the embedded Pi agent, auto-compaction triggers in two cases:

1. **Overflow recovery**: the model returns a context overflow error
   (`request_too_large`, `context length exceeded`, `input exceeds the maximum
number of tokens`, `input token count exceeds the maximum number of input
tokens`, `input is too long for the model`, `ollama error: context length
exceeded`, and similar provider-shaped variants) → compact → retry.
2. **Threshold maintenance**: after a successful turn, when:

`contextTokens > contextWindow - reserveTokens`

Where:

- `contextWindow` is the model’s context window
- `reserveTokens` is headroom reserved for prompts + the next model output

These are Pi runtime semantics (OpenClaw consumes the events, but Pi decides when to compact).

OpenClaw can also trigger a preflight local compaction before opening the next
run when `agents.defaults.compaction.maxActiveTranscriptBytes` is set and the
active transcript file reaches that size. This is a file-size guard for local
reopen cost, not raw archival: OpenClaw still runs normal semantic compaction,
and it requires `truncateAfterCompaction` so the compacted summary can become a
new successor transcript.

---

## Compaction settings (`reserveTokens`, `keepRecentTokens`)

Pi’s compaction settings live in Pi settings:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw also enforces a safety floor for embedded runs:

- If `compaction.reserveTokens < reserveTokensFloor`, OpenClaw bumps it.
- Default floor is `20000` tokens.
- Set `agents.defaults.compaction.reserveTokensFloor: 0` to disable the floor.
- If it’s already higher, OpenClaw leaves it alone.
- Manual `/compact` honors an explicit `agents.defaults.compaction.keepRecentTokens`
  and keeps Pi's recent-tail cut point. Without an explicit keep budget,
  manual compaction remains a hard checkpoint and rebuilt context starts from
  the new summary.
- Set `agents.defaults.compaction.maxActiveTranscriptBytes` to a byte value or
  string such as `"20mb"` to run local compaction before a turn when the active
  transcript gets large. This guard is active only when
  `truncateAfterCompaction` is also enabled. Leave it unset or set `0` to
  disable.
- When `agents.defaults.compaction.truncateAfterCompaction` is enabled,
  OpenClaw rotates the active transcript to a compacted successor JSONL after
  compaction. The old full transcript remains archived and linked from the
  compaction checkpoint instead of being rewritten in place.

Why: leave enough headroom for multi-turn “housekeeping” (like memory writes) before compaction becomes unavoidable.

Implementation: `ensurePiCompactionReserveTokens()` in `src/agents/pi-settings.ts`
(called from `src/agents/pi-embedded-runner.ts`).

---

## Pluggable compaction providers

Plugins can register a compaction provider via `registerCompactionProvider()` on the plugin API. When `agents.defaults.compaction.provider` is set to a registered provider id, the safeguard extension delegates summarization to that provider instead of the built-in `summarizeInStages` pipeline.

- `provider`: id of a registered compaction provider plugin. Leave unset for default LLM summarization.
- Setting a `provider` forces `mode: "safeguard"`.
- Providers receive the same compaction instructions and identifier-preservation policy as the built-in path.
- The safeguard still preserves recent-turn and split-turn suffix context after provider output.
- Built-in safeguard summarization re-distills prior summaries with new messages
  instead of preserving the full previous summary verbatim.
- Safeguard mode enables summary quality audits by default; set
  `qualityGuard.enabled: false` to skip retry-on-malformed-output behavior.
- If the provider fails or returns an empty result, OpenClaw falls back to built-in LLM summarization automatically.
- Abort/timeout signals are re-thrown (not swallowed) to respect caller cancellation.

Source: `src/plugins/compaction-provider.ts`, `src/agents/pi-hooks/compaction-safeguard.ts`.

---

## User-visible surfaces

You can observe compaction and session state via:

- `/status` (in any chat session)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Verbose mode: `🧹 Auto-compaction complete` + compaction count

---

## Silent housekeeping (`NO_REPLY`)

OpenClaw supports “silent” turns for background tasks where the user should not see intermediate output.

Convention:

- The assistant starts its output with the exact silent token `NO_REPLY` /
  `no_reply` to indicate “do not deliver a reply to the user”.
- OpenClaw strips/suppresses this in the delivery layer.
- Exact silent-token suppression is case-insensitive, so `NO_REPLY` and
  `no_reply` both count when the whole payload is just the silent token.
- This is for true background/no-delivery turns only; it is not a shortcut for
  ordinary actionable user requests.

As of `2026.1.10`, OpenClaw also suppresses **draft/typing streaming** when a
partial chunk begins with `NO_REPLY`, so silent operations don’t leak partial
output mid-turn.

---

## Pre-compaction "memory flush" (implemented)

Goal: before auto-compaction happens, run a silent agentic turn that writes durable
state to disk (e.g. `memory/YYYY-MM-DD.md` in the agent workspace) so compaction can’t
erase critical context.

OpenClaw uses the **pre-threshold flush** approach:

1. Monitor session context usage.
2. When it crosses a “soft threshold” (below Pi’s compaction threshold), run a silent
   “write memory now” directive to the agent.
3. Use the exact silent token `NO_REPLY` / `no_reply` so the user sees
   nothing.

Config (`agents.defaults.compaction.memoryFlush`):

- `enabled` (default: `true`)
- `softThresholdTokens` (default: `4000`)
- `prompt` (user message for the flush turn)
- `systemPrompt` (extra system prompt appended for the flush turn)

Notes:

- The default prompt/system prompt include a `NO_REPLY` hint to suppress
  delivery.
- The flush runs once per compaction cycle (tracked in `sessions.json`).
- The flush runs only for embedded Pi sessions (CLI backends skip it).
- The flush is skipped when the session workspace is read-only (`workspaceAccess: "ro"` or `"none"`).
- See [Memory](/concepts/memory) for the workspace file layout and write patterns.

Pi also exposes a `session_before_compact` hook in the extension API, but OpenClaw’s
flush logic lives on the Gateway side today.

---

## Troubleshooting checklist

- Session key wrong? Start with [/concepts/session](/concepts/session) and confirm the `sessionKey` in `/status`.
- Store vs transcript mismatch? Confirm the Gateway host and the store path from `openclaw status`.
- Compaction spam? Check:
  - model context window (too small)
  - compaction settings (`reserveTokens` too high for the model window can cause earlier compaction)
  - tool-result bloat: enable/tune session pruning
- Silent turns leaking? Confirm the reply starts with `NO_REPLY` (case-insensitive exact token) and you’re on a build that includes the streaming suppression fix.

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
- [Context engine](/concepts/context-engine)
