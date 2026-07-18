---
summary: "Deep dive: session store + transcripts, lifecycle, and (auto)compaction internals"
read_when:
  - You need to debug session ids, transcript events, or session row fields
  - You are changing auto-compaction behavior or adding "pre-compaction" housekeeping
  - You want to implement memory flushes or silent system turns
title: "Session management deep dive"
---

A single **Gateway process** owns session state end-to-end. UIs (macOS app, web Control UI, TUI) query the Gateway for session lists and token counts. In remote mode, session files live on the remote host, so checking your local Mac's files will not reflect what the Gateway is using.

Overview docs first: [Session management](/concepts/session), [Compaction](/concepts/compaction), [Memory overview](/concepts/memory), [Memory search](/concepts/memory-search), [Session pruning](/concepts/session-pruning), [Transcript hygiene](/reference/transcript-hygiene), full config reference at [Agent config](/gateway/config-agents).

## Two persistence layers

1. **Session rows (per-agent SQLite)** - key/value map `sessionKey -> SessionEntry`. Mutable runtime state owned by the Gateway. Tracks metadata: current session id, last activity, toggles, token counters.
2. **Transcript events (per-agent SQLite)** - append-only, tree-structured (entries have `id` + `parentId`). Stores the conversation, tool calls, and compaction summaries; rebuilds model context for future turns. Compaction checkpoints are metadata over the compacted successor transcript - a new compaction does not write a second `.checkpoint.*.jsonl` copy.

Older installs may still have `sessions.json` files under the agent `sessions/`
directory. Treat those files as legacy session-row migration inputs or explicit
offline-maintenance targets. Gateway startup and `openclaw doctor --fix` import
hot legacy rows and transcript history into the per-agent SQLite store
automatically. Run `openclaw doctor --session-sqlite inspect
--session-sqlite-all-agents`, then follow the [Doctor migration
sequence](/cli/doctor#session-sqlite-migration), when you need explicit
inspection or validation evidence. If a migration fails after legacy transcript
artifacts were archived, use the Doctor recovery mode from that sequence.
Recovery uses migration manifests, restores only the affected archived support
artifacts, prepares a sanitized GitHub issue report when requested, and does not
make active runtime read JSONL files again.

Gateway history readers avoid materializing the whole transcript unless the surface needs arbitrary historical access. First-page history, embedded chat history, restart recovery, and token/usage checks use bounded tail reads from SQLite. Full transcript scans go through the async transcript index and are shared across concurrent readers.

## On-disk locations

Per agent, on the Gateway host (resolved via `src/config/sessions.ts`):

- Runtime session row store: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- Runtime transcript rows: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- Legacy/archive transcript artifacts: `~/.openclaw/agents/<agentId>/sessions/`
- Legacy row migration input: `~/.openclaw/agents/<agentId>/sessions/sessions.json`

## Store maintenance and disk controls

`session.maintenance` controls automatic maintenance for SQLite session rows, SQLite transcript rows, archive artifacts, and trajectory sidecars:

| Key                     | Default               | Notes                                                                                       |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `mode`                  | `"enforce"`           | or `"warn"` (report only, no mutation)                                                      |
| `pruneAfter`            | `"30d"`               | stale-entry age cutoff                                                                      |
| `maxEntries`            | `500`                 | cap on session entries                                                                      |
| `resetArchiveRetention` | keep (no age cutoff)  | age cutoff for `*.reset.*`/`*.deleted.*` transcript archives; a duration opts into deletion |
| `maxDiskBytes`          | `10gb`                | per-agent sessions disk budget; `false` disables                                            |
| `highWaterBytes`        | 80% of `maxDiskBytes` | target after budget cleanup                                                                 |

Archived transcripts are kept by default and compressed with zstd (`*.jsonl.<reason>.<timestamp>.zst`) when the runtime supports it, so deleting or resetting a session never silently discards conversation history. The disk budget evicts the oldest archives first, before touching live sessions.

Active SQLite enforcement of `maxDiskBytes` measures session-row JSON plus transcript-event JSON bytes per session; legacy offline-maintenance enforcement measures files in the selected sessions directory.

Gateway model-run probe sessions (keys matching `agent:*:explicit:model-run-<uuid>`) get a separate, fixed `24h` retention. This pruning is pressure-gated: it only runs when session-entry maintenance/cap pressure is reached, and only before the global stale-entry cleanup/cap step. Other explicit sessions do not use this retention.

Enforcement order for disk-budget cleanup (`mode: "enforce"`):

1. Remove oldest archived transcript artifacts, orphan legacy artifacts, or orphan trajectory artifacts first.
2. If still above target, evict oldest session entries and their transcript rows or trajectory artifacts.
3. Repeat until usage is at or below `highWaterBytes`.

`mode: "warn"` reports potential evictions without mutating the store or files.

Run maintenance on demand:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

Maintenance keeps durable external conversation pointers such as group sessions and thread-scoped chat sessions, but synthetic runtime entries (cron, hooks, heartbeat, ACP, sub-agents) can still be removed once they exceed the configured age, count, or disk budget. Isolated cron runs use a separate `cron.sessionRetention` control, independent of model-run probe retention.

Normal Gateway writes flow through the session accessor, which serializes per-agent SQLite mutations through the runtime writer path. Runtime code should prefer the accessor helpers in `src/config/sessions/session-accessor.ts`; legacy `sessions.json` helpers are migration and offline-maintenance tools. When a Gateway is reachable, non-dry-run `openclaw sessions cleanup` and `openclaw agents delete` delegate store mutations to the Gateway so cleanup joins the same writer queue; `--store <path>` is the explicit offline repair path for a selected legacy store and always stays local (as does `--dry-run`). `maxEntries` cleanup is batched for production-sized stores, so a store may briefly exceed the configured cap before the next high-water cleanup rewrites it down. Reads never prune or cap entries during Gateway startup - only writes or `openclaw sessions cleanup --enforce` do, and the latter also applies the cap immediately and prunes old unreferenced legacy transcript, checkpoint, and trajectory artifacts even with no disk budget configured.

OpenClaw no longer creates automatic `sessions.json.bak.*` rotation backups during Gateway writes. The current schema rejects the legacy `session.maintenance.rotateBytes` key, and `openclaw doctor --fix` removes it from older configs.

Transcript mutations use the session write queue for the SQLite transcript target:

| Setting                              | Default   | Env override                                     |
| ------------------------------------ | --------- | ------------------------------------------------ |
| `session.writeLock.acquireTimeoutMs` | `60000`   | `OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS` |
| `session.writeLock.staleMs`          | `1800000` | `OPENCLAW_SESSION_WRITE_LOCK_STALE_MS`           |
| `session.writeLock.maxHoldMs`        | `300000`  | `OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS`        |

`acquireTimeoutMs` is how long a lock wait surfaces a busy-session error before giving up; raise it only when legitimate prep, cleanup, compaction, or transcript mirror work contends longer on slow machines. `staleMs` is when an existing lock can be reclaimed as stale. `maxHoldMs` is the in-process watchdog release threshold.

### Downgrading After The SQLite Flip

Restore archived legacy transcript artifacts before running an older
file-backed OpenClaw version:

```bash
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

The migration leaves legacy `sessions.json` files in place for support and
rollback, but hot transcript JSONL files that were imported into SQLite are
renamed into `session-sqlite-import-archive/`. Older file-backed runtimes follow
the `sessionFile` paths in `sessions.json`, so they need those artifacts restored
before startup. Restore uses migration manifests, moves only recorded archived
artifacts whose original paths are missing, and leaves the SQLite database in
place for forward recovery.

Sessions created after the SQLite flip are SQLite-only and will not appear to an
older file-backed runtime. If you re-upgrade after a downgrade, run the Doctor
inspection and validation sequence again so OpenClaw can verify restored legacy
artifacts before importing.

## Cron sessions and run logs

Isolated cron runs create their own session entries/transcripts with dedicated retention:

- `cron.sessionRetention` (default `"24h"`) prunes old isolated cron run sessions from the store; `false` disables.
- Run history keeps the newest 2000 terminal rows per cron job. Lost rows retain their 24-hour cleanup window.

When cron force-creates a new isolated run session, it sanitizes the previous `cron:<jobId>` session entry before writing the new row: it carries safe preferences (thinking/fast/verbose/reasoning settings, labels, display name) and explicit user-selected model/auth overrides, but drops ambient conversation context (channel/group routing, send/queue policy, elevation, origin, ACP runtime binding) so a fresh isolated run cannot inherit stale delivery or runtime authority from an older run.

## Session keys (`sessionKey`)

A `sessionKey` identifies which conversation bucket you are in (routing + isolation). Canonical rules: [/concepts/session](/concepts/session).

| Pattern                      | Example                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| Main/direct chat (per agent) | `agent:<agentId>:<mainKey>` (default `main`)                |
| Group                        | `agent:<agentId>:<channel>:group:<id>`                      |
| Room/channel (Discord/Slack) | `agent:<agentId>:<channel>:channel:<id>` or `...:room:<id>` |
| Cron                         | `cron:<job.id>`                                             |
| Webhook                      | `hook:<uuid>` (unless overridden)                           |

## Session ids (`sessionId`)

Each `sessionKey` points at a current `sessionId` (the SQLite transcript identity that continues the conversation). Decision logic lives in `initSessionState()` in `src/auto-reply/reply/session.ts`.

- **Reset** (`/new`, `/reset`) creates a new `sessionId` for that `sessionKey`.
- **Daily reset** (default 4:00 AM local time on the gateway host) creates a new `sessionId` on the next message after the reset boundary.
- **Idle expiry** (`session.reset.idleMinutes`, or legacy `session.idleMinutes`) creates a new `sessionId` when a message arrives after the idle window. If daily and idle are both configured, whichever expires first wins.
- **Control UI reconnect resume** preserves the currently visible session for one reconnect send when the Gateway receives the matching `sessionId` from an operator UI client. This is a one-shot signal; ordinary stale sends still create a new `sessionId`.
- **System events** (heartbeat, cron wakeups, exec notifications, gateway bookkeeping) may mutate the session row but never extend daily/idle reset freshness. Reset rollover discards queued system-event notices for the previous session before the fresh prompt is built.
- **Parent fork policy** uses OpenClaw's active branch when creating a thread or subagent fork. If that branch is too large (over a fixed internal cap, currently 100K tokens), OpenClaw starts the child with isolated context instead of failing or inheriting unusable history. Sizing is automatic and not configurable; legacy `session.parentForkMaxTokens` config is removed by `openclaw doctor --fix`.
- **Operator forks**: `sessions.create { parentSessionKey, fork: true }` creates a new session whose transcript branches from the parent's current state (same fork machinery as subagent spawns, including the size cap above). The fork is refused while the parent has an active run, inherits the parent's model selection unless one is passed explicitly, and marks the child `forkedFromParent` with fresh token counters.

## Session store schema

The runtime store keeps `SessionEntry` values in per-agent SQLite. The value type is `SessionEntry` in `src/config/sessions.ts`. Key fields (not exhaustive):

- `sessionId`: current transcript id used to address SQLite transcript rows
- `sessionStartedAt`: start timestamp for the current `sessionId`; daily reset freshness uses this. Legacy rows may derive it from the JSONL session header.
- `lastInteractionAt`: last real user/channel interaction timestamp; idle reset freshness uses this so heartbeat, cron, and exec events do not keep sessions alive. Legacy rows without this field fall back to the recovered session start time.
- `updatedAt`: last store-row mutation timestamp, used for listing/pruning/bookkeeping - not the daily/idle freshness authority.
- `archivedAt`: optional archive timestamp. Archived sessions stay in the store with their transcript intact and are excluded from normal active listings.
- `pinnedAt`: optional pin timestamp. Active pinned sessions sort ahead of unpinned sessions; archiving a session clears its pin.
- Codex thread interop: both fields follow the Codex thread-management shape - the `archived`/`pinned` booleans on the wire are always derived from the timestamp and stamped server-side, matching Codex `threads.archived_at` semantics and camelCase serialization. OpenClaw timestamps are epoch milliseconds while Codex uses epoch seconds, so bridges convert at the `codex` plugin seam. Codex has no pin API yet (`thread/archive`/`thread/unarchive` only); pinned state stays OpenClaw-side until one exists, at which point the matching shape lets bound sessions round-trip pin state mechanically.
- Codex supervision lists only non-archived native threads. A Gateway-local `idle` or `notLoaded` activity-unknown thread can be archived through native `thread/archive` only after the operator explicitly confirms that no other Codex process owns it; the plugin performs a fresh process-local status read first, and the thread then disappears from the catalog. That read cannot prove that another App Server process is not using the thread. OpenClaw refuses to archive active and error rows, and paired-node archive is unavailable until the node bridge can own the full streamed thread lifecycle. Unarchiving in a native Codex client makes the thread eligible to appear again.
- `lastReadAt` / `markedUnreadAt`: read-state timestamps stamped server-side by `sessions.patch { unread }` - `unread: false` records a read (sets `lastReadAt`, clears `markedUnreadAt`); `unread: true` marks the session unread until the next read. Session rows expose a derived `unread` boolean: explicitly marked unread, or read before the latest activity. Sessions never marked read stay `unread: false`, so existing installs do not light up on upgrade.
- `lastActivityAt`: timestamp of the last completed agent run that counts as unread-worthy activity (user, channel, and cron runs). Heartbeat and internal-event turns, plus metadata patches, do not update it; `updatedAt` is not an activity signal.
- `sessionFile`: legacy marker retained for migration/archive compatibility; active runtime uses SQLite identity
- `chatType`: `direct | group | room`
- `provider`, `subject`, `room`, `space`, `displayName`: group/channel labeling metadata
- Toggles: `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`, `sendPolicy` (per-session override)
- Model selection: `providerOverride`, `modelOverride`, `authProfileOverride`
- Token counters (best-effort/provider-dependent): `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: how many times auto-compaction completed for this session key
- `memoryFlushAt` / `memoryFlushCompactionCount`: timestamp and compaction count of the last pre-compaction memory flush

The Gateway is the authority: it may rewrite or rehydrate entries as sessions
run. For legacy file-backed installs, migrate with
`openclaw doctor --session-sqlite import --session-sqlite-all-agents` instead of
editing `sessions.json` and expecting runtime to keep reading that file.

## Transcript event structure

Transcripts are managed by the OpenClaw session accessor and exposed to runtime code through identity-based helpers. The event stream is append-only:

- First entry: session header - `type: "session"`, `id`, `cwd`, `timestamp`, optional `parentSession`.
- Then: entries with `id` + `parentId` (tree structure).

Notable entry types:

- `message`: user/assistant/toolResult messages
- `custom_message`: extension-injected message that _does_ enter model context (rendered in the TUI when `display: true`, hidden entirely when `display: false`)
- `custom`: extension state that does _not_ enter model context (for persisting extension state across reloads)
- `compaction`: persisted compaction summary with `firstKeptEntryId` and `tokensBefore`
- `branch_summary`: persisted summary when navigating a tree branch

OpenClaw intentionally does not "fix up" transcripts; the Gateway uses `SessionManager` to read/write them.

## Context windows vs tracked tokens

Two different concepts:

1. **Model context window**: hard cap per model (tokens visible to the model). Comes from the model catalog and can be overridden via config.
2. **Session store counters**: rolling stats written into the session row (used for `/status` and dashboards). `contextTokens` is a runtime estimate/reporting value - do not treat it as a strict guarantee.

More on limits: [/reference/token-use](/reference/token-use).

## Compaction: what it is

Compaction summarizes older conversation into a persisted `compaction` entry in the transcript and keeps recent messages intact. After compaction, future turns see the compaction summary plus messages after `firstKeptEntryId`. Compaction is **persistent**, unlike session pruning - see [/concepts/session-pruning](/concepts/session-pruning).

AGENTS.md section reinjection after compaction is opt-in via `agents.defaults.compaction.postCompactionSections`; when unset or `[]`, OpenClaw does not append AGENTS.md excerpts on top of the compaction summary.

### Chunk boundaries and tool pairing

When splitting a long transcript into compaction chunks, OpenClaw keeps assistant tool calls paired with their matching `toolResult` entries:

- If the token-share split would land between a tool call and its result, OpenClaw shifts the boundary to the assistant tool-call message instead of separating the pair.
- If a trailing tool-result block would otherwise push the chunk over target, OpenClaw preserves that pending tool block and keeps the unsummarized tail intact.
- Aborted/error tool-call blocks do not hold a pending split open.

## When auto-compaction happens

Two triggers in the embedded OpenClaw agent:

1. **Overflow recovery**: the model returns a context-overflow error (`request_too_large`, `context length exceeded`, `input exceeds the maximum number of tokens`, `input token count exceeds the maximum number of input tokens`, `input is too long for the model`, `ollama error: context length exceeded`, and other provider-shaped variants) - compact, then retry. When the provider reports the attempted token count, OpenClaw forwards that observed count into overflow-recovery compaction; if the provider confirms overflow but exposes no parseable count, OpenClaw passes a minimally over-budget synthetic count to compaction engines and diagnostics. If overflow recovery still fails, OpenClaw surfaces explicit guidance and preserves the current session mapping instead of silently rotating to a fresh session id - retry the message, run `/compact`, or run `/new`.
2. **Threshold maintenance**: after a successful turn, when `contextTokens > contextWindow - reserveTokens`, where `contextWindow` is the model's context window and `reserveTokens` is headroom reserved for prompts plus the next model output.

Two additional guards run outside these two triggers:

- **Preflight local compaction**: set `agents.defaults.compaction.maxActiveTranscriptBytes` (bytes or a string like `"20mb"`) to trigger local compaction before opening the next run once the active transcript reaches that size. This is a size guard for local reopen cost, not raw archival - normal semantic compaction still runs, and it requires `truncateAfterCompaction` so the compacted summary becomes a new successor transcript.
- **Mid-turn precheck**: set `agents.defaults.compaction.midTurnPrecheck.enabled: true` (default `false`) to add a tool-loop guard. After a tool result is appended and before the next model call, OpenClaw estimates prompt pressure using the same preflight budget logic used at turn start. If context no longer fits, the guard does not compact inline - it raises a structured mid-turn precheck signal, stops the current prompt submission, and lets the outer run loop use the existing recovery path (truncate oversized tool results when that is enough, or trigger the configured compaction mode and retry). Works with both `default` and `safeguard` compaction modes, including provider-backed safeguard compaction. Independent of `maxActiveTranscriptBytes`: the byte-size guard runs before a turn opens, mid-turn precheck runs later, after new tool results are appended.

## Compaction settings

```json5
{
  agents: {
    defaults: {
      compaction: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    },
  },
}
```

OpenClaw also enforces a safety floor for embedded runs: if `compaction.reserveTokens` is below `reserveTokensFloor` (default `20000`), OpenClaw bumps it up. Set `agents.defaults.compaction.reserveTokensFloor: 0` to disable the floor. When the active model context window is known, both the floor and the final effective reserve are capped so the reserve cannot consume the whole prompt budget. This keeps small-context models (for example a 16K-token local model) from entering compaction from the first token; without a known context window, configured and current reserve budgets remain uncapped. Why a floor at all: leave enough headroom for multi-turn "housekeeping" (like the memory flush, below) before compaction becomes unavoidable. Implementation: `applyAgentCompactionSettingsFromConfig()` in `src/agents/agent-settings.ts`, called from embedded-runner turn and compaction setup paths.

Manual `/compact` honors an explicit `agents.defaults.compaction.keepRecentTokens` and keeps the runtime's recent-tail cut point. Without an explicit keep budget, manual compaction is a hard checkpoint and rebuilt context starts from the new summary.

When `truncateAfterCompaction` is enabled, OpenClaw rotates the active transcript to a compacted successor after compaction. Branch/restore checkpoint actions use that compacted successor; legacy pre-compaction checkpoint files remain readable while referenced.

## Pluggable compaction providers

Plugins register a compaction provider via `registerCompactionProvider()` on the plugin API. When `agents.defaults.compaction.provider` is set to a registered provider id, the safeguard extension delegates summarization to that provider instead of the built-in `summarizeInStages` pipeline.

- `provider`: id of a registered compaction provider plugin. Leave unset for default LLM summarization. Setting a `provider` forces `mode: "safeguard"`.
- Providers receive the same compaction instructions and identifier-preservation policy as the built-in path, and the safeguard still preserves recent-turn and split-turn suffix context after provider output.
- Built-in safeguard summarization re-distills prior summaries with new messages instead of preserving the full previous summary verbatim.
- Safeguard mode enables summary quality audits by default; set `qualityGuard.enabled: false` to skip retry-on-malformed-output behavior.
- If the provider fails or returns an empty result, OpenClaw falls back to built-in LLM summarization automatically. Abort/timeout signals the caller explicitly triggered are re-thrown, not swallowed, so cancellation is always respected.

Source: `src/plugins/compaction-provider.ts`, `src/agents/agent-hooks/compaction-safeguard.ts`.

## User-visible surfaces

- `/status` in any chat session
- `openclaw status` (CLI)
- `openclaw sessions` / `openclaw sessions --json`
- Gateway logs (`pnpm gateway:watch` or `openclaw logs --follow`): `embedded run auto-compaction start` + `complete`
- Verbose mode: `🧹 Auto-compaction complete` plus the compaction count

## Silent housekeeping (`NO_REPLY`)

OpenClaw supports "silent" turns for background tasks where the user should not see intermediate output.

- The assistant starts its output with the exact silent token `NO_REPLY` / `no_reply` to mean "do not deliver a reply to the user." OpenClaw strips/suppresses this in the delivery layer.
- Exact silent-token suppression is case-insensitive: `NO_REPLY` and `no_reply` both count when the whole payload is just the silent token.
- As of `2026.1.10`, OpenClaw also suppresses draft/typing streaming when a partial chunk begins with `NO_REPLY`, so silent operations do not leak partial output mid-turn.
- This is for true background/no-delivery turns only - it is not a shortcut for ordinary actionable user requests.

## Pre-compaction memory flush

Before auto-compaction happens, OpenClaw can run a silent agentic turn that writes durable state to disk (for example `memory/YYYY-MM-DD.md` in the agent workspace) so compaction cannot erase critical context. It monitors session context usage, and once it crosses a soft threshold below the compaction threshold, it sends a silent "write memory now" directive using the exact silent token `NO_REPLY` / `no_reply` so the user sees nothing.

Config (`agents.defaults.compaction.memoryFlush`), full reference at [/gateway/config-agents](/gateway/config-agents#agentsdefaultscompaction):

| Key                         | Default          | Notes                                                                                                                                  |
| --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `true`           |                                                                                                                                        |
| `model`                     | unset            | exact provider/model override for the flush turn only, for example `ollama/qwen3:8b`                                                   |
| `softThresholdTokens`       | `4000`           | gap below the compaction threshold that triggers a flush                                                                               |
| `forceFlushTranscriptBytes` | unset (disabled) | force a flush once the transcript file reaches this byte size (or string like `"2mb"`), even if token counters are stale; `0` disables |
| `prompt`                    | built-in         | user message for the flush turn                                                                                                        |
| `systemPrompt`              | built-in         | extra system prompt appended for the flush turn                                                                                        |

Notes:

- The default prompt/system prompt include a `NO_REPLY` hint to suppress delivery.
- When `model` is set, the flush turn uses that model without inheriting the active session's fallback chain, so local-only housekeeping does not silently fall back to a paid conversation model on failure.
- The flush runs once per compaction cycle (tracked in the session row).
- The flush runs only for embedded OpenClaw sessions; CLI backends and heartbeat turns skip it.
- The flush is skipped when the session workspace is read-only (`workspaceAccess: "ro"` or `"none"`).
- See [Memory](/concepts/memory) for the workspace file layout and write patterns.

OpenClaw exposes a `session_before_compact` hook in the extension API, but the flush logic above lives on the Gateway side (`src/auto-reply/reply/memory-flush.ts`, `src/auto-reply/reply/agent-runner-memory.ts`), not on that hook.

## Troubleshooting checklist

- **Session key wrong?** Start with [/concepts/session](/concepts/session) and confirm the `sessionKey` in `/status`.
- **Store vs transcript mismatch?** Confirm the Gateway host and the store path from `openclaw status`.
- **Compaction spam?** Check the model's context window (too small forces frequent compaction), `reserveTokens` (too high for the model window causes earlier compaction), and tool-result bloat (tune session pruning).
- **Every prompt seems to overflow on a small local model?** Confirm the provider reports the correct model context window. OpenClaw can cap the effective reserve only when that window is known.
- **Silent turns leaking?** Confirm the reply starts with the exact silent token `NO_REPLY` (case-insensitive) and you are on a build that includes the streaming-suppression fix (`2026.1.10`+).

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
- [Context engine](/concepts/context-engine)
- [Agent config reference](/gateway/config-agents)
