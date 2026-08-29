---
summary: "Plugin hooks: intercept agent, tool, message, session, and Gateway lifecycle events"
title: "Plugin hooks"
doc-schema-version: 1
read_when:
  - You are building a plugin that needs before_tool_call, before_agent_reply, message hooks, or lifecycle hooks
  - You need to block, rewrite, or require approval for tool calls from a plugin
  - You are deciding between internal hooks and plugin hooks
  - You are projecting OpenClaw cron wakes into an external host scheduler
---

Plugin hooks let a native OpenClaw plugin observe or change agent runs, tool
calls, message delivery, and lifecycle events. Register a typed handler with
`api.on("hook_name", handler)` and return the result documented for that hook.

There are three different hook systems:

| You want to…                                                                        | Use                                                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Change prompts, gate tools, customize replies, or integrate plugin lifecycle        | Typed plugin hooks on this page: `api.on("before_tool_call", ...)`                                              |
| Run an operator-installed script for `/new`, `/reset`, `/stop`, or bootstrap events | [Internal hooks](/automation/hooks): `HOOK.md` and colon event names such as `command:new` or `agent:bootstrap` |
| Trigger an agent from an external service over HTTP                                 | [Webhooks](/automation/cron-jobs#webhooks): Gateway HTTP endpoints                                              |

Plugins can also register internal hooks with `api.registerHook(...)`. That is
not the typed API: registering an underscore name such as `before_tool_call`
there produces a warning, and the typed runner never invokes that registration.
Use `api.on(...)` for every hook in this page's catalog.

## Quick start

This example replies to a user message containing `hook-demo-check` without
calling the model.
It assumes you already have a working Gateway and can send it a normal chat
message. For package metadata, publishing, and install options, see
[Building plugins](/plugins/building-plugins) and [Plugin manifest](/plugins/manifest).

Create a local `hook-demo` directory with these files:

```json package.json
{
  "name": "hook-demo",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "extensions": ["./index.ts"] }
}
```

```json openclaw.plugin.json
{
  "id": "hook-demo",
  "name": "Hook Demo",
  "activation": { "onStartup": true },
  "configSchema": { "type": "object", "additionalProperties": false }
}
```

```typescript index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "hook-demo",
  name: "Hook Demo",
  description: "Reply to a hook check without a model call.",
  register(api) {
    api.on(
      "before_agent_reply",
      (event) => {
        if (event.cleanedBody.includes("hook-demo-check")) {
          return { handled: true, reply: { text: "Hook is working." } };
        }
      },
      { eligibleTriggers: ["user"] },
    );
  },
});
```

Review local plugin code before loading it: native plugins run in the Gateway
process. Link and enable the directory (`--force` acknowledges installing from
a local source):

```bash
openclaw plugins install --link ./hook-demo --force
openclaw plugins enable hook-demo
```

Grant this plugin access to conversation hooks in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hook-demo": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Merge that entry into your existing config, then restart and inspect:

```bash
openclaw gateway restart
openclaw plugins inspect hook-demo --runtime --json
```

Send `hook-demo-check` as a normal chat message. Expect `Hook is working.`; other
messages continue through the normal agent path. If the hook does not run,
see [Troubleshooting](/plugins/hooks#troubleshooting).

Despite its name, `cleanedBody` is the prepared run prompt and can contain
channel context. The example matches a distinctive marker instead of assuming
the field is only the sender's raw text.

### Permissions and scope

Hook registration does not bypass plugin loading rules. The plugin must be
loaded and enabled; `plugins.enabled`, `plugins.allow`, and `plugins.deny` still
apply. Restart the Gateway after changing plugin code or hook configuration.

- Non-bundled plugins need explicit
  `plugins.entries.<id>.hooks.allowConversationAccess: true` for
  `before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`,
  `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`,
  `agent_end`, and `before_agent_run`. Bundled plugins are allowed unless this
  option is explicitly `false`.
- `allowPromptInjection: false` blocks `agent_turn_prepare`,
  `before_prompt_build`, `heartbeat_prompt_contribution`, and durable next-turn
  injections. It defaults to allowed, but does not grant conversation access.
  The first two hooks therefore need both permissions.
- These are specific registration gates, not a sandbox or a universal filter
  for every hook that can see message data. Install only plugins you trust.

A typed handler receives `(event, ctx)`. The event describes the operation;
the second argument carries hook-specific context. Fields such as
`ctx.agentId`, `ctx.sessionKey`, and `ctx.runId` are optional on many hooks and
may be absent for the emitting path. A registration is not automatically
scoped to one agent or session: check the context in your handler when needed.

Read your plugin's resolved settings from `api.pluginConfig` inside the
registration closure. Typed hooks do not receive a universal
`event.context.pluginConfig` field; that field belongs to the internal
`api.registerHook(...)` event contract.

### Choose a hook

| Task                                               | Hook                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Reply without a model call                         | `before_agent_reply` → `{ handled: true, reply }`; omit `reply` for silence |
| Add context or narrow tools for a turn             | `before_prompt_build`                                                       |
| Gate model input on a supported runner             | `before_agent_run` → `{ outcome: "block", reason, message? }`               |
| Block a tool or request approval                   | `before_tool_call`                                                          |
| Rewrite the full outgoing reply, including media   | `reply_payload_sending`                                                     |
| Rewrite outgoing text or cancel a send             | `message_sending`                                                           |
| Collect model timing without raw conversation text | `model_call_started` / `model_call_ended`                                   |
| Flush state after a turn or at shutdown            | `agent_end` / `gateway_stop`                                                |

The catalog is the registration API, not a promise that every runtime emits
every hook. For example, `before_agent_run` is implemented by the embedded and
CLI runners; do not rely on it as a Codex or Copilot input gate. Native tool,
transcript, and compaction boundaries also differ. See
[Codex hook boundaries](/plugins/codex-harness-runtime#hook-boundaries) and
[Agent harness plugins](/plugins/sdk-agent-harness).

## Registration and execution

Keep `register(api)` synchronous and register handlers there. The handlers
themselves may be asynchronous except for the two synchronous persistence hooks.

Handlers default to priority `0`; higher priorities run first, with registration
order breaking ties. Execution depends on the hook kind:

| Kind             | Execution contract                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modify           | Sequential; results merge according to the hook's contract below. Returning a rewrite does not generally change the event passed to later handlers. |
| Claim            | Sequential; the first `{ handled: true }` wins and skips remaining handlers.                                                                        |
| Gate             | Sequential; a block stops remaining handlers.                                                                                                       |
| Observe          | Handlers run concurrently; return values are ignored. The emitter may await completion or dispatch fire-and-forget.                                 |
| Sync modify/gate | Synchronous, in priority order; each handler sees the latest message. Promises are ignored with a warning.                                          |
| Evaluate         | Skill evaluators run concurrently and produce separate attributed outcomes.                                                                         |

Priority does not serialize observation side effects. Fire-and-forget events
can overlap later events, and callbacks are not a durable event queue. Return
modifications explicitly instead of relying on in-place mutation.

`api.on(name, handler, opts?)` accepts:

| Option                  | Effect                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `matcher`               | Non-empty list of canonical OpenClaw tool ids handled by `before_tool_call` or `after_tool_call`, such as `exec`, `apply_patch`, or `spawn_agent`. Omit to match all tools. Empty lists, wildcards, blanks, and provider-specific aliases are invalid. |
| `priority`              | Ordering; higher runs first.                                                                                                                                                                                                                           |
| `registrationId`        | Stable identity for one registration inside a plugin. Skill evaluators use it as `evaluatorId`; otherwise the plugin id is used.                                                                                                                       |
| `timeoutMs`             | Per-handler asynchronous await budget. Expiry applies the hook's failure policy below; it does not cancel the handler or its side effects. Omit to use the runner's default, if any.                                                                   |
| `eligibleTriggers`      | For `before_agent_reply` only, limits host dispatch to one or more of `cron`, `heartbeat`, or `user`.                                                                                                                                                  |
| `eligibleDispatchKinds` | For `reply_dispatch` only, limits host dispatch to `agent`, `acp`, or both. Omit to handle all dispatch kinds.                                                                                                                                         |
| `requiresToolAuthority` | For `before_prompt_build` only, runs the handler after the host finalizes the current turn's tool surface and supplies ephemeral `ctx.toolAuthority`. Use this for context retrieval that must follow tool policy.                                     |

Trigger eligibility is enforced by the host before it invokes the handler. A
hook registered with `eligibleTriggers: ["heartbeat", "cron"]` is therefore
inactive for user turns, including a recovered user turn. Omitted, empty,
malformed, or partly unknown lists remain unrestricted, so the hook runs for
those turns. Other hook kinds do not accept this option.

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
plugin-authored `api.on(..., { timeoutMs })` value. The two operator config
fields accept positive integers up to 600000 ms. Prefer per-hook overrides for
known-slow hooks so one plugin does not get a longer budget everywhere.

A timed-out handler promise continues running because hook callbacks do not
receive a timeout-owned cancellation signal. `before_tool_call` may receive the
owning tool call's `ctx.abortSignal`, but hook timeout expiry does not abort it.
The hook dispatch can release its Gateway admission while that plugin work is
still in progress. Plugins that own long-running work must provide their own
cancellation and shutdown lifecycle.

The standard runner applies these defaults **per handler**:

| Hooks                                                                                                          | Default timeout                     | On thrown error or timeout                                       |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `before_agent_run`, `before_tool_call`, `before_install`                                                       | 15 seconds                          | Fail closed: block the run, tool call, or install                |
| `before_agent_finalize`, `before_prompt_build`, `message_sending`, `reply_payload_sending`, `resolve_exec_env` | 15 seconds                          | Log and skip the failed handler; retain other successful results |
| `agent_end`, `before_compaction`, `after_compaction`, `skill_changed`, `skill_proposal_changed`                | 30 seconds                          | Log and continue                                                 |
| `channel_pairing_requested`                                                                                    | 2 seconds                           | Log and continue                                                 |
| `gateway_stop`                                                                                                 | 5 seconds                           | Log and continue shutdown                                        |
| `skill_proposal_evaluate`                                                                                      | 120 seconds                         | Record an attributed error outcome                               |
| Other asynchronous hooks, including claim hooks                                                                | No runner timeout unless configured | Log and continue                                                 |
| `tool_result_persist`, `before_message_write`                                                                  | No asynchronous timeout             | Synchronous errors are logged; failed results are ignored        |

An emitter can impose a tighter overall lifecycle budget, such as the
shutdown `session_end` drain below. A timeout only bounds an asynchronous
await; it cannot interrupt synchronous JavaScript. For a policy requirement,
use a fail-closed gate rather than assuming an observation or delivery hook
will reject the operation on failure.

For claim hooks, continuing means trying the next handler. The caller decides
what happens if nobody claims; a failed `inbound_claim` for a bound
conversation can produce a binding notice instead of an ordinary agent reply.

Channel plugins that use `createReplyDispatcher` can likewise declare a larger
positive per-stage budget with `beforeDeliverOptions: { timeoutMs }`, or when
appending work with `dispatcher.appendBeforeDeliver(handler, { timeoutMs })`.
Without an owner-declared budget, those callbacks use the same 15-second
default so a hung callback cannot retain the serialized delivery lane.

## Hook catalog

Hooks are grouped by the surface they extend. Kinds refer to the execution
contracts above; a modifying hook is not an observation hook.

**Agent turn**

| Hook                            | Kind    | Purpose                                                                                                     |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `before_model_resolve`          | Modify  | Override provider or model before session messages load                                                     |
| `agent_turn_prepare`            | Modify  | Inspect drained plugin turn injections and add context before prompt hooks                                  |
| `before_prompt_build`           | Modify  | Add prompt context, narrow the current turn's submitted tools, or perform authorized post-policy enrichment |
| `before_agent_run`              | Gate    | Inspect the final prompt and session messages before model submission; can block the run                    |
| `before_agent_reply`            | Claim   | Short-circuit the model turn with a synthetic reply or silence                                              |
| `before_agent_finalize`         | Modify  | Inspect the natural final answer and request one more model pass                                            |
| `agent_end`                     | Observe | Observe final messages, success state, and run duration                                                     |
| `heartbeat_prompt_contribution` | Modify  | Add heartbeat-only context for background monitor and lifecycle plugins                                     |

**Conversation observation**

| Hook                                      | Kind    | Purpose                                                                                                            |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `model_call_started` / `model_call_ended` | Observe | Sanitized provider/model call metadata: timing, outcome, bounded request-id hashes. No prompt or response content. |
| `llm_input`                               | Observe | Provider input: system prompt, prompt, history                                                                     |
| `llm_output`                              | Observe | Provider output, usage, and the resolved `contextTokenBudget` when available                                       |

**Tools**

| Hook                   | Kind               | Purpose                                                    |
| ---------------------- | ------------------ | ---------------------------------------------------------- |
| `before_tool_call`     | Modify / gate      | Rewrite tool params, block execution, or require approval  |
| `after_tool_call`      | Observe            | Observe tool results, errors, and duration                 |
| `resolve_exec_env`     | Modify             | Contribute plugin-owned environment variables to `exec`    |
| `tool_result_persist`  | Sync modify        | Rewrite a toolResult message before transcript persistence |
| `before_message_write` | Sync modify / gate | Rewrite or block a message before transcript persistence   |

**Messages and delivery**

| Hook                        | Kind          | Purpose                                                                    |
| --------------------------- | ------------- | -------------------------------------------------------------------------- |
| `inbound_claim`             | Claim         | Claim an inbound message for the plugin that owns its conversation binding |
| `channel_pairing_requested` | Observe       | Observe newly created DM pairing requests                                  |
| `message_received`          | Observe       | Observe inbound content, sender, thread, and metadata                      |
| `message_sending`           | Modify / gate | Rewrite outbound content or cancel delivery                                |
| `reply_payload_sending`     | Modify / gate | Mutate or cancel normalized reply payloads before delivery                 |
| `message_sent`              | Observe       | Observe outbound delivery success or failure                               |
| `before_dispatch`           | Claim         | Handle an inbound message before the normal model dispatch                 |
| `reply_dispatch`            | Claim         | Own reply generation and dispatch instead of the default model path        |

`inbound_claim` is not a global pre-routing broadcast. OpenClaw invokes it only
for the plugin that owns the message's core-managed conversation binding. To
suppress an ordinary agent turn before model input without retaining the
original prompt in transcript, use `before_agent_run` on a supported runner.
To short-circuit an agent turn with a synthetic reply or silence, use
`before_agent_reply`.

**Sessions and compaction**

| Hook                                     | Kind    | Purpose                                                      |
| ---------------------------------------- | ------- | ------------------------------------------------------------ |
| `session_start` / `session_end`          | Observe | Track session lifecycle boundaries                           |
| `before_compaction` / `after_compaction` | Observe | Observe compaction boundaries; no rewrite or veto result     |
| `before_reset`                           | Observe | Observe session-reset events (`/reset`, programmatic resets) |

`session_end.reason` is one of `new`, `reset`, `idle`, `daily`, `compaction`,
`deleted`, `shutdown`, `restart`, or `unknown`. `session_start` has no reason
field; it can include `resumedFrom`. Shutdown/restart events come from the
Gateway finalizer for active sessions, so plugins can close session state
before the process exits.

Shutdown and restart share one **2-second total `session_end` drain budget**
across all active sessions and plugin handlers; the budget is not per handler.
Return quickly or keep finalization bounded and persistence crash-consistent.
If the budget expires, OpenClaw logs `shutdown session-end drain timed out`
and continues shutdown, so unfinished plugin work can be interrupted.

For `sessions.create` calls with `parentSessionKey` and `emitCommandHooks: true`, a distinct child always receives `session_start`. Callers declare whether the parent also receives terminal `session_end` with `succeedsParent`: `true` means successor, `false` means parallel child. Omission preserves the legacy parent-rollover behavior. The `command:new` and `before_reset` hooks still describe the requested `/new` action in both cases.

**Subagents**

- `subagent_spawned` / `subagent_ended` - observe subagent launch and completion.
- `subagent_progress` - observe portable `started` / `ended` progress for a background child run; includes `runId`, `childSessionKey`, optional requester route, and an outcome on `ended`.
- `subagent_delivery_target` - modifying compatibility hook for completion delivery when no core session binding can project a route. The first returned `origin` wins.
- `subagent_spawned` includes `resolvedModel` and `resolvedProvider` when OpenClaw has resolved the child session's native model before launch.
- `subagent_ended` carries `targetSessionKey` (identity - matches `subagent_spawned.childSessionKey`), `targetKind` (`"subagent"` or `"acp"`), `reason`, optional `outcome` (`"ok"`, `"error"`, `"timeout"`, `"killed"`, `"reset"`, or `"deleted"`), optional `error`, `runId`, `endedAt`, `accountId`, and `sendFarewell`. It does **not** include `agentId` or `childSessionKey`; use `targetSessionKey` to correlate with the matching `subagent_spawned` event.

**Lifecycle**

| Hook                             | Kind          | Purpose                                                                                              |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `gateway_start` / `gateway_stop` | Observe       | Start or stop plugin-owned services with the Gateway                                                 |
| `cron_reconciled`                | Observe       | Reconcile against the complete Gateway cron state after startup or reload                            |
| `cron_changed`                   | Observe       | Observe Gateway-owned cron lifecycle changes (added, updated, removed, started, finished, scheduled) |
| `before_install`                 | Modify / gate | Inspect staged skill or plugin install material from a loaded plugin runtime                         |
| `skill_proposal_evaluate`        | Evaluate      | Evaluate one exact Skill Workshop draft and return attributed findings, metrics, or a decision       |
| `skill_proposal_changed`         | Observe       | Observe durable Skill Workshop proposal lifecycle events after they commit                           |
| `skill_changed`                  | Observe       | Observe committed live-skill create, update, and removal events                                      |

### Skill lifecycle and evaluation

Use `skill_proposal_evaluate` for static analyzers, security scanners,
benchmarks, model-based graders, or other third-party evaluators. OpenClaw
passes an immutable candidate bundle with file hashes and a tree hash. Update
proposals also include the complete current skill as `baseline`. Text files use
UTF-8 content; binary files use base64.

Evaluator registrations run concurrently. Give each evaluator a stable
`registrationId`:

```typescript
api.on(
  "skill_proposal_evaluate",
  async (event) => {
    const score = await evaluateBundle(event.candidate, event.baseline);
    return {
      evaluatorVersion: "rules-2026-07",
      mode: "baseline-comparison",
      decision: score.regressed ? "revise" : "pass",
      summary: score.summary,
      metrics: score.metrics,
      findings: score.findings,
    };
  },
  { registrationId: "quality-regression", timeoutMs: 90_000 },
);
```

When evaluation input includes `correlationId`, OpenClaw forwards it to the
evaluator event for both manual and apply-triggered evaluations. This value is
caller-supplied correlation metadata, not authenticated identity or proof of
authorization. An authorization plugin must mint or replace the value through
a trusted entry point, bind it to the intended operation, and validate and
consume it itself.

Stored outcomes identify the evaluator, plugin id, plugin package version,
status, and returned result. Timeouts and thrown errors are recorded as
attributed error outcomes; they do not fail the whole evaluation. Among
evaluator outcomes, only a completed `decision: "block"` vetoes apply. Other
Workshop validation and ownership checks still apply. Apply revalidates the
evaluated target tree under the Workshop mutation lock, so any live skill asset
drift requires reevaluation.
The complete persisted evaluation envelope is capped at 512 KiB.

`skill_proposal_changed` fires after the matching proposal row and append-only
lifecycle event commit. It carries the event id, sequence, exact proposal
revision hash, optional correlation id, and evaluation outcomes.
`skill_changed` fires after a live skill create, update, or removal commits and
includes optional before/after artifacts with content and tree hashes, plus
declared and source versions when available.

These hooks are primitives, not an optimization scheduler. A plugin or external
controller can observe a durable proposal event, evaluate its exact revision hash,
revise with that hash and a correlation id, then repeat. OpenClaw does not
automatically revise proposals or run an unbounded evaluation loop.
Event replay is byte-bounded and returns `nextSequence` when another page is
available.

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
runs before model resolution. `llm_output` describes an attempt's output when
the runtime emits it; `assistantTexts` can be empty and `lastAssistant` absent,
so the event alone does not prove a successful final answer.

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
- optional `ctx.abortSignal`, which aborts when the owning tool call is
  cancelled; handlers should pass it to cancellable I/O and remove any
  listeners they register
- optional `ctx.requester`, the host-derived requester that initiated the current
  message run. It can include `channel`, `accountId`, `senderId`,
  `senderIsOwner`, and provider-native `roleIds`. Missing fields are unproven,
  not false assurances; fail closed when policy requires them.

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
    /** @deprecated Unresolved approvals always deny. */
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
- Return `params` to rewrite host-owned tool parameters. Each handler sees an
  isolated copy of the original event, not prior returned rewrites. The last
  returned `params` wins until an approval is requested.
- The first `requireApproval` wins, and its plugin id is stamped by the host.
  It freezes the selected parameter snapshot: later handlers can block but
  cannot change the approved parameters.
- Native tool relays can have narrower contracts. Codex native tools support
  blocking and observation, but parameter rewrites are rejected; see
  [Codex hook boundaries](/plugins/codex-harness-runtime#hook-boundaries).
- `requireApproval` pauses the agent run and asks the user through plugin
  approvals. `/approve` can approve both exec and plugin approvals. In Codex
  app-server report-mode native `PreToolUse` relays, this defers to the
  matching app-server approval request; see
  [Codex harness runtime](/plugins/codex-harness-runtime#hook-boundaries).
- A lower-priority `block: true` can still block after a higher-priority hook
  requested approval.
- `onResolution` receives the resolved decision: `allow-once`, `allow-always`,
  `deny`, `timeout`, or `cancelled`.

For example, add this inside `register(api)` to ask before a host-owned
`exec` call. No conversation-access opt-in is needed for `before_tool_call`:

```typescript
api.on(
  "before_tool_call",
  () => ({
    requireApproval: {
      title: "Run command",
      description: "Allow this exec tool call?",
      severity: "info",
      timeoutMs: 60_000,
    },
  }),
  { matcher: ["exec"], priority: 50 },
);
```

### Sender-aware policy in one file

A standalone plugin file can keep deployment-specific policy in code instead
of adding another configuration schema. This example gives owners every tool,
lets configured maintainers use a conservative tool and message-action set,
and exposes `/fix` to senders already authorized by the channel configuration:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const AGENT_ID = "maintenance-agent";
const MAINTAINER_SCOPES = [
  {
    channel: "discord",
    accountId: "operations",
    senderIds: new Set(["maintainer-user-id"]),
    roleIds: new Set(["maintainer-role-id"]),
  },
];
const MAINTAINER_TOOLS = new Set(["read", "web_fetch", "web_search", "session_status", "message"]);
const MAINTAINER_MESSAGE_ACTIONS = new Set(["react", "reply", "thread-create", "thread-reply"]);

export default definePluginEntry({
  id: "maintenance-access",
  name: "Maintenance access",
  description: "Apply sender-aware tool policy to the maintenance agent.",
  register(api) {
    api.on("before_tool_call", (event, ctx) => {
      if (ctx.agentId !== AGENT_ID) {
        return;
      }

      const requester = ctx.requester;
      if (requester?.senderIsOwner === true) {
        return;
      }

      const maintainerScope = requester
        ? MAINTAINER_SCOPES.find(
            (scope) =>
              scope.channel === requester.channel && scope.accountId === requester.accountId,
          )
        : undefined;
      const isMaintainer =
        maintainerScope !== undefined &&
        ((requester?.senderId !== undefined && maintainerScope.senderIds.has(requester.senderId)) ||
          requester?.roleIds?.some((roleId) => maintainerScope.roleIds.has(roleId)) === true);
      if (!isMaintainer) {
        return { block: true, blockReason: "Maintainer access required." };
      }

      if (event.toolName === "message") {
        const action = typeof event.params.action === "string" ? event.params.action : "";
        if (MAINTAINER_MESSAGE_ACTIONS.has(action)) {
          return;
        }
        return { block: true, blockReason: `Owner required for message.${action || "unknown"}.` };
      }

      if (MAINTAINER_TOOLS.has(event.toolName)) {
        return;
      }
      return { block: true, blockReason: `Owner required for ${event.toolName}.` };
    });

    api.registerCommand({
      name: "fix",
      description: "Ask the maintenance agent to investigate and fix an issue.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) =>
        ctx.agentId === AGENT_ID
          ? { continueAgent: true }
          : { text: "This command is only available in the maintenance conversation." },
    });
  },
});
```

Load the file directly and restart the Gateway:

```json5
{
  agents: {
    entries: {
      "maintenance-agent": {
        default: true,
        workspace: "~/.openclaw/workspace-maintenance",
      },
    },
  },
  bindings: [
    {
      agentId: "maintenance-agent",
      match: {
        channel: "discord",
        accountId: "operations",
        peer: { kind: "channel", id: "maintenance-channel-id" },
      },
    },
  ],
  plugins: {
    load: { paths: ["~/.openclaw/policies/maintenance-access.ts"] },
  },
}
```

`AGENT_ID` must name the agent bound to the maintenance conversation. The
binding selects that agent for normal messages and `/fix`; the standalone file
remains the single owner of owner-versus-maintainer tool policy.

`requireAuth: true` reuses each channel's existing sender admission. For
Discord, a guild or channel `users`/`roles` allowlist can authorize the
maintenance audience. Other channels can use stable sender ids. The hook then
applies the finer per-tool decision on every tool call in the run, including
Codex native `PreToolUse` calls. It can veto a tool the model sees, but cannot
add a tool omitted by the host. Existing sandbox, exec approval, owner-only
core-tool, and channel policies still apply; the hook cannot grant past them.

Scope sender and role ids to an exact channel/account pair as shown; both are
provider-local namespaces. Keep the allowlists conservative. Add write or
execution tools only when the deployment's sandbox and approval policy make
that safe. For automated or system runs, decide explicitly whether an absent
`ctx.requester` should pass; the example denies it for the scoped agent.

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

Trusted policies may set `matcher` to the same canonical tool-id list accepted
by `before_tool_call`. Omit the matcher to retain match-all behavior.

### Exec environment hook

`resolve_exec_env` lets plugins contribute environment variables to OpenClaw
`exec` tool invocations before the command runs. It is not a hook for every
harness-native shell. It receives:

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

`tool_result_persist` and `before_message_write` are synchronous hooks. Do not
make their handlers `async`: returned promises are ignored with a warning.
Each handler receives the message returned by the previous handler.
`tool_result_persist` returns `{ message }` to replace a tool result;
`before_message_write` can return `{ message }` or `{ block: true }` to prevent
that transcript write. Blocking persistence is not a tool-execution veto.

These hooks operate on OpenClaw-owned transcript writes. They do not rewrite
Codex-native tool records; see
[Codex transcript boundaries](/plugins/codex-harness-runtime#compaction-and-transcript-mirror).

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
  messages, and queued injections consumed for this session.
  Return `prependContext` or `appendContext`.
- `before_prompt_build`: receives the current prompt and session messages.
  Return `prependContext`, `appendContext`, `systemPrompt`,
  `prependSystemContext`, `appendSystemContext`, or `toolsAllow`. `toolsAllow`
  can only narrow the host-resolved tool surface for the current turn; `[]`
  submits no optional tools, while omitting it leaves the existing surface unchanged.
  Restrictions returned by multiple hooks are intersected. The embedded runner
  and Copilot harness apply this field to their turn-scoped submitted tool
  surfaces. The Codex app-server harness rejects restrictive values because its
  dynamic tools are thread-scoped and Codex `turn/start` has no tool-surface
  override; use the embedded or Copilot runtime when a plugin requires this
  policy.
- `before_prompt_build` with `{ requiresToolAuthority: true }`: runs in a
  second, post-policy phase. Use it when prompt enrichment reads data through
  a tool-backed capability and the same turn must be allowed to call that
  tool. See [Authorized prompt enrichment](/plugins/hooks#authorized-prompt-enrichment).
- `heartbeat_prompt_contribution`: runs only for heartbeat turns and returns
  `prependContext` or `appendContext`. Intended for background monitors that
  need to summarize current state without changing user-initiated turns.

On the embedded and CLI prompt-preparation paths, ordering is: drain queued
injections → `agent_turn_prepare` → heartbeat contribution (if applicable) →
ordinary `before_prompt_build` → finalized tool policy → authorized prompt
enrichment. `agent_turn_prepare` and queued-injection draining are not currently
wired into the Codex or Copilot prompt paths.

For multiple registrations, the first defined provider/model override and
`systemPrompt` win. Context additions concatenate in priority order, and tool
restrictions intersect. A nested ordinary `before_prompt_build` dispatch on
the same runner is skipped while its outer dispatch is active; other hook
families and independent turns remain available.

### Authorized prompt enrichment

Register `before_prompt_build` with `requiresToolAuthority: true` when a plugin
must verify the finalized per-turn tool policy before retrieving context:

```typescript
api.on(
  "before_prompt_build",
  async (event, ctx) => {
    const authority = ctx.toolAuthority;
    if (!authority?.allows("memory_search")) {
      return;
    }

    const recalledContext = await recallForPrompt(event.prompt);
    authority.assertActive();
    return { prependContext: recalledContext };
  },
  { requiresToolAuthority: true },
);
```

The host excludes this handler from the ordinary prompt-build phase. After all
ordinary hooks and tool restrictions settle, a supported runtime invokes it
with `ctx.toolAuthority` bound to that exact active turn and finalized tool
surface. Embedded, CLI, Copilot, and Codex runtimes support this phase. If a
runtime cannot prove the authority, it skips the handler.

Treat `toolAuthority` as an ephemeral capability:

- `allows(toolName)` checks a canonical tool id against the finalized surface
  and also verifies that the capability is still active.
- `assertActive()` rejects after abort, cancellation, run replacement,
  lifecycle rotation, or hook dispatch completion. Call it after awaited work
  and before committing plugin-owned side effects.
- `fingerprint` is opaque cache-partitioning input. It is not a bearer token or
  authorization proof; never persist, transmit, or compare it as authority.
- Return only `prependContext` or `appendContext` from this phase. It cannot
  replace the system prompt or change `toolsAllow` after policy has settled.

The host revalidates authority after each awaited handler and discards stale
enrichment. A retained `toolAuthority` object fails closed after dispatch.

This option requires a host that implements the post-policy phase. Published
plugins must set `package.json` `openclaw.compat.pluginApi` to a range beginning
with the first OpenClaw version they build against for this contract. Older
hosts skip incompatible packages during discovery and reject incompatible
installs or updates. Do not publish a package that uses this option while
claiming compatibility with an older plugin API; an older host may otherwise
treat an unknown option as an ordinary pre-policy hook.

On the embedded and CLI runners, `before_agent_run` runs after prompt
construction and before model submission, including `llm_input` observation.
On the embedded path it also precedes prompt-local image loading. It receives
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

Hooks that expose `event.runId`, such as `agent_end` and
`before_agent_finalize`, receive it when OpenClaw can identify the active run;
the same value is also on `ctx.runId`. Prompt hooks do not all have an event
`runId` field, so use their typed context for correlation. Cron-driven
runs can also expose `ctx.jobId` (the originating cron job id) when supplied
by the emitter, so hooks can scope metrics, side effects, or state to a specific
scheduled job. Do not assume every agent event carries it. `ctx.jobId` is not
part of the `before_tool_call` tool context.

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

`agent_end` is an observation hook. Channel-backed paths generally run
it fire-and-forget after the turn, while local one-shot paths can wait
for the hook promise before process cleanup so trusted plugins can flush
terminal observability or capture state. The hook runner applies a 30 second
default per-handler timeout so a wedged plugin or embedding endpoint cannot
leave the hook promise pending forever. A timeout is logged and OpenClaw continues; it does not
cancel plugin-owned network work unless the plugin also uses its own abort
signal.

Use `model_call_started` and `model_call_ended` for provider-call telemetry
that should not receive raw prompts, history, responses, headers, request
bodies, or provider request IDs. These hooks include stable metadata such as
`runId`, `callId`, `provider`, `model`, optional `api`/`transport`, terminal
`durationMs`/`outcome`, and `upstreamRequestIdHash` when OpenClaw can derive a
bounded provider request-id hash. When the runtime has resolved
context-window metadata, the hook event and context also include
`contextTokenBudget`, the effective token budget after model configuration,
fixed model contracts, and runtime discovery, plus `contextWindowSource` and
`contextWindowReferenceTokens` when a lower cap was applied.

These provider-call hooks are currently emitted by the embedded model-call
path. A harness exposing `llm_input` / `llm_output` does not automatically
expose the same provider-call telemetry. In external harnesses, LLM events
describe adapter-visible input and output, not necessarily the raw provider
request or complete native history.

`before_agent_finalize` runs only when a harness is about to accept a natural
final assistant answer. It is not the `/stop` cancellation path and does not
run when the user aborts a turn. Return `{ action: "revise", reason }` to ask
the harness for one more model pass before finalization, `{ action:
"finalize", reason? }` to force finalization, or omit a result to continue.
Handlers have a 15s default budget; on timeout, OpenClaw logs the failure and
keeps decisions from other handlers. With no revision decision, normal
finalization continues. Multiple `revise` reasons are combined; any `finalize`
decision overrides revision requests. This hook requires a finalization
integration: the embedded runner and native hook relay provide it, but the
Copilot harness does not currently dispatch it.
Codex native `Stop` hooks are relayed into this hook as OpenClaw
`before_agent_finalize` decisions.

When returning `action: "revise"`, plugins can include `retry` metadata to
bound repeated revision requests within a run:

```typescript
type BeforeAgentFinalizeRetry = {
  instruction: string;
  idempotencyKey?: string;
  maxAttempts?: number;
};
```

`instruction` is appended to the revision reason sent to the harness.
`idempotencyKey` lets the host count retries across equivalent finalize
decisions within a run; without a key, it hashes the instruction.
`maxAttempts` defaults to one extra pass for that key. Use a plugin-specific
key to avoid sharing a budget with another plugin. A harness can apply a
tighter overall revision limit; the embedded runner allows at most three.

Conversation access and prompt mutation have separate permission gates; see
[Permissions and scope](/plugins/hooks#permissions-and-scope) before enabling these hooks.

### Session extensions and next-turn injections

Workflow plugins can persist small JSON-compatible session state with
`api.session.state.registerSessionExtension(...)` and update it through the
Gateway `sessions.pluginPatch` method. Session rows project registered
extension state through `pluginExtensions`, letting Control UI and other
clients render plugin-owned status without learning plugin internals.
`api.registerSessionExtension(...)` still works but is deprecated in favor of
the `api.session.state` namespace.

Use `api.session.workflow.enqueueNextTurnInjection(...)` when a plugin needs
durable context queued for the next prompt build (the top-level
`api.enqueueNextTurnInjection(...)` is a deprecated alias with the same
behavior). On the embedded and CLI prompt-preparation paths, OpenClaw drains
queued injections before prompt hooks. It drops expired entries and entries
whose plugin is inactive or has prompt injection disabled. `idempotencyKey`
deduplicates unexpired pending entries for the same plugin and session; the
key can be reused after consumption. Drained entries are reused across retries
within the active run, but consuming an entry is not a receipt that the model
saw it: a later failure can prevent submission. This is the right seam for
approval resumes, policy summaries, background monitor
deltas, and command continuations that should be visible to the model on the
next turn but should not become permanent system prompt text.

Cleanup semantics are part of the contract. Session extension cleanup and
runtime lifecycle cleanup callbacks receive `reset`, `delete`, `disable`, or
`restart`. The host removes the owning plugin's persistent session extension
state and pending next-turn injections for reset/delete/disable; restart
keeps durable session state while cleanup callbacks let plugins release
scheduler jobs, run context, and other out-of-band resources for the old
runtime generation.

Disable cleanup preserves model-locked sessions owned by that plugin's
harness. Restart preserves extension state and pending injections, but can
clear stale promoted top-level session fields.

## Message hooks

For inbound interception, `before_dispatch` receives the incoming message
before ordinary model dispatch. Return `{ handled: true, text: "..." }` to
send a final reply, or `{ handled: true }` to handle it without text. This is a
claim, not an API for rewriting outbound or inbound content.

`reply_dispatch` is the advanced takeover seam: it receives the finalized
message context and a host dispatcher, and a handled result reports
`queuedFinal` and delivery `counts`. Use `before_agent_reply` for a simple
synthetic reply, and the sending hooks below to transform outgoing payloads.

Runtime takeovers should forward `ctx.onAgentRunStart` and
`ctx.userTurnTranscriptRecorder` to their runtime helper. The ACP dispatch
helper forwards both automatically. Share the recorder so the runtime and
Gateway do not append the same user turn independently; mark runtime
persistence only after a successful transcript write.

The optional third `onAgentRunStart` argument can offer
`completionSource: "reply-dispatch"` with a `getResult()` callback. The host must
return `"reply-dispatch"` synchronously to accept completion ownership; observers
and other callback results leave lifecycle completion unchanged. Wrappers must
forward every callback argument and its return value. After dispatch settles,
`getResult()` supplies the canonical `terminalOutcome` and, when an
assistant write succeeded, its `assistantTranscript` receipt (target, message
ID, idempotency key, and optional projection anchor). The host then emits one
chat completion from the delivered, post-hook payloads while retaining runtime
lifecycle events. A receipt prevents a duplicate append; it does not authorize
writes to a replaced session. Omit this declaration for runtimes whose event
stream already owns chat completion.

Use `eligibleDispatchKinds: ["acp"]` for an ACP-only dispatcher. The host
classifies the resolved target, including conversation bindings, and passes
`ctx.dispatchKind` as `acp` or `agent`. Stored ACP metadata and ACP session keys
both select `acp`; a missing ACP binding does not fall back to agent dispatch.
The host applies the same eligibility check before invocation and when deciding
whether a hook prevents durable chat admission. An ACP-only hook therefore
does not block ordinary agent sessions. Omitted, empty, malformed, or partly
unknown eligibility lists remain unrestricted. Missing or unknown dispatch
context also keeps the hook eligible.

Use message hooks for channel-level routing and delivery policy:

- `message_received`: observe inbound content, sender, `threadId`,
  `messageId`, `senderId`, optional run/session correlation, ordered `media`,
  normalized `location`, stable `providerUpdate` identity when supplied by the
  channel, and metadata.
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

`before_dispatch` receives the canonical inbound `messageId` in both its event
and context.

Prefer typed `threadId` and `replyToId` fields before using channel-specific
metadata.

Inbound claim and message-received events expose `media?:
PluginHookMediaFact[]` as the canonical attachment API. Each fact can carry
`path`, `url`, `contentType`, `kind`, `transcribed`, `messageId`, and
`workspaceDir`; array position is attachment identity. When a remote attachment
has not been staged locally yet, `media` is omitted,
`mediaStagingPending: true`, and `originalMedia` contains the provider-side
facts. Do not treat `originalMedia.path` as locally readable until a later
staged event supplies `media`.

The singular/plural `mediaPath`, `mediaUrl`, `mediaType`, `mediaPaths`,
`mediaUrls`, `mediaTypes`, and matching `originalMedia*` metadata properties are
deprecated compatibility aliases. New hooks should use the typed top-level
arrays.

Decision rules:

- `message_sending` with `cancel: true` is terminal.
- `message_sending` with `cancel: false` is treated as no decision.
- Each `message_sending` handler receives the original event content. The last
  returned `content` wins; a later handler can still cancel delivery.
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

Use `security.installPolicy` for operator-owned allow/warn/block decisions. That
policy runs from OpenClaw config, covers CLI install and update paths, and
fails closed when enabled but unavailable.

`before_install` is a plugin-runtime lifecycle hook. It can run after
`security.installPolicy` in a process where plugin hooks have already been
loaded, such as Gateway-backed install flows. Trusted official and bundled
install paths can skip this hook; they still run the operator install policy.
It is useful for plugin-owned observations, warnings, and compatibility checks,
but it is not the primary enterprise or host security boundary for installs. The
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

The legacy `api.on("deactivate", ...)` alias was removed in August 2026. Use
`gateway_stop` for cleanup; see the
[migration note](/plugins/sdk-migration#deactivate-hook-alias).

Do not rely on the internal `gateway:startup` hook for plugin-owned runtime
services.

`cron_reconciled` fires after the Gateway cron scheduler and its on-exit
watchers have reconciled their durable state. It fires for both initial
startup and scheduler replacement during config reload. The event reports
`reason` (`startup` or `reload`) and the effective `enabled` state. Disabled
cron still emits with `enabled: false`, allowing an external projection to
clear stale wakes. Use `ctx.getCron?.()` for the exact scheduler instance that
completed reconciliation; a later reload does not retarget that callback.
`ctx.abortSignal` owns that same scheduler snapshot. The Gateway aborts it as
soon as a newer scheduler is armed or shutdown starts. Pass it through every
durable side effect and do not accept the snapshot after it aborts.
This is a scheduler lifecycle signal, not a plugin-activation signal: a
plugin-only hot reload does not replay it. A newly enabled consumer receives
its first baseline on the next scheduler replacement or Gateway start.

Like other observation hooks, `gateway_start` and `cron_reconciled` callbacks
can overlap. If both handlers share plugin initialization, coordinate them
with a plugin-local readiness promise rather than depending on callback order.

`cron_changed` fires for Gateway-owned cron lifecycle events with a typed
event payload covering `added`, `updated`, `removed`, `started`, `finished`,
and `scheduled` reasons. The event can include a `PluginHookGatewayCronJob`
snapshot (including `state.nextRunAtMs`, `state.lastRunStatus`, and
`state.lastError` when present) plus an optional `PluginHookGatewayCronDeliveryStatus`
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
  let reconciliationSignal: AbortSignal | undefined;
  let requestedRevision = 0;
  let appliedRevision = 0;
  let worker = Promise.resolve();
  let activeAttempt: AbortController | undefined;

  const projectLatest = async () => {
    let retryMs = 1_000;

    while (!lifecycle.signal.aborted && appliedRevision < requestedRevision) {
      const ownerSignal = reconciliationSignal;
      if (!ownerSignal || ownerSignal.aborted) {
        return;
      }
      const targetRevision = requestedRevision;
      const attempt = new AbortController();
      const signal = AbortSignal.any([lifecycle.signal, ownerSignal, attempt.signal]);
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
        if (lifecycle.signal.aborted || ownerSignal.aborted) {
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
    reconciliationSignal = ctx.abortSignal;
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

## Troubleshooting

| Symptom                                    | Check                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin loads but the handler never runs    | Use `api.on` for typed names, inspect `openclaw plugins inspect <id> --runtime --json`, and check diagnostics for blocked registrations. Runtime inspection loads the plugin in the inspecting process; restart the Gateway too. |
| Conversation hook is blocked               | Set `plugins.entries.<id>.hooks.allowConversationAccess: true`; for prompt hooks, also check that `allowPromptInjection` is not `false`. These keys belong under `hooks`, not the plugin's `config`.                             |
| Hook works for one runtime or trigger only | Check the runtime boundary and `eligibleTriggers`. Missing context fields are not proof of a different sender, agent, or authorization state.                                                                                    |
| Persistence rewrite has no effect          | Return `{ message }` synchronously. An `async` handler's result is ignored.                                                                                                                                                      |
| A timed-out hook still performs work       | Timeout ends the host's await, not plugin work. Pass available abort signals through I/O and bound plugin-owned work yourself.                                                                                                   |
| One plugin's rewrite disappears            | Check the hook's merge rule and priority. `message_sending` uses the last returned content; `reply_payload_sending` passes each updated payload onward.                                                                          |

## Upcoming deprecations

A few hook-adjacent surfaces are deprecated but still supported. Migrate
before the next major release:

- **Plaintext channel envelopes** in `inbound_claim` and `message_received`
  handlers. Prefer typed fields instead of parsing flat envelope text:
  `inbound_claim` exposes `event.bodyForAgent`; `message_received` exposes
  `event.content` and structured metadata, not a `BodyForAgent` field. See
  [Plaintext channel envelopes → BodyForAgent](/plugins/sdk-migration#removal-timeline).
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
[Plugin SDK migration → Active deprecations](/plugins/sdk-migration#removal-timeline).

## Related

- [Plugin SDK migration](/plugins/sdk-migration) - active deprecations and removal timeline
- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Internal hooks](/automation/hooks)
- [Webhooks](/automation/cron-jobs#webhooks)
- [Plugin architecture internals](/plugins/architecture-internals)
