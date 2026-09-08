---
summary: "Deep dive: session store + transcripts, lifecycle, and (auto)compaction internals"
read_when:
  - You need to debug session ids, transcript events, or session row fields
  - You are changing auto-compaction behavior or adding "pre-compaction" housekeeping
  - You want to implement memory flushes or silent system turns
title: "Session management deep dive"
---

A single **Gateway process** owns session state end-to-end. UIs (macOS app, web Control UI, TUI) query the Gateway for session lists and token counts. In remote mode, the per-agent SQLite database lives on the remote host, so checking your local Mac's state will not reflect what the Gateway is using.

Overview docs first: [Session management](/concepts/session), [Compaction](/concepts/compaction), [Memory overview](/concepts/memory), [Memory search](/concepts/memory-search), [Session pruning](/concepts/session-pruning), [Transcript hygiene](/reference/transcript-hygiene), full config reference at [Agent config](/gateway/config-agents).

## Two persistence layers

1. **Session rows (per-agent SQLite)** - key/value map `sessionKey -> SessionEntry`. Mutable runtime state owned by the Gateway. Tracks metadata: current session id, last activity, toggles, token counters.
2. **Transcript events (per-agent SQLite)** - append-only, tree-structured (entries have `id` + `parentId`). Stores the conversation, tool calls, and compaction summaries; rebuilds model context for future turns. Compaction checkpoints are metadata over the compacted successor transcript - a new compaction does not write a second `.checkpoint.*.jsonl` copy.

Older installs may still have `sessions.json` files under the agent `sessions/`
directory. Treat those files as legacy session-row migration inputs or explicit
offline-maintenance targets. Gateway startup does not import them. Stop the
Gateway, back up its state, and use `openclaw doctor --fix` to import legacy rows
and transcript history into the per-agent SQLite store. Run
`openclaw doctor --session-sqlite inspect --session-sqlite-all-agents`, then
follow the [Doctor migration sequence](/cli/doctor#session-sqlite-migration)
for inspection and validation. If a migration fails after legacy transcript
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
| `archiveDashboardAfter` | `"7d"`                | dashboard archiving cutoff; `false` or `0` disables only this trigger                       |
| `maxEntries`            | `5000`                | cap on unarchived session rows when protection permits                                      |
| `resetArchiveRetention` | keep (no age cutoff)  | age cutoff for `*.reset.*`/`*.deleted.*` transcript archives; a duration opts into deletion |
| `maxDiskBytes`          | `10gb`                | per-agent sessions disk budget; `false`, `0`, or `"0"` disables                             |
| `highWaterBytes`        | 80% of `maxDiskBytes` | target after cleanup; zero-resolving values use the default, and negatives are invalid      |

Reset boundaries start a fresh history window without deleting earlier transcript rows. When session rollover advances the live `sessionKey -> sessionId` mapping, the previous SQLite session, transcript, trajectory, and search rows also remain; ordinary entry and session lists show only the live mapping. Retained reset history is bounded by the disk budget, not by `resetArchiveRetention`, which only ages archive artifacts. Explicit deletion is different: it stores and verifies the compressed transcript archive in SQLite in the same transaction that removes the deleted session's rows. It then publishes, syncs, and reads back the derived `*.jsonl.deleted.<timestamp>.zst` file before reporting success when zstd is available.

`maxDiskBytes` enforcement uses physical bytes: the per-agent SQLite main file, its `-wal` file, and counted files in the agent sessions directory. It never estimates row JSON sizes or subtracts logical row sizes from that total. This is a cleanup budget, not a guaranteed physical ceiling: protected history and database pages that cannot yet be reclaimed can keep usage above the target.

Gateway model-run probe sessions (keys matching `agent:*:explicit:model-run-<uuid>`) get a separate, fixed `24h` retention. This pruning is pressure-gated: it only runs when session-entry maintenance/cap pressure is reached, and only before the global stale-entry cleanup/cap step. Other explicit sessions do not use this retention.

When combined physical usage exceeds `maxDiskBytes`, `mode: "enforce"` first reclaims checkpointable database space, then removes the oldest retained reset/delete archives. If usage is still above `highWaterBytes`, it walks historical SQLite sessions by `sessions.updated_at`, oldest first. Historical means the session id is not referenced by a live session entry, a route target, or an admitted/in-flight run. For each victim, cleanup stores the compressed archive in the same write transaction that removes the session row and its transcript, trajectory, active, index, and FTS projections. It publishes, syncs, and reads back the derived file after commit. This includes sessions that contain trajectory events but no transcript events. If those tiers are insufficient, cleanup permanently deletes the oldest sessions whose recorded archive reason is `active-session-cap`. Manual, legacy, age-retention, stale-dashboard, and recovery archives protect every history generation. Cleanup rechecks entry identity and admission references at deletion time, remeasures physical usage after each victim, and stops at `highWaterBytes`.

Committed writes and deletion first land in the WAL. Cleanup checkpoints it so the WAL can shrink immediately, then uses incremental vacuum to return eligible free tail pages from the main file; pages that are not yet reclaimable stay in the main file and therefore remain counted on the next physical measurement. `mode: "warn"` reports the current physical overage without checkpointing, writing an archive, or deleting rows.

Run maintenance on demand:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

`maxEntries` counts unarchived session rows; archived rows do not consume the cap. Cleanup archives the oldest eligible ordinary sessions until the unarchived total reaches `maxEntries` or no eligible victims remain. Pinned sessions, active or admitted work, model-locked sessions, and durable external conversation pointers such as group sessions and thread-scoped chat sessions remain protected, so protected rows can keep the unarchived total above the cap. Synthetic runtime entries (cron, hooks, heartbeat, ACP, sub-agents) remain disposable and can still be removed once they exceed the configured age, count, or disk budget. Isolated cron runs use a separate `cron.sessionRetention` control, independent of model-run probe retention.

Every new archive records a structured reason automatically. Explicit archive actions record `manual`; count-cap and stale-dashboard maintenance record their respective causes; `pruneAfter` archives eligible durable sessions with `age-retention` while deleting disposable automation; recovery archives record `restart-recovery`. The Control UI renders a human-readable explanation. Missing or unrecognized reasons are treated as protected legacy state rather than inferred.

`--dry-run` previews the unarchived-row cap and identifies the unprotected rows that would satisfy it; `--enforce` applies that cleanup immediately but does not remove protection. To reduce protected history, unarchive, unpin, wait for active work to finish, or explicitly delete sessions you no longer want to retain.

Normal Gateway writes flow through the session accessor, which serializes per-agent SQLite mutations through the runtime writer path. Runtime code should prefer the accessor helpers in `src/config/sessions/session-accessor.ts`; legacy `sessions.json` helpers are migration and offline-maintenance tools. When a Gateway is reachable, non-dry-run `openclaw sessions cleanup` and `openclaw agents delete` delegate store mutations to the Gateway so cleanup joins the same writer queue; `--store <path>` is the explicit offline repair path for a selected legacy store and always stays local (as does `--dry-run`). `maxEntries` cleanup is batched for production-sized stores, so the unarchived population may briefly exceed the configured cap before the next high-water cleanup rewrites it down. Reads never prune or cap entries during Gateway startup - only writes or `openclaw sessions cleanup --enforce` do, and the latter also applies the cap immediately and prunes old unreferenced legacy transcript, checkpoint, and trajectory artifacts even with no disk budget configured.

OpenClaw no longer creates automatic `sessions.json.bak.*` rotation backups during Gateway writes. The current schema rejects the legacy `session.maintenance.rotateBytes` key, and `openclaw doctor --fix` removes it from older configs.

Migration recovery originals and exact pre-Doctor recovery files are separate
from ordinary session retention: they are excluded from the live session disk
budget and have no automatic expiration. After verifying the upgrade, use
`openclaw update cleanup --dry-run` to inspect them online. Explicit offline
[update cleanup](/cli/update#update-cleanup) can retire verified originals
without removing current SQLite history; exclusion from the disk budget is not
deletion authority.

Transcript mutations pass through the session accessor and SQLite writer queue.
Each mutation verifies the active run's durable writer claim inside its commit
transaction, so a superseded run cannot write to the transcript.

### Downgrading After The SQLite Flip

Stop the Gateway and back up its state. Using the current SQLite-capable OpenClaw
version, restore archived legacy session stores and transcript artifacts before
starting an older file-backed version:

```bash
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

The migration archives imported hot transcript JSONL files and verified, fully
covered legacy `sessions.json` stores in `session-sqlite-import-archive/`.
Legacy stores with incomplete coverage or blocking migration issues remain in
place. Older file-backed runtimes need both `sessions.json` and the artifacts
referenced by its `sessionFile` paths at their original locations before startup.

Restore uses migration manifests, moves only recorded archived artifacts whose
original paths are missing, reports conflicts rather than overwriting existing
files, and leaves the SQLite database in place for forward recovery.

Originals retired by `openclaw update cleanup` can no longer be restored from
the migration archive. Restore reports intentional disposal or pending cleanup
instead of treating either as an unexpectedly missing file. An independent
backup containing the legacy artifacts is required if you need them after
disposal; see [Pre-update backups](/install/updating#before-updating-create-a-verified-backup).

Restore does not export changes made only in SQLite after migration. Sessions
created after the SQLite flip are SQLite-only and will not appear to an older
file-backed runtime. If you re-upgrade after a downgrade, run the Doctor
inspection and validation sequence again so OpenClaw can verify restored legacy
artifacts before importing.

## Cron sessions and run logs

Isolated cron runs create their own session entries/transcripts with dedicated retention:

- `cron.sessionRetention` (default `"24h"`) prunes old isolated cron run sessions from the store; `false` or a zero duration such as `"0h"` disables.
- Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.

When cron force-creates a new isolated run session, it sanitizes the previous `cron:<jobId>` session entry before writing the new row: it carries safe preferences (thinking/fast/verbose/reasoning settings, labels, display name) and explicit user-selected model/auth overrides, but drops ambient conversation context (channel/group routing, send/queue policy, elevation, origin, ACP runtime binding) so a fresh isolated run cannot inherit stale delivery or runtime authority from an older run.

## Session keys (`sessionKey`)

A `sessionKey` identifies which conversation bucket you are in (routing + isolation). Canonical rules: [/concepts/session](/concepts/session).

| Pattern                      | Example                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| Main/direct chat (per agent) | `agent:<agentId>:main`                                      |
| Group                        | `agent:<agentId>:<channel>:group:<id>`                      |
| Room/channel (Discord/Slack) | `agent:<agentId>:<channel>:channel:<id>` or `...:room:<id>` |
| Cron                         | `cron:<job.id>`                                             |
| Webhook                      | `hook:<uuid>` (unless overridden)                           |

## Session ids (`sessionId`)

Each `sessionKey` points at a current `sessionId` (the SQLite transcript identity that continues the conversation). Decision logic lives in `initSessionState()` in `src/auto-reply/reply/session.ts`.

- **Gateway reset** (`/new`, `/reset`) records a reset boundary in an existing persisted session and keeps its `sessionId`. A session that does not exist yet receives a new id.
- **No automatic reset** is the default. The current `sessionId` continues while compaction keeps the active model context bounded.
- **Daily reset** (`session.reset.mode: "daily"`) creates a new `sessionId` on the next message after the configured local-hour boundary (`session.reset.atHour`, default `4`).
- **Idle expiry** (`session.reset.mode: "idle"` with `session.reset.idleMinutes`, or legacy `session.idleMinutes`) creates a new `sessionId` when a message arrives after the idle window. If daily and idle are both configured, whichever expires first wins.
- **Control UI reconnect resume** preserves the currently visible session for one reconnect send when the Gateway receives the matching `sessionId` from an operator UI client. This is a one-shot signal; ordinary stale sends still create a new `sessionId`.
- **System events** (heartbeat, cron wakeups, exec notifications, gateway bookkeeping) may mutate the session row but never extend daily/idle reset freshness. Reset rollover discards queued system-event notices for the previous session before the fresh prompt is built.
- **Automatic parent fork policy** uses OpenClaw's active branch when creating a thread or subagent fork. If that branch is too large (over a fixed internal cap, currently 100K tokens), OpenClaw starts the child with isolated context instead of failing or inheriting unusable history. Sizing is automatic and not configurable; legacy `session.parentForkMaxTokens` config is removed by `openclaw doctor --fix`.
- **Operator forks**: `sessions.create { parentSessionKey, fork: true }` branches from the parent's current state. Admission uses the selected child model's effective usable input capacity, falling back to the 100K safety cap when model capacity is unavailable. A normal fork is refused while the parent has an active run; adding `forkFrom: "last-completed"` copies only through the last completed assistant message, excluding the in-progress tail. Unlike automatic parent forks, an operator fork over its capacity limit is rejected rather than accepted with isolated context. The child inherits the parent's model selection unless one is passed explicitly. The response marks it `forkedFromParent`, and token counters start fresh.
- **Message forks**: `sessions.fork { sessionKey, entryId }` creates a child from the active-path prefix before the selected user message and returns that message to the composer for editing. The parent remains unchanged. Incognito forks retain the parent's in-memory storage class; restarting the Gateway removes both sessions. Codex fork verification compares complete attested submitted prompts, including whitespace; the bounded display-import projection is not a substitute for that evidence. See [Control UI](/web/control-ui) for fork and rewind actions.

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
- `lastReadAt` / `markedUnreadAt`: read-state timestamps stamped server-side by `sessions.patch { unread }` - `unread: false` records a read (sets `lastReadAt`, clears `markedUnreadAt`); `unread: true` records `markedUnreadAt` and marks the session unread until the next activation or explicit read. Session rows expose the marker alongside a derived `unread` boolean so already-open clients preserve manual reminders while still acknowledging new activity. Automatic read patches from clients that support the advertised unread acknowledgement contract include `expectedMarkedUnreadAt` (`null` means no marker); a newer marker makes that acknowledgement a successful no-op instead of erasing newer intent. Bare `unread: false` requests retain the legacy clear behavior, so protection across several connected clients requires each active client to support the contract. Sessions never marked read stay `unread: false`, so existing installs do not light up on upgrade.
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
- `reset`: a fresh history window, optionally retaining messages from `firstKeptEntryId`
- `branch_summary`: persisted summary when navigating a tree branch

History readers keep the latest reset window across later compactions: explicitly retained reset messages and messages after that reset remain visible, but older messages and compaction summaries do not reappear. Model context follows the latest reset or compaction instead, so compaction can summarize the current conversation without reopening its earlier history.

Model-only callers should await `SessionManager.openModelContextAsync(target, { admission?, signal? })` to create a detached, non-persisting view without blocking the Gateway event loop on durable history scans. `openModelContext()` provides the same view for synchronous consumers. The reader selects payloads in SQLite and retains lightweight navigation outside the model window, without introducing a history size cutoff. Storage-only native prompt text and tool-result details stay out of that view; mirror identity, sender and media facts, tool content, and valid provider replay state remain available. Native fork verification, replay, exports, and doctor operations continue to use full-fidelity evidence readers.

`SessionManager.readSessionContext(target, read, { admission? })` lets a synchronous
consumer process full-fidelity context messages inside one read-only snapshot.
The callback receives `(messages, header)`: a lazy message iterable and the
unvalidated stored header. Missing stores supply an empty iterable and no header
without creating a database. An optional admission excludes the current admitted
user row and later events. Callback errors propagate, and the iterator closes
when the callback returns or throws; it cannot be retained for later reads.
This lets replay consumers enforce their existing limits during acquisition
without silently dropping earlier history. Navigation still scales with the
transcript, and individual selected rows are decoded whole; this is not a fixed
process-memory ceiling.

Durable model-context reads run in a worker. Codex native replay and settled-turn verification keep that lazy read and its consumer together in a worker. Worker reads are serialized per reader and reuse an idle worker. Admission receipts are validated inside the read snapshot and again before the result is accepted; reads without an admission instead check the session’s rewrite generation and last event sequence. Admitted reads retain their turn boundary, so later appends alone do not invalidate them. An invalidated read or canceled signal rejects the result. Callers carry their original cancellation signal through context acquisition and check that their owner remains active before invoking hooks, starting a model run, or applying a proposal. Incognito sessions use the same operation in the Gateway process because their SQLite database is held in memory.

OpenClaw intentionally does not "fix up" transcripts; the Gateway uses `SessionManager` to read/write them.

## Context windows vs tracked tokens

Two different concepts:

1. **Model context window**: hard cap per model (tokens visible to the model). Comes from the model catalog and can be overridden via config.
2. **Session store counters**: rolling stats written into the session row (used for `/status` and dashboards). `contextTokens` is a runtime estimate/reporting value - do not treat it as a strict guarantee.

Completed turns update session counters even when no compaction occurred. An ordered context replacement takes precedence over earlier model usage; if its size is unknown, the counters are marked stale instead of borrowing an older request's total. A superseded run cannot overwrite the current writer's counters.

More on limits: [/reference/token-use](/reference/token-use).

## Compaction: what it is

Compaction summarizes older conversation into a persisted `compaction` entry in the transcript and keeps recent messages intact. After compaction, future turns see the compaction summary plus messages after `firstKeptEntryId`. Compaction is **persistent**, unlike session pruning - see [/concepts/session-pruning](/concepts/session-pruning).

Embedded OpenClaw compaction uses the provider's compaction thinking preference, falling back to `low`. Native local Ollama prefers `off` to keep summarization within its request budget. Set `agents.defaults.compaction.thinkingLevel: "inherit"` to reuse the session level, or choose an explicit level for summary calls; the runtime clamps it to each concrete compaction model or fallback. Native Codex app-server compaction owns its compact request and cannot accept a per-compaction thinking override, so OpenClaw warns and leaves that setting to Codex.

Each summarization request uses one primary format. Safeguard history summaries use its structured checkpoint format, while split-turn prefixes use the prefix format. Operator focus and identifier-preservation guidance remain additional instructions; they do not add a competing set of required headings.

AGENTS.md section reinjection after compaction remains opt-in via `agents.defaults.compaction.postCompactionSections`. Plugins can add other prompt context through `before_prompt_build`.

### Chunk boundaries and tool pairing

When splitting a long transcript into compaction chunks, OpenClaw keeps assistant tool calls paired with their matching `toolResult` entries:

- If the token-share split would land between a tool call and its result, OpenClaw shifts the boundary to the assistant tool-call message instead of separating the pair.
- If a trailing tool-result block would otherwise push the chunk over target, OpenClaw preserves that pending tool block and keeps the unsummarized tail intact.
- Aborted/error tool-call blocks do not hold a pending split open.

## When auto-compaction happens

The built-in OpenClaw runtime has three scheduling paths:

1. **Overflow recovery**: the model returns a context-overflow error (`request_too_large`, `context length exceeded`, `input exceeds the maximum number of tokens`, `input token count exceeds the maximum number of input tokens`, `input is too long for the model`, `ollama error: context length exceeded`, and other provider-shaped variants) - compact, then retry. When the provider reports the attempted token count, OpenClaw forwards that observed count into overflow-recovery compaction; if the provider confirms overflow but exposes no parseable count, OpenClaw passes a minimally over-budget synthetic count to compaction engines and diagnostics. If overflow recovery still fails, OpenClaw surfaces explicit guidance and preserves the current session mapping instead of silently rotating to a fresh session id - retry the message, run `/compact`, or run `/new`.

   One provider shape is terminal rather than compaction-recoverable. When the refusal states a single request larger than the provider's entire token limit - Groq answers an oversized request with an HTTP 413 naming TPM and stating `Limit <n>, Requested <m>` - no bucket state can admit it. Compaction budgets against the model's context window rather than that per-request ceiling, and its own summarization request is refused by the same ceiling, so it can only spend further calls that cannot succeed. OpenClaw surfaces the reset guidance immediately instead of compacting, adopting a successor transcript, or retrying. Ordinary TPM throttling, which states a requested size within the limit, stays a rate limit and keeps its normal backoff.

2. **Usage-based maintenance**: replies and direct commands using OpenClaw's managed loop check projected usage before inference. Required memory checkpointing precedes compaction at or above the active model window minus the selected compaction reserve, subject to an applicable server compaction threshold floor. Successful Gateway commands using that loop also schedule optional maintenance after delivering their completed reply; one-shot local commands skip that optional work. Generic CLI backends retain their existing host compaction before delivery, and native backends retain their own compaction policy. The memory-flush soft margin does not lower the blocking threshold. Disabling memory flush does not disable compaction. Direct-command maintenance respects `compaction.enabled: false` and skips a second post-turn compaction when the completed run already compacted.
3. **Session-internal threshold maintenance**: default-mode sessions can also compact when actual context usage exceeds the model window minus the session reserve. Safeguard mode disables this competing session-internal path and leaves proactive scheduling to the maintenance owner above.

The persisted `contextBudgetStatus` is a pre-prompt pressure estimate, not an execution command. Completed direct commands, normal replies, and queued follow-up replies record it when the runtime supplies one. `/status` can show this estimate, marked with `~` and `est`, when fresh token usage is unavailable. Compaction and session resets invalidate old estimates; a completed run without a diagnostic clears the previous one unless that run preserves the session's model state (for example, a heartbeat). Its `route` and `shouldCompact` fields can report pressure while the provider attempt is still admitted. Use completed compaction counts and transcript entries to verify that compaction actually happened.

Two additional guards run outside these paths:

- **Preflight local compaction**: set `agents.defaults.compaction.maxActiveTranscriptBytes` to a positive byte threshold (bytes or a string like `"20mb"`) to trigger local compaction before opening the next run once the active transcript reaches that size. Normal semantic compaction still runs. For Codex app-server sessions, the same threshold caps native rollout transcripts and oversized native threads restart fresh. Unset or `0` disables the guard.
- **Mid-turn precheck**: set `agents.defaults.compaction.midTurnPrecheck.enabled: true` (default `false`) to add a tool-loop guard. After a tool result is appended and before the next model call, OpenClaw estimates prompt pressure using the same preflight budget logic used at turn start. If context no longer fits, the guard does not compact inline - it raises a structured mid-turn precheck signal, stops the current prompt submission, and lets the outer run loop use the existing recovery path (truncate oversized tool results when that is enough, or trigger the configured compaction mode and retry). Works with both `default` and `safeguard` compaction modes, including provider-backed safeguard compaction. Independent of `maxActiveTranscriptBytes`: the byte-size guard runs before a turn opens, mid-turn precheck runs later, after new tool results are appended.

## Compaction settings

```json5
{
  agents: {
    defaults: {
      compaction: {
        enabled: true,
        keepRecentTokens: 20000,
      },
    },
  },
}
```

OpenClaw enforces a built-in reserve for embedded runs and caps it at one quarter of the active model context window. The default reserve remains 20,000 tokens for windows of 80,000 tokens or larger. Smaller windows retain at least three quarters of their capacity for prompts and conversation, while the reserve leaves room for compaction summaries and housekeeping such as the memory flush.

Optional maintenance for chat replies and managed Gateway agent commands has a
fresh session owner and shares the turn's remaining timeout allowance across
memory flushing and compaction. It starts after actual delivery and persistence
settle, even if the bounded follow-up admission wait has already expired.
The completed reply returns first. A new foreground turn cancels and settles
optional maintenance before acquiring the session lane. Restart and session
replacement also cancel stale work. Accepted compaction commits remain accounted
for, and an unlimited command timeout remains unlimited. One-shot local commands using OpenClaw's managed loop
record an intentional skip without marking a memory flush successful.

Set `enabled: false` to disable threshold-driven auto-compaction inside the embedded agent runtime and direct-command post-turn maintenance. OpenClaw's reply preflight and overflow-recovery compaction paths remain available, and manual `/compact` continues to work.

Manual `/compact` uses `agents.defaults.compaction.keepRecentTokens` (default: `20000`) and keeps that recent-tail cut point.

OpenClaw adopts an explicit successor identity returned by a context engine. The built-in SQLite compactor keeps the current session identity. Branch/restore checkpoint actions use a returned successor when present; legacy pre-compaction checkpoint files remain readable while referenced.

## Pluggable compaction providers

Plugins register a compaction provider via `registerCompactionProvider()` on the plugin API. When `agents.defaults.compaction.provider` is set to a registered provider id, the safeguard extension delegates summarization to that provider instead of the built-in `summarizeInStages` pipeline.

- `provider`: id of a registered compaction provider plugin. Leave unset for default LLM summarization. Setting a `provider` forces `mode: "safeguard"`.
- Providers receive the same compaction instructions and identifier-preservation policy as the built-in path, and the safeguard still preserves recent-turn and split-turn suffix context after provider output.
- Built-in safeguard summarization re-distills prior summaries with new messages instead of preserving the full previous summary verbatim.
- Safeguard mode enables built-in summary quality audits by default. After final budgeting, the retained generated body must contain the required headings, and the exact artifact to be persisted must retain pending asks and exact identifiers. Corrective attempts stay within `qualityGuard.maxRetries`; exhaustion or a corrective generation failure cancels before append and leaves the original transcript authoritative. Set `qualityGuard.enabled: false` to skip this behavior. Configured compaction-provider output remains outside the built-in audit loop.
- If the provider fails or returns an empty result, OpenClaw falls back to built-in LLM summarization automatically. Provider-local failures, including timeouts, stay in that guarded fallback and use the built-in quality audit when enabled. Abort/timeout signals the caller explicitly triggered are re-thrown, not swallowed, so cancellation is always respected.

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

Memory flushing runs against a private, detached view of the conversation. Its
internal prompts and replies never enter the original transcript, including when
a new user message interrupts it. Memory-file writes remain durable. Required
preflight excludes the already-admitted waiting user; post-reply flushing includes
the completed turn. Any compaction inside the flush affects only its private view;
the original conversation has a separate compaction step.

Config (`agents.defaults.compaction.memoryFlush`), full reference at [/gateway/config-agents](/gateway/config-agents/heartbeat-compaction-and-streaming#agents-defaults-compaction):

| Key                         | Default | Notes                                                                                                                                                  |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                   | `true`  |                                                                                                                                                        |
| `model`                     | unset   | exact provider/model override for the flush turn only, for example `ollama/qwen3:8b`                                                                   |
| `softThresholdTokens`       | `4000`  | gap below the compaction threshold that triggers a flush                                                                                               |
| `forceFlushTranscriptBytes` | `"2mb"` | force a flush once active transcript history reaches this estimated byte size (or string like `"2mb"`), even if token counters are stale; `0` disables |

For a 32,768-token window, the built-in plan uses an 8,192-token reserve and a
4,000-token soft margin. Early flushing starts at 20,576 projected tokens. Blocking
token compaction starts at 24,576, or later if an applicable server threshold is higher. Between those
thresholds, memory flushing can run without requiring compaction.
The selected memory provider owns the reserve and flush margin; without a flush
plan, maintenance still uses the effective compaction reserve. Nonpositive
thresholds suppress token triggers. Transcript byte guards remain independent.

When memory flush refreshes stale usage, it includes projected messages appended
after the latest valid provider usage report before saving the total as fresh.
The following compaction check therefore accounts for that later transcript growth.

Notes:

- The built-in prompt and system prompt include a `NO_REPLY` hint to suppress delivery.
- When `model` is set, the flush turn uses that model without inheriting the active session's fallback chain, so local-only housekeeping does not silently fall back to a paid conversation model on failure.
- The flush runs once per compaction cycle (tracked in the session row).
- The flush runs only for embedded OpenClaw sessions; CLI backends and heartbeat turns skip it.
- The flush is skipped when the session workspace is read-only (`workspaceAccess: "ro"` or `"none"`).
- See [Memory](/concepts/memory) for the workspace file layout and write patterns.

OpenClaw exposes a `session_before_compact` hook in the extension API, but the flush logic above lives on the Gateway side (`src/auto-reply/reply/memory-flush.ts`, `src/auto-reply/reply/agent-runner-memory.ts`), not on that hook.

## Troubleshooting checklist

- **Session key wrong?** Start with [/concepts/session](/concepts/session) and confirm the `sessionKey` in `/status`.
- **Store vs transcript mismatch?** Confirm the Gateway host and the store path from `openclaw status`.
- **Compaction spam?** Check the model's context window (too small forces frequent compaction) and tool-result bloat (tune session pruning).
- **Every prompt seems to overflow on a small local model?** Confirm the provider reports the correct model context window. OpenClaw can cap the effective reserve only when that window is known.
- **Silent turns leaking?** Confirm the reply starts with the exact silent token `NO_REPLY` (case-insensitive) and you are on a build that includes the streaming-suppression fix (`2026.1.10`+).

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
- [Context engine](/concepts/context-engine)
- [Agent config reference](/gateway/config-agents)
