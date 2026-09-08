---
summary: "Dynamic tools, web search, image loading, turn liveness, and runtime boundaries"
read_when:
  - You want to know which OpenClaw tools reach a Codex turn
  - You are debugging turn liveness or parallel chats
  - You need the ownership split between OpenClaw and Codex
title: "Codex runtime behavior"
sidebarTitle: "Runtime behavior"
---

What the Codex harness owns during a turn, and what stays with OpenClaw. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Dynamic tools and web search

Codex dynamic tools default to `searchable` loading. OpenClaw normally does
not expose dynamic tools that duplicate Codex-native workspace operations:
`read`, `write`, `edit`, `apply_patch`, `exec`, `process`,
`get_goal`, `create_goal`, `update_goal`, `tool_call`, `tool_describe`,
`tool_search`, and `tool_search_code`. Goal operations stay native to Codex,
so OpenClaw does not project a second goal store into Codex turns. Most
remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, `progress_card`, and `heartbeat_respond` are available through
Codex tool search under the `openclaw` namespace, keeping the initial model
context smaller. The restricted-turn shell fallback is the exception for
`exec` and `process` when a finite allowlist disables native Code Mode;
runtime allowlists and `codexDynamicToolsExclude` still apply.
When native shell remains active and Gateway access is policy-eligible,
OpenClaw instead publishes the distinct `gateway_exec` and `gateway_process`
names so native shell and the OpenClaw-managed environment path cannot be
confused.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool, use the `openclaw_direct` namespace instead. Codex treats that namespace
as `DirectModelOnly`, so those tools stay directly model-visible in normal and
code-mode-only threads rather than crossing nested Code Mode `tools.*` calls.

Web search uses Codex's hosted `web_search` tool by default when search is
enabled and no managed provider is selected. Native hosted search and
OpenClaw's managed `web_search` dynamic tool are mutually exclusive so
managed search cannot bypass native domain restrictions. OpenClaw uses the
managed tool when hosted search is unavailable, explicitly disabled, or
replaced by a selected managed provider. OpenClaw keeps Codex's standalone
`web.run` extension disabled because production app-server traffic rejects
its user-defined `web` namespace. `tools.web.search.enabled: false`
disables both paths, as do tool-disabled LLM-only runs. Codex treats
`"cached"` as a preference and resolves it to live external access for
unrestricted app-server turns. Automatic managed fallback fails closed when
native `allowedDomains` are set so the allowlist cannot be bypassed.
Persistent effective search-policy changes rotate the bound Codex thread
before the next turn; transient per-turn restrictions use a temporary
restricted thread and preserve the existing binding for later resume.

`sessions_yield`, `sessions_spawn`, and message-tool-only source replies stay
direct because they are turn-control or delegation contracts. Guidance still
prefers Codex's native `spawn_agent` as the primary Codex subagent surface,
while explicit OpenClaw or ACP delegation remains directly callable through
`sessions_spawn`. In Codex Code Mode, generic OpenClaw
dynamic-tool results are JSON text rather than JavaScript objects, so parse
JSON-looking results before reading fields. Codex also serializes nested
dynamic calls; submit several `sessions_spawn` calls in a bounded loop rather
than expecting `Promise.all` to launch them concurrently. Already-accepted
children can still overlap while later calls are submitted. See
[Swarm](/tools/swarm#use-swarm-from-other-harnesses) for a complete pattern.
Scheduled heartbeat user messages identify `heartbeat_respond` when structured
responses are enabled; the tool remains discoverable through Codex tool search.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when
debugging the full tool payload.

## Image loader ownership

For image-capable models with Codex native tools enabled, Codex owns
`view_image` and OpenClaw suppresses its duplicate loader. The native Codex
schema accepts one local filesystem `path`. For text-only models, or when the
native tool surface is disabled, OpenClaw supplies `view_image` with its
`path`/`paths` schema and delegated vision route. Callers must use the schema
advertised for the active run.

## Turn liveness and timeouts

Codex owns provider-stream liveness and native turn completion. OpenClaw waits
for the exact `turn/completed` outcome rather than interrupting a quiet turn or
treating assistant output as completion. The existing
`agents.defaults.timeoutSeconds` limit is an elapsed execution budget per
attempt: progress does not reset it, and `0` means unlimited execution.
OpenClaw still bounds its own requests, dynamic tools, cancellation, and local
settlement. See [Timeouts](/plugins/codex-harness-reference#timeouts) for those
budgets, Stop and replay behavior, and Doctor migration of retired idle settings.

## Parallel chats and thread ownership

Independent chats can share a Codex app-server and run concurrently. Resuming
an idle chat does not require unrelated chats, model discovery, or tool-catalog
reads to finish. OpenClaw coordinates its own lifecycle operations for each
native thread and preserves that thread's identity across ordinary resumes.
A closed, replaced, or retired client still cannot complete a stale handoff.

After a completed provider failure, you can continue in the same chat with its
existing configuration. OpenClaw retains the configured native thread, including
for `/codex resume` of that chat's already-bound thread. Provider policy refusals
end the current request without automatic retry or model fallback. A later user
message is a separate turn; it does not supply a native policy override or user
confirmation.

With Codex app-server `0.153.4`, first-time adoption or changed configuration of a
loaded failed thread still requires native unloading. OpenClaw preserves the
thread and reports missing configuration confirmation instead of assuming the
changes took effect. Existing active-turn and parent-controlled-thread checks
still apply.

This coordination does not make native configuration replacement atomic against
Codex-internal controllers. Native subagent reloads or another native controller
can operate outside OpenClaw's thread queue. Avoid concurrently reconfiguring the
same native thread through multiple controllers; observing native teardown alone
does not reserve it against a subsequent native reload.

## Runtime boundaries

The Codex harness changes the low-level embedded agent executor only.

- OpenClaw dynamic tools are supported. Codex asks OpenClaw to execute
  those tools, so OpenClaw remains in the execution path.
- Codex-native shell, patch, MCP, and native app tools are owned by Codex.
  OpenClaw can observe or block selected native events through the
  supported relay, but it does not rewrite native tool arguments.
- `gateway_exec` and `gateway_process` are OpenClaw-owned dynamic tools. They
  deliberately re-enter Gateway exec preparation for agent-readable Secret
  Store environment and protected egress; those values never flow into Codex
  native shell.
- Codex owns native compaction. OpenClaw keeps a transcript mirror for
  channel history, search, `/new`, `/reset`, and future model or harness
  switching, but does not replace Codex compaction with an OpenClaw or
  context-engine summarizer.
  Completed commentary and tool activity are saved during the turn rather than
  waiting for its final answer, preserving completed work across Gateway interruption.
- Media generation, media understanding, TTS, approvals, and messaging-tool
  output continue through the matching OpenClaw provider/model settings.
- `tool_result_persist` applies to OpenClaw-owned transcript tool results,
  not Codex-native tool result records.

For hook layers, supported V1 surfaces, native permission handling, queue
steering, Codex feedback upload mechanics, and compaction details, see
[Codex harness runtime](/plugins/codex-harness-runtime).
