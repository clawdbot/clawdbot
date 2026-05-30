---
summary: "Runtime boundaries, hooks, tools, permissions, and diagnostics for the Codex harness"
title: "Codex harness runtime"
read_when:
  - You need the Codex harness runtime support contract
  - You are debugging native Codex tools, hooks, compaction, or feedback upload
  - You are changing plugin behavior across OpenClaw and Codex harness turns
---

This page documents the runtime contract for Codex harness turns. For setup and
routing, start with [Codex harness](/plugins/codex-harness). For config fields,
see [Codex harness reference](/plugins/codex-harness-reference).

## Overview

Codex mode is not OpenClaw with a different model call underneath. Codex owns more of
the native model loop, and OpenClaw adapts its plugin, tool, session, and
diagnostic surfaces around that boundary.

OpenClaw still owns channel routing, session files, visible message delivery,
OpenClaw dynamic tools, approvals, media delivery, and a transcript mirror.
Codex owns the canonical native thread, native model loop, native tool
continuation, and native compaction.

Prompt routing follows the selected runtime, not just the provider string. A
native Codex turn receives Codex app-server developer instructions, while an
explicit OpenClaw compatibility route keeps the normal OpenClaw system prompt even
when it uses Codex-flavored OpenAI auth or transport.

Native Codex keeps Codex-owned base/model instructions and project-doc behavior
according to the active Codex thread config. OpenClaw starts and resumes native
Codex threads with Codex's built-in personality disabled so workspace
personality files and OpenClaw agent identity stay authoritative. Lightweight
OpenClaw runs still preserve their existing project-doc suppression. OpenClaw
developer instructions cover OpenClaw runtime concerns such as source-channel
delivery, OpenClaw dynamic tools, ACP delegation, adapter context, and the
active agent workspace profile files. OpenClaw skill catalogs and tool-routed
`MEMORY.md` pointers are projected as turn-scoped collaboration developer
instructions for native Codex. Active `BOOTSTRAP.md` content and full
`MEMORY.md` fallback injection still use turn input reference context.

## Thread bindings and model changes

When an OpenClaw session is attached to an existing Codex thread, the next turn
sends the currently selected OpenAI model, approval policy, sandbox, and service
tier to app-server again. Switching from `openai/gpt-5.5` to
`openai/gpt-5.2` keeps the thread binding but asks Codex to continue with the
newly selected model.

## Visible replies and heartbeats

When a direct/source chat turn runs through the Codex harness, visible replies
default to automatic final assistant delivery for internal WebChat surfaces.
This keeps Codex aligned with the Pi harness prompt contract: agents reply
normally, and OpenClaw posts the final text to the source conversation. Set
`messages.visibleReplies: "message_tool"` when a direct/source chat should
intentionally keep final assistant text private unless the agent calls
`message(action="send")`.

Codex heartbeat turns also get `heartbeat_respond` in the searchable OpenClaw
tool catalog by default, so the agent can record whether the wake should stay
quiet or notify without encoding that control flow in final text.

Heartbeat-specific initiative guidance is sent as a Codex collaboration-mode
developer instruction on the heartbeat turn itself. Ordinary chat turns restore
Codex Default mode instead of carrying heartbeat philosophy in their normal
runtime prompt. When a non-empty `HEARTBEAT.md` exists, the heartbeat
collaboration-mode instructions point Codex at the file instead of inlining its
contents.

## Hook boundaries

The Codex harness has three hook layers:

| Layer                                 | Owner                    | Purpose                                                             |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| OpenClaw plugin hooks                 | OpenClaw                 | Product/plugin compatibility across OpenClaw and Codex harnesses.   |
| Codex app-server extension middleware | OpenClaw bundled plugins | Per-turn adapter behavior around OpenClaw dynamic tools.            |
| Codex native hooks                    | Codex                    | Low-level Codex lifecycle and native tool policy from Codex config. |

OpenClaw does not use project or global Codex `hooks.json` files to route
OpenClaw plugin behavior. For the supported native tool and permission bridge,
OpenClaw injects per-thread Codex config for `PreToolUse`, `PostToolUse`,
`PermissionRequest`, and `Stop`.

When Codex app-server approvals are enabled, meaning `approvalPolicy` is not
`"never"`, the default injected native hook config omits `PermissionRequest` so
Codex's app-server reviewer and OpenClaw's approval bridge handle real
escalations after review. Operators can explicitly add `permission_request` to
`nativeHookRelay.events` when they need the compatibility relay.

Other Codex hooks such as `SessionStart` and `UserPromptSubmit` remain
Codex-level controls. They are not exposed as OpenClaw plugin hooks in the v1
contract.

For OpenClaw dynamic tools, OpenClaw executes the tool after Codex asks for the
call, so OpenClaw fires the plugin and middleware behavior it owns in the
harness adapter. For Codex-native tools, Codex owns the canonical tool record.
OpenClaw can mirror selected events, but it cannot rewrite the native Codex
thread unless Codex exposes that operation through app-server or native hook
callbacks.

Codex app-server report-mode `PreToolUse` events defer plugin approval requests
to the matching app-server approval. If an OpenClaw `before_tool_call` hook
returns `requireApproval` while the native payload sets report approval mode
(`openclaw_approval_mode` is `"report"`), the native hook relay records the
plugin approval requirement and returns no native decision. When Codex sends the
app-server approval request for the same tool use, OpenClaw opens the plugin
approval prompt and maps the decision back to Codex. Codex `PermissionRequest`
events are a separate approval path and can still route through OpenClaw
approvals when the runtime is configured for that bridge.

Codex app-server item notifications also provide async `after_tool_call`
observations for native tool completions that are not already covered by the
native `PostToolUse` relay. These observations are for telemetry and plugin
compatibility only; they cannot block, delay, or mutate the native tool call.

Compaction and LLM lifecycle projections come from Codex app-server
notifications and OpenClaw adapter state, not native Codex hook commands.
OpenClaw's `before_compaction`, `after_compaction`, `llm_input`, and
`llm_output` events are adapter-level observations, not byte-for-byte captures
of Codex's internal request or compaction payloads.

Codex native `hook/started` and `hook/completed` app-server notifications are
projected as `codex_app_server.hook` agent events for trajectory and debugging.
They do not invoke OpenClaw plugin hooks.

## V1 support contract

Supported in Codex runtime v1:

| Surface                                       | Support                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI model loop through Codex               | Supported                                                                        | Codex app-server owns the OpenAI turn, native thread resume, and native tool continuation.                                                                                                                                                                                                                                                                                                                                                                                          |
| OpenClaw channel routing and delivery         | Supported                                                                        | Telegram, Discord, Slack, WhatsApp, iMessage, and other channels stay outside the model runtime.                                                                                                                                                                                                                                                                                                                                                                                    |
| OpenClaw dynamic tools                        | Supported                                                                        | Codex asks OpenClaw to execute these tools, so OpenClaw stays in the execution path.                                                                                                                                                                                                                                                                                                                                                                                                |
| Prompt and context plugins                    | Supported                                                                        | OpenClaw projects OpenClaw-specific prompt/context into the Codex turn while leaving Codex-owned base, model, and configured project-doc prompts in the native Codex lane. OpenClaw disables Codex's built-in personality for native threads so agent workspace personality files remain authoritative. Native Codex developer instructions accept only command guidance explicitly scoped to `codex_app_server`; legacy global command hints remain for non-Codex prompt surfaces. |
| Context engine lifecycle                      | Supported                                                                        | Assemble, ingest, and after-turn maintenance run around Codex turns. Context engines do not replace native Codex compaction.                                                                                                                                                                                                                                                                                                                                                        |
| Dynamic tool hooks                            | Supported                                                                        | `before_tool_call`, `after_tool_call`, and tool-result middleware run around OpenClaw-owned dynamic tools.                                                                                                                                                                                                                                                                                                                                                                          |
| Lifecycle hooks                               | Supported as adapter observations                                                | `llm_input`, `llm_output`, `agent_end`, `before_compaction`, and `after_compaction` fire with honest Codex-mode payloads.                                                                                                                                                                                                                                                                                                                                                           |
| Final-answer revision gate                    | Supported through native hook relay                                              | Codex `Stop` is relayed to `before_agent_finalize`; `revise` asks Codex for one more model pass before finalization.                                                                                                                                                                                                                                                                                                                                                                |
| Native shell, patch, and MCP block or observe | Supported through native hook relay                                              | Codex `PreToolUse` and `PostToolUse` are relayed for committed native tool surfaces, including MCP payloads on Codex app-server `0.125.0` or newer. Blocking is supported; argument rewriting is not.                                                                                                                                                                                                                                                                               |
| Native permission policy                      | Supported through Codex app-server approvals and compatibility native hook relay | Codex app-server approval requests route through OpenClaw after Codex review. The `PermissionRequest` native hook relay is opt-in for native approval modes because Codex emits it before guardian review.                                                                                                                                                                                                                                                                          |
| App-server trajectory capture                 | Supported                                                                        | OpenClaw records the request it sent to app-server and the app-server notifications it receives.                                                                                                                                                                                                                                                                                                                                                                                    |

Not supported in Codex runtime v1:

| Surface                                             | V1 boundary                                                                                                                                     | Future path                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Native tool argument mutation                       | Codex native pre-tool hooks can block, but OpenClaw does not rewrite Codex-native tool arguments.                                               | Requires Codex hook/schema support for replacement tool input.                            |
| Editable Codex-native transcript history            | Codex owns canonical native thread history. OpenClaw owns a mirror and can project future context, but should not mutate unsupported internals. | Add explicit Codex app-server APIs if native thread surgery is needed.                    |
| `tool_result_persist` for Codex-native tool records | That hook transforms OpenClaw-owned transcript writes, not Codex-native tool records.                                                           | Could mirror transformed records, but canonical rewrite needs Codex support.              |
| Rich native compaction metadata                     | OpenClaw can request native compaction, but does not receive a stable kept/dropped list, token delta, completion summary, or summary payload.   | Needs richer Codex compaction events.                                                     |
| Compaction intervention                             | OpenClaw does not let plugins or context engines veto, rewrite, or replace native Codex compaction.                                             | Add Codex pre/post compaction hooks if plugins need to veto or rewrite native compaction. |
| Byte-for-byte model API request capture             | OpenClaw can capture app-server requests and notifications, but Codex core builds the final OpenAI API request internally.                      | Needs a Codex model-request tracing event or debug API.                                   |

## Native permissions and MCP elicitations

For `PermissionRequest`, OpenClaw only returns explicit allow or deny decisions
when policy decides. A no-decision result is not an allow. Codex treats it as no
hook decision and falls through to its own guardian or user approval path.

Codex app-server approval modes omit this native hook by default. This behavior
applies when `permission_request` is explicitly included in
`nativeHookRelay.events` or a compatibility runtime installs it.

When an operator chooses `allow-always` for a Codex native permission request,
OpenClaw remembers that exact provider/session/tool input/cwd fingerprint for a
bounded session window. The remembered decision is intentionally exact-match
only: a changed command, arguments, tool payload, or cwd creates a fresh
approval.

Codex MCP tool approval elicitations are routed through OpenClaw's plugin
approval flow when Codex marks `_meta.codex_approval_kind` as
`"mcp_tool_call"`. Codex `request_user_input` prompts are sent back to the
originating chat, and the next queued follow-up message answers that native
server request instead of being steered as extra context. Other MCP elicitation
requests fail closed.

For the general plugin approval flow that carries these prompts, see
[Plugin permission requests](/plugins/plugin-permission-requests).

## Queue steering

Active-run queue steering maps onto Codex app-server `turn/steer`. With the
default `messages.queue.mode: "steer"`, OpenClaw batches steer-mode chat
messages for the configured quiet window and sends them as one `turn/steer`
request in arrival order.

Codex review and manual compaction turns can reject same-turn steering. In that
case, OpenClaw waits for the active run to finish before starting the prompt.
Use `/queue followup` or `/queue collect` when messages should queue by default
instead of steering. See [Steering queue](/concepts/queue-steering).

## Codex feedback upload

When `/diagnostics [note]` is approved for a session using the native Codex
harness, OpenClaw also calls Codex app-server `feedback/upload` for relevant
Codex threads. The upload asks app-server to include logs for each listed thread
and spawned Codex subthreads when available.

The upload goes through Codex's normal feedback path to OpenAI servers. If Codex
feedback is disabled in that app-server, the command returns the app-server
error. The completed diagnostics reply lists the channels, OpenClaw session ids,
Codex thread ids, and local `codex resume <thread-id>` commands for the threads
that were sent.

If you deny or ignore the approval, OpenClaw does not print those Codex ids and
does not send Codex feedback. The upload does not replace the local Gateway
diagnostics export. See [Diagnostics export](/gateway/diagnostics) for the
approval, privacy, local bundle, and group-chat behavior.

Use `/codex diagnostics [note]` only when you specifically want the Codex
feedback upload for the currently attached thread without the full Gateway
diagnostics bundle.

## Compaction and transcript mirror

When the selected model uses the Codex harness, native thread compaction belongs
to Codex app-server. OpenClaw does not run preflight compaction for Codex turns,
does not replace Codex compaction with context-engine compaction, and does not
fall back to OpenClaw or public OpenAI summarization when native Codex
compaction cannot be started. OpenClaw keeps a transcript mirror for channel
history, search, `/new`, `/reset`, and future model or harness switching.

Explicit compaction requests, such as `/compact` or a plugin-requested manual
compact operation, start native Codex compaction with `thread/compact/start`.
OpenClaw returns after starting that native operation. It does not wait for
completion, impose a separate OpenClaw timeout, restart the shared Codex
app-server, or record the operation as an OpenClaw-completed compaction.

When a context engine requests Codex thread-bootstrap projection, OpenClaw
projects tool-call names and ids, input shapes, and redacted tool-result content
into the fresh Codex thread. It does not copy raw tool-call argument values into
that projection.

The mirror includes the user prompt, final assistant text, and lightweight Codex
reasoning or plan records when the app-server emits them. Today, OpenClaw only
records explicit native compaction start signals when it requests compaction. It
does not expose a human-readable compaction summary or an auditable list of
which entries Codex kept after compaction.

Because Codex owns the canonical native thread, `tool_result_persist` does not
currently rewrite Codex-native tool result records. It only applies when
OpenClaw is writing an OpenClaw-owned session transcript tool result.

## Media and delivery

OpenClaw continues to own media delivery and media provider selection. Image,
video, music, PDF, TTS, and media understanding use matching provider/model
settings such as `agents.defaults.imageGenerationModel`, `videoGenerationModel`,
`pdfModel`, and `messages.tts`.

Text, images, video, music, TTS, approvals, and messaging-tool output continue
through the normal OpenClaw delivery path. Media generation does not require the legacy runtime.
When Codex emits a native image-generation item with a `savedPath`, OpenClaw
forwards that exact file through the normal reply-media path even if the Codex
turn has no assistant text.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Plugin hooks](/plugins/hooks)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Diagnostics export](/gateway/diagnostics)
- [Trajectory export](/tools/trajectory)
