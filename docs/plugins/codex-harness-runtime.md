---
summary: "Runtime boundaries, hooks, tools, permissions, and diagnostics for the Codex harness"
title: "Codex harness runtime"
read_when:
  - You need the Codex harness runtime support contract
  - You are debugging native Codex tools, hooks, compaction, or feedback upload
  - You are changing plugin behavior across OpenClaw and Codex harness turns
---

Runtime contract for Codex harness turns. For setup and routing, see
[Codex harness](/plugins/codex-harness). For config fields, see
[Codex harness reference](/plugins/codex-harness-reference).

## Overview

Codex owns the native model loop, native thread resume, native tool
continuation, and native compaction. OpenClaw owns channel routing, session
files, visible message delivery, OpenClaw dynamic tools, approvals, media
delivery, and a transcript mirror around that boundary.

Prompt routing follows the selected runtime, not just the provider string. A
native Codex turn gets Codex app-server developer instructions; an explicit
OpenClaw compatibility route keeps the normal OpenClaw system prompt even when
it uses Codex-flavored OpenAI auth or transport.

OpenClaw starts and resumes native Codex threads with Codex's built-in
personality disabled (`personality: "none"`) so workspace personality files
and OpenClaw agent identity stay authoritative. Native Codex keeps Codex-owned
base/model instructions and project-doc loading otherwise. Lightweight
OpenClaw runs (for example cron) still suppress project-doc loading.

OpenClaw developer instructions cover OpenClaw runtime concerns: source-channel
delivery, OpenClaw dynamic tools, ACP delegation, adapter context, and the
active agent workspace profile files. Skill catalogs and tool-routed
`MEMORY.md` pointers are projected as turn-scoped collaboration developer
instructions. When memory tools are unavailable, active `BOOTSTRAP.md` content
and full `MEMORY.md` fall back to plain turn input context instead.

Most OpenClaw dynamic tools use the searchable `openclaw` namespace. Tools
marked `catalogMode: "direct-only"` use `openclaw_direct`, which Codex keeps
directly model-visible as `DirectModelOnly` instead of exposing it to nested
Code Mode execution.

## Thread bindings and model changes

When an OpenClaw session is attached to an existing Codex thread, the next
turn resends the currently selected model, approval policy, sandbox,
approvals reviewer, and service tier to app-server. Switching from
`openai/gpt-5.5` to `openai/gpt-5.2` keeps the thread binding but asks Codex to
continue with the newly selected model.

Supervised bindings are the exception. The OpenClaw model picker stays locked,
and resumes omit model and provider overrides so Codex restores the canonical
thread's persisted model and provider. A separate native Codex control can
change that persisted pair, and the initial snapshot can produce Codex's normal
model-difference warning; the outer OpenClaw model and fallback chain never
substitute for either.

## Supervision and safe continuation

Codex supervision is an opt-in capability of the same `codex` plugin. It discovers
native threads through a separate connection and projects only non-archived
sessions into the Gateway catalog. Without explicit `appServer` connection
settings, that connection uses managed user-home stdio while the ordinary
harness remains agent-scoped. Listing and metadata reads are passive: they do
not resume a thread, subscribe OpenClaw to its live events, or answer its
approvals.

For a stored or idle session on the Gateway computer, **Continue as branch**
creates a normal, model-locked Chat and mirrors bounded user and assistant
history through the source's last terminal persisted turn. The first normal
Chat turn installs the real approval handlers and uses a temporary native fork
to pin the snapshot without a model or provider override. Codex App Server uses
its current native configuration and returns the selected pair; it emits its
normal warning if that model differs from the source's last recorded model.
On the same supervision connection, OpenClaw starts the canonical
`appServer`-source Codex harness thread under its cwd and runtime policy with
exactly the returned model and provider for that initial start, injects the
bounded visible history, and archives the temporary fork. The source is never
resumed. The canonical thread has the full OpenClaw harness tool surface;
reasoning, tool calls, and tool results from the source are not cloned into it.
The private connection scope survives pending and committed binding states, so
every later turn remains on that connection with native auth and provider
configuration. Disabled supervision or binding/connection drift fails closed
rather than switching to the ordinary agent-home harness.

The original CLI, VS Code, Atlas, or ChatGPT source remains eligible for both
catalogs. The canonical branch is a native Codex thread, but its source kind is
`appServer`; native clients may filter that source kind, so its appearance in
Codex Desktop is not guaranteed.

Active sources cannot start a new branch or be archived; an existing supervised
Chat can still be opened. `notLoaded` means activity is unknown, not idle;
OpenClaw allows archive for a local `idle` or `notLoaded` row only after explicit
no-other-runner confirmation and a fresh process-local status read. Codex
serializes thread mutations within one App Server process but does not provide
an exclusive cross-process runner or approval-owner lease, so that read cannot
prove that another process is not using the thread. OpenClaw blocks a known
active binding owner for the exact target or any non-archived spawned descendant
returned by Codex's paginated descendant query. Enumeration errors, cycles, and
safety-limit exhaustion fail closed. Native archive can still race a new turn
in another process, so confirmation covers unknown clients and the gap between
status read and archive. A supervised model-locked Chat cannot be deleted while
it protects the native binding.

Paired-node catalogs stay metadata-only in the initial release. The current
node invoke boundary is request/response and cannot carry the long-lived turn
events, approval requests, or streaming output required by a real Codex harness
binding. Remote **Continue** and **Archive** therefore remain unavailable even
when the row is idle.

See [Codex supervision](/plugins/codex-supervision) for operator setup and the
visible Control UI behavior.

## Visible replies and heartbeats

Direct/source chat turns through the Codex harness default to automatic final
assistant delivery for internal WebChat surfaces, matching the Pi harness
contract: the agent replies normally and OpenClaw posts the final text to the
source conversation. Set `messages.visibleReplies: "message_tool"` to keep
final assistant text private unless the agent calls `message(action="send")`.

Codex heartbeat turns get `heartbeat_respond` in the searchable OpenClaw tool
catalog by default so the agent can record whether the wake should stay quiet
or notify. Heartbeat initiative guidance is sent as a Codex collaboration-mode
developer instruction scoped to the heartbeat turn; ordinary chat turns stay
in Codex Default mode. When `HEARTBEAT.md` is non-empty, the heartbeat
instructions point Codex at the file instead of inlining its contents.

## Hook boundaries

| Layer                                 | Owner                    | Purpose                                                             |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| OpenClaw plugin hooks                 | OpenClaw                 | Product/plugin compatibility across OpenClaw and Codex harnesses.   |
| Codex app-server extension middleware | OpenClaw bundled plugins | Per-turn adapter behavior around OpenClaw dynamic tools.            |
| Codex native hooks                    | Codex                    | Low-level Codex lifecycle and native tool policy from Codex config. |

OpenClaw does not use project or global Codex `hooks.json` files to route
plugin behavior. For the native tool and permission bridge, OpenClaw injects
per-thread Codex config for `PreToolUse`, `PostToolUse`, `PermissionRequest`,
and `Stop`.

When Codex app-server approvals are enabled (`approvalPolicy` is not
`"never"`), the default injected native hook config omits `PermissionRequest`
so Codex's app-server reviewer and OpenClaw's approval bridge handle real
escalations after review. Add `permission_request` to
`nativeHookRelay.events` to force the compatibility relay anyway. Other Codex
hooks such as `SessionStart` and `UserPromptSubmit` remain Codex-level
controls; they are not exposed as OpenClaw plugin hooks in the v1 contract.

For OpenClaw dynamic tools, OpenClaw executes the tool after Codex asks for
the call, so plugin and middleware behavior runs in the harness adapter. For
Codex-native tools, Codex owns the canonical tool record; OpenClaw can mirror
selected events but cannot rewrite the native thread unless Codex exposes that
through app-server or native hook callbacks.

Codex app-server report-mode `PreToolUse` events defer plugin approval to the
matching app-server approval. If an OpenClaw `before_tool_call` hook returns
`requireApproval` while the native payload sets `openclaw_approval_mode:
"report"`, the native hook relay records the plugin approval requirement and
returns no native decision. When Codex later sends the app-server approval
request for the same tool use, OpenClaw opens the plugin approval prompt and
maps the decision back to Codex. Codex `PermissionRequest` events are a
separate approval path and can still route through OpenClaw approvals when
configured for that bridge.

Codex app-server item notifications also provide async `after_tool_call`
observations for native tool completions not already covered by the native
`PostToolUse` relay. These are telemetry/compatibility only; they cannot
block, delay, or mutate the native tool call.

Compaction and LLM lifecycle projections come from Codex app-server
notifications and OpenClaw adapter state, not native Codex hook commands.
`before_compaction`, `after_compaction`, `llm_input`, and `llm_output` are
adapter-level observations, not byte-for-byte captures of Codex's internal
request or compaction payloads.

Codex native `hook/started` and `hook/completed` app-server notifications are
projected as `codex_app_server.hook` agent events for trajectory and
debugging. They do not invoke OpenClaw plugin hooks.

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
| Native shell, patch, and MCP block or observe | Supported through native hook relay                                              | Codex `PreToolUse` and `PostToolUse` are relayed for committed native tool surfaces, including MCP payloads on Codex app-server `0.142.0` or newer. Blocking is supported; argument rewriting is not.                                                                                                                                                                                                                                                                               |
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

For `PermissionRequest`, OpenClaw only returns explicit allow or deny
decisions when policy decides. A no-decision result is not an allow: Codex
treats it as no hook decision and falls through to its own guardian or user
approval path.

Codex app-server approval modes omit this native hook by default. This
applies unless `permission_request` is explicitly included in
`nativeHookRelay.events` or a compatibility runtime installs it.

When an operator chooses `allow-always` for a Codex native permission
request, OpenClaw remembers that exact provider/session/tool input/cwd
fingerprint for a bounded session window. The remembered decision is
intentionally exact-match only: a changed command, arguments, tool payload, or
cwd creates a fresh approval.

Codex MCP tool approval elicitations route through OpenClaw's plugin approval
flow when Codex marks `_meta.codex_approval_kind` as `"mcp_tool_call"`. Codex
`request_user_input` registers a provider-neutral gateway question for the
originating session. The Control UI renders the gateway question card, and a
single non-secret choice uses typed channel buttons when the channel supports
them. Button taps, Control UI answers, and the next queued plain-text reply all
resolve the same gateway record before OpenClaw returns the app-server answer.
Codex auto-resolution and attempt aborts bound the wait and cancel the record.
Secret questions stay entirely on the warned text-reply path. Other MCP
elicitation requests fail closed.

For the general plugin approval flow that carries these prompts, see
[Plugin permission requests](/plugins/plugin-permission-requests).

## Queue steering

Active-run queue steering maps onto Codex app-server `turn/steer`. With the
default `messages.queue.mode: "steer"`, OpenClaw batches steer-mode chat
messages for the configured quiet window and sends them as one `turn/steer`
request in arrival order.

Codex review and manual compaction turns can reject same-turn steering. In
that case, OpenClaw waits for the active run to finish before starting the
prompt. Use `/queue followup` or `/queue collect` when messages should queue
by default instead of steering. See [Steering queue](/concepts/queue-steering).

## Codex feedback upload

When `/diagnostics [note]` is approved for a session on the native Codex
harness, OpenClaw also calls Codex app-server `feedback/upload` for relevant
Codex threads, including logs for each listed thread and spawned Codex
subthreads when available.

The upload goes through Codex's normal feedback path to OpenAI servers. If
Codex feedback is disabled in that app-server, the command returns the
app-server error. The completed diagnostics reply lists the channels,
OpenClaw session ids, Codex thread ids, and local `codex resume <thread-id>`
commands for the threads that were sent.

If you deny or ignore the approval, OpenClaw does not print those Codex ids
and does not send Codex feedback. The upload does not replace the local
Gateway diagnostics export. See [Diagnostics export](/gateway/diagnostics) for
the approval, privacy, local bundle, and group-chat behavior.

Use `/codex diagnostics [note]` only when you want the Codex feedback upload
for the currently attached thread without the full Gateway diagnostics
bundle.

## Compaction and transcript mirror

When the selected model uses the Codex harness, native thread compaction
belongs to Codex app-server. OpenClaw does not run preflight compaction for
Codex turns, replace Codex compaction with context-engine compaction, or fall
back to OpenClaw or public OpenAI summarization when native compaction cannot
be started. OpenClaw keeps a transcript mirror for channel history, search,
`/new`, `/reset`, and future model or harness switching.

Explicit compaction requests, such as `/compact` or a plugin-requested manual
compact operation, start native Codex compaction with `thread/compact/start`.
OpenClaw keeps the request and shared-client lease open until Codex emits the
matching `contextCompaction` completion item and then reports the compaction
turn as completed. If that terminal turn exceeds the configured compaction
timeout, OpenClaw requests a native turn interrupt. The lease and per-thread
compaction fence remain held until Codex reports terminal state or confirms
the interrupt RPC. If Codex does not confirm within the interrupt grace
period, OpenClaw retires the connection before releasing the fence. Remote
connections also detach the matching thread binding so later work cannot
overlap an unconfirmed remote turn. Other turns on a retired connection fail
and can retry on a fresh client. Client closure, request cancellation, or a
failed compaction turn returns a failed operation. Automatic context-pressure
compaction is Codex's job; OpenClaw only starts native compaction for manually
requested triggers.

When a context engine requests Codex thread-bootstrap projection, OpenClaw
projects tool-call names and ids, input shapes, and redacted tool-result
content into the fresh Codex thread. It does not copy raw tool-call argument
values into that projection.

The mirror includes the user prompt, final assistant text, and lightweight
Codex reasoning or plan records when the app-server emits them. OpenClaw
records the native compaction start and terminal status, but it does not
expose a human-readable compaction summary or an auditable list of which
entries Codex kept after compaction.

Because Codex owns the canonical native thread, `tool_result_persist` does
not rewrite Codex-native tool result records. It only applies when OpenClaw
writes an OpenClaw-owned session transcript tool result.

## Media and delivery

OpenClaw continues to own media delivery and media provider selection. Image,
video, music, PDF, TTS, and media understanding use matching provider/model
settings such as `agents.defaults.imageGenerationModel`,
`videoGenerationModel`, `pdfModel`, and `messages.tts`.

Text, images, video, music, TTS, approvals, and messaging-tool output continue
through the normal OpenClaw delivery path; media generation does not require
the legacy runtime. When Codex emits a native image-generation item with a
`savedPath`, OpenClaw forwards that exact file through the normal reply-media
path even if the Codex turn has no assistant text.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex supervision](/plugins/codex-supervision)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Plugin hooks](/plugins/hooks)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Diagnostics export](/gateway/diagnostics)
- [Trajectory export](/tools/trajectory)
