---
summary: "Plugin hooks: intercept agent, tool, message, session, and Gateway lifecycle events"
title: "Plugin hooks"
read_when:
  - You are building a plugin that needs before_tool_call, before_agent_reply, message hooks, or lifecycle hooks
  - You need to block, rewrite, or require approval for tool calls from a plugin
  - You are deciding between internal hooks and plugin hooks
  - You are projecting OpenClaw cron wakes into an external host scheduler
---

Plugin hooks are in-process extension points for OpenClaw plugins: inspect or
change agent runs, tool calls, message flow, session lifecycle, subagent
routing, installs, or Gateway startup.

Use [internal hooks](/automation/hooks) instead for a small operator-installed
`HOOK.md` script reacting to command and Gateway events such as `/new`,
`/reset`, `/stop`, `agent:bootstrap`, or `gateway:startup`.

## Quick start

Register typed hooks with `api.on(...)` from the plugin entry:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "tool-preflight",
  name: "Tool Preflight",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        if (event.toolName !== "web_search") {
          return;
        }

        return {
          requireApproval: {
            title: "Run web search",
            description: `Allow search query: ${String(event.params.query ?? "")}`,
            severity: "info",
            timeoutMs: 60_000,
            timeoutBehavior: "deny",
          },
        };
      },
      { priority: 50 },
    );
  },
});
```

Handlers that can return decisions or modifications run sequentially in
descending `priority`; same-priority handlers keep registration order.
Observation-only handlers run in parallel, and fire-and-forget observation
dispatches can overlap with later events. Do not use priority to order
observation side effects.

`api.on(name, handler, opts?)` accepts:

| Option      | Effect                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority`  | Ordering; higher runs first.                                                                                                                                                                      |
| `timeoutMs` | Per-hook await budget. When it expires, OpenClaw stops awaiting that handler and moves on. It does not cancel the handler or its side effects. Omit to use the runner's default per-hook timeout. |

Operators can set hook budgets without patching plugin code:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "timeoutMs": 30000,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        }
      }
    }
  }
}
```

`hooks.timeouts.<hookName>` overrides `hooks.timeoutMs`, which overrides the
plugin-authored `api.on(..., { timeoutMs })` value. Each value must be a
positive integer up to 600000 ms. Prefer per-hook overrides for known-slow
hooks so one plugin does not get a longer budget everywhere.

A timed-out handler promise continues running because hook callbacks do not
receive a cancellation signal. The hook dispatch can release its Gateway
admission while that plugin work is still in progress. Plugins that own
long-running work must provide their own cancellation and shutdown lifecycle.

Each hook receives `event.context.pluginConfig`, the resolved config for the
plugin that registered that handler. OpenClaw injects it per handler without
mutating the shared event object other plugins see.

## Hook catalog

Hooks are grouped by the surface they extend. **Bold** names accept a decision
result (block, cancel, override, or require approval); the rest are
observation-only.

**Agent turn**

| Hook                            | Purpose                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `before_model_resolve`          | Override provider or model before session messages load                                  |
| `agent_turn_prepare`            | Consume queued plugin turn injections and add same-turn context before prompt hooks      |
| `before_prompt_build`           | Add dynamic context or system-prompt text before the model call                          |
| `before_agent_start`            | Compatibility-only combined phase; prefer the two hooks above                            |
| **`before_agent_run`**          | Inspect the final prompt and session messages before model submission; can block the run |
| **`before_agent_reply`**        | Short-circuit the model turn with a synthetic reply or silence                           |
| **`before_agent_finalize`**     | Inspect the natural final answer and request one more model pass                         |
| `agent_end`                     | Observe final messages, success state, and run duration                                  |
| `heartbeat_prompt_contribution` | Add heartbeat-only context for background monitor and lifecycle plugins                  |

**Conversation observation**

| Hook                                      | Purpose                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model_call_started` / `model_call_ended` | Sanitized provider/model call metadata: timing, outcome, bounded request-id hashes. No prompt or response content. |
| `llm_input`                               | Provider input: system prompt, prompt, history                                                                     |
| `llm_output`                              | Provider output, usage, and the resolved `contextTokenBudget` when available                                       |

**Tools**

| Hook                       | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| **`before_tool_call`**     | Rewrite tool params, block execution, or require approval |
| `after_tool_call`          | Observe tool results, errors, and duration                |
| `resolve_exec_env`         | Contribute plugin-owned environment variables to `exec`   |
| **`tool_result_persist`**  | Rewrite the assistant message produced from a tool result |
| **`before_message_write`** | Inspect or block an in-progress message write (rare)      |

**Messages and delivery**

| Hook                            | Purpose                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| **`inbound_claim`**             | Claim an inbound message before agent routing (synthetic replies) |
| **`channel_pairing_requested`** | Observe newly created DM pairing requests                         |
| `message_received`              | Observe inbound content, sender, thread, and metadata             |
| **`message_sending`**           | Rewrite outbound content or cancel delivery                       |
| **`reply_payload_sending`**     | Mutate or cancel normalized reply payloads before delivery        |
| `message_sent`                  | Observe outbound delivery success or failure                      |
| **`before_dispatch`**           | Inspect or rewrite an outbound dispatch before channel handoff    |
| **`reply_dispatch`**            | Participate in the final reply-dispatch pipeline                  |

**Sessions and compaction**

| Hook                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start` / `session_end`          | Track session lifecycle boundaries. `reason` is one of `new`, `reset`, `idle`, `daily`, `compaction`, `deleted`, `shutdown`, `restart`, or `unknown`. `shutdown`/`restart` fire from the Gateway shutdown finalizer when the process stops or restarts with active sessions, so plugins (memory, transcript stores) can finalize ghost rows instead of leaving them open across restarts. The finalizer is bounded so a slow plugin cannot block SIGTERM/SIGINT. |
| `before_compaction` / `after_compaction` | Observe or annotate compaction cycles                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `before_reset`                           | Observe session-reset events (`/reset`, programmatic resets)                                                                                                                                                                                                                                                                                                                                                                                                     |

**Subagents**

- `subagent_spawned` / `subagent_ended` - observe subagent launch and completion.
- `subagent_delivery_target` - compatibility hook for completion delivery when no core session binding can project a route.
- `subagent_spawning` - deprecated compatibility hook. Core now prepares `thread: true` subagent bindings through channel session-binding adapters before `subagent_spawned` fires.
- `subagent_spawned` includes `resolvedModel` and `resolvedProvider` when OpenClaw has resolved the child session's native model before launch.
- `subagent_ended` carries `targetSessionKey` (identity - matches `subagent_spawned.childSessionKey`), `targetKind` (`"subagent"` or `"acp"`), `reason`, optional `outcome` (`"ok"`, `"error"`, `"timeout"`, `"killed"`, `"reset"`, or `"deleted"`), optional `error`, `runId`, `endedAt`, `accountId`, and `sendFarewell`. It does **not** include `agentId` or `childSessionKey`; use `targetSessionKey` to correlate with the matching `subagent_spawned` event.

**Lifecycle**

| Hook                             | Purpose                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `gateway_start` / `gateway_stop` | Start or stop plugin-owned services with the Gateway                                                 |
| `deactivate`                     | Deprecated compatibility alias for `gateway_stop`; use `gateway_stop` in new plugins                 |
| `cron_reconciled`                | Reconcile against the complete Gateway cron state after startup or reload                            |
| `cron_changed`                   | Observe Gateway-owned cron lifecycle changes (added, updated, removed, started, finished, scheduled) |
| **`before_install`**             | Inspect staged skill or plugin install material from a loaded plugin runtime                         |

### Channel pairing requests

Use `channel_pairing_requested` when a plugin needs to notify an operator or
write an audit record after an unpaired DM sender creates a pending pairing
request. The hook is dispatched when the request is created; channel delivery of
the pairing reply is not delayed by slow or failing hook handlers.

```typescript
api.on("channel_pairing_requested", async (event) => {
  await notifyOperator({
    text: `New ${event.channel} pairing request from ${event.senderId}: ${event.code}`,
  });
});
```

The hook is observation-only. It does not approve, reject, suppress, or rewrite
the pairing reply. The payload includes the channel, optional `accountId`,
channel-scoped `senderId`, pairing `code`, and channel metadata. Treat the
pairing code as a live single-use approval credential and deliver it only to a
trusted operator sink. Treat `metadata` as untrusted sender-supplied identity
text. The hook does not include the inbound message body or media.

## Debug runtime hooks

Use `before_model_resolve` to switch provider or model for an agent turn - it
runs before model resolution. `llm_output` only runs after a model attempt
produces assistant output.

For proof of the effective session model, inspect runtime registrations, then
use `openclaw sessions` or the Gateway session/status surfaces. To debug
provider payloads, start the Gateway with `--raw-stream` and
`--raw-stream-path <path>` to write raw model stream events to a jsonl file.

## Tool call policy

`before_tool_call` receives:

- `event.toolName`
- `event.params`
- optional `event.toolKind` and `event.toolInputKind`, host-authoritative
  discriminators for tools that intentionally share names; for example, outer
  code-mode `exec` calls use `toolKind: "code_mode_exec"` and include
  `toolInputKind: "javascript" | "typescript"` when the input language is
  known
- optional `event.derivedPaths`, best-effort host-derived target path hints
  for well-known tool envelopes such as `apply_patch`; these paths may be
  incomplete or over-approximate what the tool will actually touch (for
  example, with malformed or partial inputs)
- optional `event.runId`
- optional `event.toolCallId`
- context fields such as `ctx.agentId`, `ctx.sessionKey`, `ctx.sessionId`,
  `ctx.runId`, `ctx.toolKind`, `ctx.toolInputKind`, and diagnostic `ctx.trace`

It can return:

```typescript
type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    onResolution?: (
      decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
    ) => Promise<void> | void;
  };
};
```

Guard behavior for typed lifecycle hooks:

- `block: true` is terminal and skips lower-priority handlers.
- `block: false` is treated as no decision.
- `params` rewrites the tool parameters for execution.
- `requireApproval` pauses the agent run and asks the user through plugin
  approvals. `/approve` can approve both exec and plugin approvals. In Codex
  app-server report-mode native `PreToolUse` relays, this defers to the
  matching app-server approval request; see
  [Codex harness runtime](/plugins/codex-harness-runtime#hook-boundaries).
- A lower-priority `block: true` can still block after a higher-priority hook
  requested approval.
- `onResolution` receives the resolved decision: `allow-once`, `allow-always`,
  `deny`, `timeout`, or `cancelled`.

See [Plugin permission requests](/plugins/plugin-permission-requests) for
approval routing, decision behavior, and when to use `requireApproval` instead
of optional tools or exec approvals.

Plugins that need host-level policy can register trusted tool policies with
`api.registerTrustedToolPolicy(...)`. These run before ordinary
`before_tool_call` hooks and before normal hook decisions. Bundled trusted
policies run first; installed-plugin trusted policies run next in plugin-load
order; ordinary `before_tool_call` hooks run after them. Bundled plugins keep
the existing trusted-policy path. Installed plugins must be explicitly enabled
and declare every policy id in `contracts.trustedToolPolicies`; undeclared ids
are rejected before registration. Policy ids are scoped to the registering
plugin, so different plugins may reuse the same local id. Use this tier only
for host-trusted gates such as workspace policy, budget enforcement, or
reserved workflow safety.

### Exec environment hook

`resolve_exec_env` lets plugins contribute environment variables to `exec`
tool invocations before the command runs. It receives:

- `event.sessionKey`
- `event.toolName`, currently always `"exec"`
- `event.host`, one of `"gateway"`, `"sandbox"`, or `"node"`
- context fields such as `ctx.agentId`, `ctx.sessionKey`,
  `ctx.messageProvider`, and `ctx.channelId`

Return a `Record<string, string>` to merge into the exec environment. Handlers
run in priority order; later results override earlier results for the same
key.

Hook output is filtered through the host exec environment key policy before
merging. `PATH` is always dropped (command resolution and safe-bin checks
depend on it). Invalid keys and dangerous host override keys such as `LD_*`,
`DYLD_*`, `NODE_OPTIONS`, proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY`), and TLS override variables (`NODE_TLS_REJECT_UNAUTHORIZED`,
`SSL_CERT_FILE`, and similar) are dropped. The filtered plugin env is included
in Gateway approval/audit metadata and forwarded to node-host execution
requests.

### Tool result persistence

Tool results can include structured `details` for UI rendering, diagnostics,
media routing, or plugin-owned metadata. Treat `details` as runtime metadata,
not prompt content:

- OpenClaw strips `toolResult.details` before provider replay and compaction
  input so metadata does not become model context.
- Persisted session entries keep only bounded `details`. Oversized details are
  replaced with a compact summary and `persistedDetailsTruncated: true`.
- `tool_result_persist` and `before_message_write` run before the final
  persistence cap. Keep returned `details` small and avoid placing
  prompt-relevant text only in `details`; put model-visible tool output in
  `content`.

## Prompt and model hooks

Use the phase-specific hooks for new plugins:

- `before_model_resolve`: receives only the current prompt and attachment
  metadata. Return `providerOverride` or `modelOverride`.
- `agent_turn_prepare`: receives the current prompt, prepared session
  messages, and any exactly-once queued injections drained for this session.
  Return `prependContext` or `appendContext`.
- `before_prompt_build`: receives the current prompt and session messages.
  Return `prependContext`, `appendContext`, `systemPrompt`,
  `prependSystemContext`, or `appendSystemContext`.
- `heartbeat_prompt_contribution`: runs only for heartbeat turns and returns
  `prependContext` or `appendContext`. Intended for background monitors that
  need to summarize current state without changing user-initiated turns.

`before_agent_start` remains for compatibility. Prefer the explicit hooks
above so the plugin does not depend on a legacy combined phase.

`before_agent_run` runs after prompt construction and before any model input,
including prompt-local image loading and `llm_input` observation. It receives
the current user input as `prompt`, plus loaded session history in `messages`
and the active system prompt. Return `{ outcome: "block", reason, message? }`
to stop the run before the model reads the prompt. `reason` is internal;
`message` is the user-facing replacement. Only `pass` and `block` outcomes are
supported; unsupported decision shapes fail closed.

When a run is blocked, OpenClaw stores only the replacement text in
`message.content` plus non-sensitive block metadata such as the blocking
plugin id and timestamp. The original user text is not retained in transcript
or future context. Internal block reasons are treated as sensitive and
excluded from transcript, history, broadcast, log, and diagnostics payloads.
Observability should use sanitized fields such as blocker id, outcome,
timestamp, or a safe category.

`before_agent_start` and `agent_end` include `event.runId` when OpenClaw can
identify the active run; the same value is also on `ctx.runId`. Cron-driven
runs also expose `ctx.jobId` (the originating cron job id) on the agent-turn
context so hooks can scope metrics, side effects, or state to a specific
scheduled job. `ctx.jobId` is not part of the `before_tool_call` tool context.

For channel-originated runs, `ctx.channel` and `ctx.messageProvider` identify
the provider surface such as `discord` or `telegram`, while `ctx.channelId` is
the conversation target identifier when OpenClaw can derive one from the
session key or delivery metadata.

When sender identity is available, agent hook contexts also include:

- `ctx.senderId` - channel-scoped sender ID (e.g. Feishu `open_id`, Discord
  user ID). Populated when the run originates from a user message with known
  sender metadata.
- `ctx.chatId` - transport-native conversation identifier (e.g. Feishu
  `chat_id`, Telegram `chat_id`). Populated when the originating channel
  provides a native conversation ID.
- `ctx.channelContext.sender.id` - the same sender ID as `ctx.senderId`, under
  a channel-owned object plugins can extend with channel-specific fields.
- `ctx.channelContext.chat.id` - the same conversation ID as `ctx.chatId`,
  under a channel-owned object plugins can extend with channel-specific
  fields.

Core only defines the nested `id` fields. Channel plugins that pass richer
sender or chat metadata through the inbound helper can augment
`PluginHookChannelSenderContext` or `PluginHookChannelChatContext` from
`openclaw/plugin-sdk/channel-inbound`:

```ts
declare module "openclaw/plugin-sdk/channel-inbound" {
  interface PluginHookChannelSenderContext {
    unionId?: string;
    userId?: string;
  }
}
```

Channel plugins pass those fields through the inbound SDK helper:

```ts
buildChannelInboundEventContext({
  // ...
  channelContext: {
    sender: { id: senderOpenId, unionId, userId },
    chat: { id: chatId },
  },
});
```

These fields are optional and absent for system-originated runs (heartbeat,
cron, exec-event).

`ctx.senderExternalId` remains as a deprecated source-compatibility field for
older plugins. Core does not populate it; new channel-specific sender
identities should live under `ctx.channelContext.sender` through module
augmentation.

`agent_end` is an observation hook. Gateway and persistent harness paths run
it fire-and-forget after the turn, while short-lived one-shot CLI paths wait
for the hook promise before process cleanup so trusted plugins can flush
terminal observability or capture state. The hook runner applies a 30 second
timeout so a wedged plugin or embedding endpoint cannot leave the hook promise
pending forever. A timeout is logged and OpenClaw continues; it does not
cancel plugin-owned network work unless the plugin also uses its own abort
signal.

Use `model_call_started` and `model_call_ended` for provider-call telemetry
that should not receive raw prompts, history, responses, headers, request
bodies, or provider request IDs. These hooks include stable metadata such as
`runId`, `callId`, `provider`, `model`, optional `api`/`transport`, terminal
`durationMs`/`outcome`, and `upstreamRequestIdHash` when OpenClaw can derive a
bounded provider request-id hash. When the runtime has resolved
context-window metadata, the hook event and context also include
`contextTokenBudget`, the effective token budget after model/config/agent
caps, plus `contextWindowSource` and `contextWindowReferenceTokens` when a
lower cap was applied.

`before_agent_finalize` runs only when a harness is about to accept a natural
final assistant answer. It is not the `/stop` cancellation path and does not
run when the user aborts a turn. Return `{ action: "revise", reason }` to ask
the harness for one more model pass before finalization, `{ action:
"finalize", reason? }` to force finalization, or omit a result to continue.
Handlers have a 15s default budget; on timeout, OpenClaw logs the failure and
continues with the original final answer.
Codex native `Stop` hooks are relayed into this hook as OpenClaw
`before_agent_finalize` decisions.

When returning `action: "revise"`, plugins can include `retry` metadata to
make the extra model pass bounded and replay-safe:

```typescript
type BeforeAgentFinalizeRetry = {
  instruction: string;
  idempotencyKey?: string;
  maxAttempts?: number;
};
```

`instruction` is appended to the revision reason sent to the harness.
`idempotencyKey` lets the host count retries for the same plugin request
across equivalent finalize decisions, and `maxAttempts` caps how many extra
passes the host will allow before continuing with the natural final answer.

Non-bundled plugins that need raw conversation hooks (`before_model_resolve`,
`before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`,
`agent_end`, or `before_agent_run`) must set:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Prompt-mutating hooks and durable next-turn injections can be disabled per
plugin with `plugins.entries.<id>.hooks.allowPromptInjection=false`.

### Session extensions and next-turn injections

Workflow plugins can persist small JSON-compatible session state with
`api.session.state.registerSessionExtension(...)` and update it through the
Gateway `sessions.pluginPatch` method. Session rows project registered
extension state through `pluginExtensions`, letting Control UI and other
clients render plugin-owned status without learning plugin internals.
`api.registerSessionExtension(...)` still works but is deprecated in favor of
the `api.session.state` namespace.

Use `api.session.workflow.enqueueNextTurnInjection(...)` when a plugin needs
durable context to reach the next model turn exactly once (the top-level
`api.enqueueNextTurnInjection(...)` is a deprecated alias with the same
behavior). OpenClaw drains queued injections before prompt hooks, drops
expired injections, and deduplicates by `idempotencyKey` per plugin. This is
the right seam for approval resumes, policy summaries, background monitor
deltas, and command continuations that should be visible to the model on the
next turn but should not become permanent system prompt text.

Cleanup semantics are part of the contract. Session extension cleanup and
runtime lifecycle cleanup callbacks receive `reset`, `delete`, `disable`, or
`restart`. The host removes the owning plugin's persistent session extension
state and pending next-turn injections for reset/delete/disable; restart
keeps durable session state while cleanup callbacks let plugins release
scheduler jobs, run context, and other out-of-band resources for the old
runtime generation.

## Message hooks

Use message hooks for channel-level routing and delivery policy:

- `message_received`: observe inbound content, sender, `threadId`,
  `messageId`, `senderId`, optional run/session correlation, and metadata.
- `message_sending`: rewrite `content` or return `{ cancel: true }`.
- `reply_payload_sending`: rewrite normalized `ReplyPayload` objects
  (including `presentation`, `delivery`, media refs, and text) or return
  `{ cancel: true }`.
- `message_sent`: observe final success or failure.

For audio-only TTS replies, `content` may contain the hidden spoken
transcript even when the channel payload has no visible text/caption.
Rewriting that `content` updates the hook-visible transcript only; it is not
rendered as a media caption.

`reply_payload_sending` events may include `usageState`, a best-effort live
per-turn model/usage/context snapshot. Durable delivery, recovered replay, and
replies without exact run correlation omit it.

Message hook contexts expose stable correlation fields when available:
`ctx.sessionKey`, `ctx.runId`, `ctx.messageId`, `ctx.senderId`, `ctx.trace`,
`ctx.traceId`, `ctx.spanId`, `ctx.parentSpanId`, and `ctx.callDepth`. Inbound
and `before_dispatch` contexts also expose reply metadata when the channel
has visibility-filtered quoted message data: `replyToId`, `replyToIdFull`,
`replyToBody`, `replyToSender`, and `replyToIsQuote`. Prefer these
first-class fields before reading legacy metadata.

Prefer typed `threadId` and `replyToId` fields before using channel-specific
metadata.

Decision rules:

- `message_sending` with `cancel: true` is terminal.
- `message_sending` with `cancel: false` is treated as no decision.
- Rewritten `content` continues to lower-priority hooks unless a later hook
  cancels delivery.
- `reply_payload_sending` runs after payload normalization and before channel
  delivery, including replies routed back to the originating channel.
  Handlers run sequentially and each handler sees the latest payload produced
  by higher-priority handlers.
- `reply_payload_sending` payloads do not expose runtime trust markers such as
  `trustedLocalMedia`; plugins can edit payload shape but cannot grant local
  media trust.
- `message_sending` can return `cancelReason` and bounded `metadata` with a
  cancellation. New message lifecycle APIs expose this as a suppressed
  delivery outcome with reason `cancelled_by_message_sending_hook`; legacy
  direct delivery keeps returning an empty result array for compatibility.
- `message_sent` is observation-only. Handler failures are logged and do not
  change the delivery result.

## Install hooks

Use `security.installPolicy` for operator-owned allow/block decisions. That
policy runs from OpenClaw config, covers CLI install and update paths, and
fails closed when enabled but unavailable.

`before_install` is a plugin-runtime lifecycle hook. It runs after
`security.installPolicy` only in the OpenClaw process where plugin hooks have
already been loaded, such as Gateway-backed install flows. It is useful for
plugin-owned observations, warnings, and compatibility checks, but it is not
the primary enterprise or host security boundary for installs. The
`builtinScan` field remains in the event payload for compatibility, but
OpenClaw no longer runs built-in install-time dangerous-code blocking, so it
is an empty `ok` result. Return additional findings or
`{ block: true, blockReason }` to stop the install in that process.

`block: true` is terminal. `block: false` is treated as no decision. Handler
failures block the install fail-closed.

## Gateway lifecycle

Use `gateway_start` to start general plugin services and `gateway_stop` to
clean up long-running resources. The cron scheduler can still be loading when
`gateway_start` runs, so do not use it as the baseline signal for an external
cron projection.

Do not rely on the internal `gateway:startup` hook for plugin-owned runtime
services.

`cron_reconciled` fires after the Gateway cron scheduler and its on-exit
watchers have reconciled their durable state. It fires for both initial
startup and scheduler replacement during config reload. The event reports
`reason` (`startup` or `reload`) and the effective `enabled` state. Disabled
cron still emits with `enabled: false`, allowing an external projection to
clear stale wakes. Use `ctx.getCron?.()` for the exact scheduler instance that
completed reconciliation; a later reload does not retarget that callback.
This is a scheduler lifecycle signal, not a plugin-activation signal: a
plugin-only hot reload does not replay it. A newly enabled consumer receives
its first baseline on the next scheduler replacement or Gateway start.

Like other observation hooks, `gateway_start` and `cron_reconciled` callbacks
can overlap. If both handlers share plugin initialization, coordinate them
with a plugin-local readiness promise rather than depending on callback order.

`cron_changed` fires for Gateway-owned cron lifecycle events with a typed
event payload covering `added`, `updated`, `removed`, `started`, `finished`,
and `scheduled` reasons. The event carries a `PluginHookGatewayCronJob`
snapshot (including `state.nextRunAtMs`, `state.lastRunStatus`, and
`state.lastError` when present) plus a `PluginHookGatewayCronDeliveryStatus`
of `not-requested` | `delivered` | `not-delivered` | `unknown`. Removed events
are post-commit: they fire only after durable deletion succeeds and still carry
the deleted job snapshot so external schedulers can reconcile state.

A `scheduled` event is post-commit: it fires only after a successful durable
write changes an existing job's effective `nextRunAtMs`, excluding that job's
explicit `added`, `updated`, or `removed` lifecycle event. The top-level
`event.nextRunAtMs` is the committed next wake; when it is absent, the job has
no next wake. Treat these events as reconciliation hints, not an ordered delta
log. Use them as coalescible hints to reread the scheduler last captured by
`cron_reconciled`; do not adopt the scheduler from a `cron_changed` context.
Keep OpenClaw as the source of truth for due checks and execution.

### Safe external cron projection

Project a complete wake snapshot instead of forwarding cron event deltas. The
external adapter's `replaceAll` operation must be atomic and idempotent, and it
must resolve only after the host has durably accepted the snapshot. It must
also honor the supplied abort signal: if the signal aborts before durable
acceptance, the adapter must not accept that snapshot.

This pattern keeps one latest-state worker in flight. Only `cron_reconciled`
adopts a scheduler instance; `cron_changed` merely asks that worker to reread
the authoritative instance, so a late hint cannot restore an older scheduler.
A newer revision aborts the active host attempt before it can accept a stale
snapshot.

```typescript
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type ExternalWake = { jobId: string; runAtMs: number };

type ExternalWakeHost = {
  replaceAll(wakes: readonly ExternalWake[], options: { signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
};

type CronReader = {
  list(options: { includeDisabled: true }): Promise<
    Array<{
      id: string;
      enabled?: boolean;
      state?: { nextRunAtMs?: number };
    }>
  >;
};

export function registerCronProjection(api: OpenClawPluginApi, host: ExternalWakeHost) {
  const lifecycle = new AbortController();
  let cron: CronReader | undefined;
  let enabled = false;
  let hasBaseline = false;
  let requestedRevision = 0;
  let appliedRevision = 0;
  let worker = Promise.resolve();
  let activeAttempt: AbortController | undefined;

  const projectLatest = async () => {
    let retryMs = 1_000;

    while (!lifecycle.signal.aborted && appliedRevision < requestedRevision) {
      const targetRevision = requestedRevision;
      const attempt = new AbortController();
      const signal = AbortSignal.any([lifecycle.signal, attempt.signal]);
      activeAttempt = attempt;

      try {
        const jobs = enabled && cron ? await cron.list({ includeDisabled: true }) : [];
        if (signal.aborted || targetRevision !== requestedRevision) {
          continue;
        }
        const wakes = jobs
          .flatMap((job): ExternalWake[] => {
            const runAtMs = job.enabled === false ? undefined : job.state?.nextRunAtMs;
            return runAtMs === undefined ? [] : [{ jobId: job.id, runAtMs }];
          })
          .sort((a, b) => a.runAtMs - b.runAtMs || a.jobId.localeCompare(b.jobId));

        await host.replaceAll(wakes, { signal });
        if (signal.aborted || targetRevision !== requestedRevision) {
          continue;
        }
        appliedRevision = targetRevision;
        retryMs = 1_000;
      } catch {
        if (lifecycle.signal.aborted) {
          return;
        }
        if (attempt.signal.aborted) {
          continue;
        }
        api.logger.warn(`external cron projection failed; retrying in ${retryMs}ms`);
        try {
          await sleep(retryMs, undefined, { signal });
        } catch {
          if (lifecycle.signal.aborted) {
            return;
          }
          if (attempt.signal.aborted) {
            continue;
          }
        }
        retryMs = Math.min(retryMs * 2, 30_000);
      } finally {
        if (activeAttempt === attempt) {
          activeAttempt = undefined;
        }
      }
    }
  };

  const requestProjection = () => {
    const targetRevision = ++requestedRevision;
    activeAttempt?.abort();
    worker = worker.then(async () => {
      if (!lifecycle.signal.aborted && appliedRevision < targetRevision) {
        await projectLatest();
      }
    });
    return worker;
  };

  api.on("cron_reconciled", (event, ctx) => {
    const reconciledCron = ctx.getCron?.();
    if (event.enabled && !reconciledCron) {
      api.logger.warn("cron reconciliation did not expose a scheduler");
      return;
    }
    cron = reconciledCron;
    enabled = event.enabled;
    hasBaseline = true;
    return requestProjection();
  });

  api.on("cron_changed", () => {
    if (hasBaseline) {
      return requestProjection();
    }
  });

  api.on("gateway_stop", async () => {
    lifecycle.abort();
    await worker;
    await host.close();
  });
}
```

When `cron_reconciled` reports `enabled: false`, the same path calls
`replaceAll([])` and clears stale external wakes. Retry/backoff in this example
is process-local and treats runtime adapter failures as transient; validate
non-retryable configuration before registration. OpenClaw does not provide an
outbox for plugin hook effects. If the process exits before durable acceptance,
the next Gateway start emits a new authoritative `cron_reconciled` snapshot.
`gateway_stop` aborts in-flight host work, waits for the worker to settle, then
closes the adapter.

## Upcoming deprecations

A few hook-adjacent surfaces are deprecated but still supported. Migrate
before the next major release:

- **Plaintext channel envelopes** in `inbound_claim` and `message_received`
  handlers. Read `BodyForAgent` and the structured user-context blocks
  instead of parsing flat envelope text. See
  [Plaintext channel envelopes → BodyForAgent](/plugins/sdk-migration#active-deprecations).
- **`before_agent_start`** remains for compatibility. New plugins should use
  `before_model_resolve` and `before_prompt_build` instead of the combined
  phase.
- **`subagent_spawning`** remains for compatibility with older plugins, but
  new plugins should not return thread routing from it. Core prepares
  `thread: true` subagent bindings through channel session-binding adapters
  before `subagent_spawned` fires.
- **`deactivate`** remains as a deprecated cleanup compatibility alias until
  after 2026-08-16. New plugins should use `gateway_stop`.
- **`onResolution` in `before_tool_call`** now uses the typed
  `PluginApprovalResolution` union (`allow-once` / `allow-always` / `deny` /
  `timeout` / `cancelled`) instead of a free-form `string`.
- **`api.registerSessionExtension` / `api.enqueueNextTurnInjection`** remain
  as top-level compatibility aliases. New plugins should use
  `api.session.state.registerSessionExtension(...)` and
  `api.session.workflow.enqueueNextTurnInjection(...)`.

For the full list - memory capability registration, provider thinking
profile, external auth providers, provider discovery types, task runtime
accessors, and the `command-auth` → `command-status` rename - see
[Plugin SDK migration → Active deprecations](/plugins/sdk-migration#active-deprecations).

## Related

- [Plugin SDK migration](/plugins/sdk-migration) - active deprecations and removal timeline
- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Internal hooks](/automation/hooks)
- [Plugin architecture internals](/plugins/architecture-internals)
