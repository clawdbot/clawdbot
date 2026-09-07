---
summary: "Heartbeat runs, system agent, compaction, context pruning, block streaming, and typing indicators"
read_when:
  - Scheduling heartbeat runs or the system agent
  - Tuning auto-compaction or context pruning
  - Changing how partial replies and typing indicators are sent
title: "Configuration — agent heartbeat, compaction, and streaming"
---

`agents.defaults.*` keys that govern when an agent runs on its own, how its transcript is compacted and pruned, and how partial output reaches a chat.

## `agents.defaults.heartbeat`

Periodic heartbeat runs.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        agentId: "ops", // ambient owner when no per-agent heartbeat is configured
        every: "30m", // 0m disables recurring cadence
        activeHours: { start: "08:00", end: "24:00" },
        model: "openai/gpt-5.4-mini",
        session: "main",
        target: "owner", // default | options: last | none | whatsapp | telegram | discord | ...
        directPolicy: "allow", // allow (default) | block
        to: "+15555550123",
        accountId: "ops-bot",
        prompt: "Follow the heartbeat monitor scratch context...",
        timeoutSeconds: 45,
        lightContext: false, // default: false; true skips workspace bootstrap files for heartbeat runs
        isolatedSession: false, // default: false; true runs each heartbeat in a fresh session (no conversation history)
      },
    },
  },
}
```

- `every`: duration string (ms/s/m/h). Default: `30m` (API-key auth) or `1h` (OAuth auth). Set to `0m` to disable recurring cadence. Targeted event-driven wakes, including background exec completion follow-ups, can still run one agent turn.
- `agentId`: explicit owner for ambient heartbeat runs when no `agents.entries.*.heartbeat` block exists. A shared heartbeat block without `agentId` keeps the existing all-agent enrollment behavior.
- Cadence is written into a system-owned cron monitor row. Run `openclaw doctor --fix` to materialize a missing or stale row. If cron is disabled, scheduled heartbeats do not run and the gateway logs a startup warning.
- The heartbeat object is strict. Its supported fields are `agentId`, `every`, `activeHours`, `model`, `session`, `target`, `directPolicy`, `to`, `accountId`, `prompt`, `timeoutSeconds`, `lightContext`, and `isolatedSession`.
- `timeoutSeconds`: maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use `agents.defaults.timeoutSeconds` when set, otherwise the heartbeat cadence capped at 600 seconds.
- `directPolicy`: direct/DM delivery policy. `allow` (default) permits direct-target delivery. `block` suppresses direct-target delivery and emits `reason=dm-blocked`.
- `target`: `owner` (default) sends only to a direct-message identity from `commands.ownerAllowFrom` or channel `allowFrom`. `last` explicitly follows the latest conversation, including groups. `none` keeps results internal.
- `to`: used only with an explicit channel target. `owner` and an unset target ignore it.
- `lightContext`: when true, heartbeat runs use lightweight bootstrap context and skip workspace bootstrap files. Monitor scratch is injected by the heartbeat runner either way.
- `isolatedSession`: when true, each heartbeat runs in a fresh session with no prior conversation history. Same isolation pattern as cron `sessionTarget: "isolated"`. Reduces per-heartbeat token cost from ~100K to ~2-5K tokens.
- Busy deferral is automatic: scheduled heartbeats wait for main/cron activity, same-agent active runs, and target-session work. Immediate and manual wakes bypass only the broad same-agent active-run precheck.
- Heartbeat runs use the ordinary agent system prompt. Acknowledgment suppression uses a fixed 300-character remainder budget, reasoning payloads remain internal, and tool error warnings remain enabled.
- Per-agent: set `agents.entries.*.heartbeat`. When any agent defines `heartbeat`, **only those agents** run heartbeats.
- Heartbeats run full agent turns — shorter intervals burn more tokens.

## `agents.defaults.systemAgent`

Selects the agent whose model and credentials own ambient OpenClaw system work: system-agent and Custodian consults, and the fallback owner whenever an ambient path omits `agentId`. That includes `models.list`, `models.authStatus`, `skills.status`, and `doctor.memory.status`, the default agent directory and workspace behind auth, model-catalog, and doctor resolution, outbound channel bootstrap and queued-delivery recovery, unscoped main-session routing, Talk relay ownership, and first-run onboarding:

```json5
{
  agents: {
    defaults: {
      systemAgent: { agentId: "ops" },
    },
  },
}
```

An explicit request `agentId` always wins, followed by `systemAgent.agentId`, a retained legacy default owner, and finally the sole configured agent. Delegated consults with a requesting agent keep that requester as their owner. The four reads above opt in individually; other agent-scoped Gateway methods, such as `tools.*`, `commands.*`, chat history, and session-catalog reads, do not use this setting as a general default. Surfaces that pick one agent's view also keep requiring an explicit choice, because silently adopting this owner would hide the other agents: `openclaw sessions` (add `--agent <id>` or `--all-agents`), `openclaw hooks` status, `openclaw models`, stored session lookup by id, and TUI startup. Ambient work in an ownerless multi-agent fleet fails with an actionable error, except queued-delivery recovery, which records the failing delivery and keeps draining the rest of the queue. Upgrade-only ownership lives at `agents.defaults.authInheritance.agentId` for inherited credentials and `agents.defaults.sessionStore.agentId` for retired `main` session rows or unscoped rows in a fixed `session.store`.

## `agents.defaults.compaction`

```json5
{
  agents: {
    defaults: {
      compaction: {
        enabled: false, // disable embedded proactive auto-compaction (default: true)
        mode: "safeguard", // default | safeguard
        provider: "my-provider", // id of a registered compaction provider plugin (optional)
        thinkingLevel: "low", // optional override; omit for the provider default
        timeoutSeconds: 180,
        keepRecentTokens: 50000,
        recentTurnsPreserve: 3,
        identifierPolicy: "strict", // strict | off
        qualityGuard: { enabled: true, maxRetries: 1 },
        midTurnPrecheck: { enabled: false }, // optional tool-loop pressure check
        postIndexSync: "async", // off | async | await
        postCompactionSections: ["Session Startup", "Red Lines"],
        model: "openrouter/anthropic/claude-sonnet-4-6", // optional compaction-only model override
        maxActiveTranscriptBytes: "20mb", // opt in to preflight local compaction
        notifyUser: true, // notices when compaction starts/completes and on memory-flush degradation (default: false)
        memoryFlush: {
          enabled: true,
          model: "ollama/qwen3:8b", // optional memory-flush-only model override
          softThresholdTokens: 6000,
          forceFlushTranscriptBytes: "2mb",
        },
      },
    },
  },
}
```

- `enabled`: when `false`, disables threshold-driven auto-compaction inside the embedded agent runtime. OpenClaw's preflight and overflow-recovery compaction paths and manual `/compact` remain available. Default: `true`.
- `mode`: `default` or `safeguard` (chunked summarization for long histories). See [Compaction](/concepts/compaction).
- `provider`: id of a registered compaction provider plugin. When set, the provider's `summarize()` is called instead of built-in LLM summarization. Falls back to built-in on failure. Setting a provider forces `mode: "safeguard"`. See [Compaction](/concepts/compaction).
- `thinkingLevel`: thinking level used only for embedded OpenClaw compaction summaries (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, `ultra`, or `inherit`). When omitted, the provider can supply a compaction preference; otherwise it defaults to `low`. Native local Ollama prefers `off` so summarization does not spend its request budget on thinking. Set `inherit` to reuse the session's current thinking level, or choose an explicit level to override the provider default. The selected level is clamped to the compaction model/runtime. Native Codex app-server compaction ignores this setting because the native compact request has no per-operation thinking override; OpenClaw logs a warning when configured.
- `timeoutSeconds`: safety window for each model request in built-in compaction. Multi-stage compaction refreshes the window when its next serial model request starts, so a complete compaction can exceed this value while an unresponsive request is still aborted. Plugin-owned compaction receives one window for the complete operation. Default: `180`.
- `keepRecentTokens`: agent cut-point budget for keeping the most recent transcript tail verbatim. Default: `20000`.
- `recentTurnsPreserve`: number of most recent user/assistant turns kept verbatim outside safeguard summarization. Default: `3`.
- `identifierPolicy`: `strict` (default) or `off`. `strict` prepends built-in opaque identifier retention guidance during compaction summarization.
- `qualityGuard`: bounded validation for built-in safeguard summaries. Enabled by default in safeguard mode. After final budgeting, required headings must remain in the retained generated body, while pending asks and exact identifiers must remain in the exact artifact to be stored. When no attempt passes, OpenClaw preserves the original history and returns a compaction failure instead of storing known-invalid context. Set `enabled: false` to skip the audit. Configured compaction-provider output keeps its existing provider-owned validation behavior.
- `midTurnPrecheck`: optional tool-loop pressure check. When `enabled: true`, OpenClaw checks context pressure after tool results are appended and before the next model call. If the context no longer fits, it aborts the current attempt before submitting the prompt and reuses the existing precheck recovery path to truncate tool results or compact and retry. Works with both `default` and `safeguard` compaction modes. Default: disabled.
- `postIndexSync`: post-compaction session-memory reindex mode. Default: `"async"`. Use `"await"` for strongest freshness, `"async"` for lower compaction latency, or `"off"` only when session-memory sync is handled elsewhere.
- `postCompactionSections`: optional AGENTS.md H2/H3 section names to re-inject after compaction. Leave unset or use `[]` to disable.
- `model`: optional `provider/model-id` or bare alias from `agents.defaults.models` for compaction summarization only. Bare aliases resolve before dispatch; configured literal model IDs retain precedence on collisions. Use this when the main session should keep one model but compaction summaries should run on another; when unset, compaction uses the session's primary model.
- `maxActiveTranscriptBytes`: byte threshold (`number` or strings like `"20mb"`) that opts in to normal local compaction before a run when the transcript window the model sees (everything since the latest compaction or reset, plus its kept tail) reaches the threshold. For Codex app-server sessions, the same threshold caps native rollout transcripts and oversized native threads restart fresh. Disabled when unset or `0`. When a context engine returns an explicit compacted successor identity, OpenClaw adopts it; the built-in SQLite compactor keeps the current identity.
- `notifyUser`: when `true`, sends brief context-maintenance notices to the user: when compaction starts and completes (for example, "Compacting context..." and "Compaction complete"), and when a pre-compaction memory flush is exhausted so the reply continues in a degraded state (for example, "Memory maintenance temporarily failed; continuing your reply."). Disabled by default to keep these notices silent.
- `memoryFlush`: silent agentic turn before auto-compaction to store durable memories. Set `model` to an exact provider/model such as `ollama/qwen3:8b` when this housekeeping turn should stay on a local model; the override does not inherit the active session fallback chain. `forceFlushTranscriptBytes` forces the flush when the model-visible transcript window reaches the threshold even if token counters are stale; after compaction, that window includes the retained tail and subsequent turns rather than discarded history. Skipped when workspace is read-only.

Custom compaction instructions are code-owned. Implement a compaction provider
plugin with `summarize()` for custom summary construction, and use
`before_prompt_build` when post-compaction context must be injected into later
model prompts. Doctor strips the retired instruction fields and points to these
seams.

## `agents.defaults.contextPruning`

Prunes **old tool results** from in-memory context before sending to the LLM. Does **not** modify session history on disk. Disabled by default; set `mode: "cache-ttl"` to enable.

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl", // off (default) | cache-ttl
      },
    },
  },
}
```

<Accordion title="cache-ttl mode behavior">

- `mode: "cache-ttl"` enables pruning passes.
- Pruning soft-trims oversized tool results first, then hard-clears older tool results if needed.

**Soft-trim** keeps beginning + end and inserts `...` in the middle.

**Hard-clear** replaces the entire tool result with the placeholder.

Notes:

- Image blocks are never trimmed/cleared.
- Ratios are character-based (approximate), not exact token counts.
- The most recent assistant messages are preserved.

</Accordion>

See [Session Pruning](/concepts/session-pruning) for behavior details.

## Block streaming

```json5
{
  agents: {
    defaults: {
      blockStreamingDefault: "off", // on | off
      blockStreamingBreak: "text_end", // text_end | message_end
      blockStreamingChunk: { minChars: 800, maxChars: 1200, breakPreference: "paragraph" },
      blockStreamingCoalesce: { idleMs: 1000 },
      humanDelay: { mode: "natural" }, // off (default) | natural | custom (use minMs/maxMs)
    },
  },
}
```

- Non-Telegram channels require explicit `*.streaming.block.enabled: true` to enable block replies. QQ Bot is the exception: it has no `streaming.block` keys and streams block replies unless `channels.qqbot.streaming.mode` is `"off"`.
- Channel overrides: `channels.<channel>.streaming.block.coalesce` (and per-account variants). Discord, Google Chat, Mattermost, MS Teams, Signal, and Slack default `minChars: 1500` / `idleMs: 1000`.
- `blockStreamingChunk.breakPreference`: preferred chunk boundary (`"paragraph" | "newline" | "sentence"`).
- `humanDelay`: randomized pause between block replies. Default: `off`. `natural` = 800-2500ms. `custom` uses `minMs`/`maxMs` (falls back to the natural range for any unset bound). Per-agent override: `agents.entries.*.humanDelay`.

See [Streaming](/concepts/streaming) for behavior + chunking details.

## Typing indicators

```json5
{
  agents: {
    defaults: {
      typingMode: "instant", // never | instant | thinking | message
      typingIntervalSeconds: 6,
    },
  },
}
```

- Defaults: `instant` for direct chats/mentions, `message` for unmentioned group chats.
- `typingIntervalSeconds` default: `6`.
- Per-agent override: `agents.entries.*.typingMode`.

See [Typing Indicators](/concepts/typing-indicators).
