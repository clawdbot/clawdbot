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

For native connected apps, Codex also owns the final per-thread app and tool
policy. OpenClaw caches a runtime-and-workspace-scoped `plugin/installed`
snapshot, reads exact configured plugin details, provisionally admits only
explicitly allowed, ownership-proven apps, and creates a deny-by-default
native thread. One `app/installed` request verifies the actual thread ID
without forcing an inventory refresh. Native app execution begins only after
Codex confirms the app is enabled and callable for that thread.

This check finishes before OpenClaw injects history, starts a turn, or commits a
thread binding. Failed persistent provisional threads are deleted; ephemeral
threads are unsubscribed. OpenClaw retires the app-server connection when safe
cleanup cannot be confirmed. Supervised branches also clean up their temporary
probe and preserve recovery state if cleanup fails.

Account-wide app access cannot override an explicitly disabled configured
workspace plugin. OpenClaw uses its installed snapshot and reads only that
exact plugin's details to identify and deny its apps; it never scans unrelated
marketplaces or activates the plugin.

Prompt routing follows the selected runtime, not just the provider string. A
native Codex turn gets Codex app-server developer instructions; an explicit
OpenClaw compatibility route keeps the normal OpenClaw system prompt even when
it uses Codex-flavored OpenAI auth or transport.

OpenClaw starts and resumes native Codex threads with Codex's built-in
personality disabled (`personality: "none"`) so workspace personality files
and OpenClaw agent identity stay authoritative. Native Codex keeps Codex-owned
base/model instructions and project-doc loading otherwise. An ordinary
policy-restricted turn has no native filesystem environment, so OpenClaw carries
the bounded workspace `AGENTS.md` snapshot as thread-level developer
instructions instead. Lightweight, ring-zero, message-only, and tool-disabled
internal turns suppress project-doc loading and that fallback carrier.

OpenClaw developer instructions cover OpenClaw runtime concerns: source-channel
delivery, OpenClaw dynamic tools, ACP delegation, adapter context, and the
active agent workspace profile files. Skill catalogs and tool-routed
`MEMORY.md` pointers are projected as turn-scoped collaboration developer
instructions. When memory tools are unavailable, active `BOOTSTRAP.md` content
and full `MEMORY.md` fall back to plain turn input context instead.

When `openclaw_direct.sessions_yield` is available, those instructions also
tell a native Codex parent to end the current turn when a child's result should
arrive in a later turn. Native `wait_agent` remains for an intentional same-turn
wait when the immediate next step is blocked on the child; completion polling
loops are not a substitute.

Most OpenClaw dynamic tools use the searchable `openclaw` namespace. Tools
marked `catalogMode: "direct-only"` use `openclaw_direct`, which Codex keeps
directly model-visible as `DirectModelOnly` instead of exposing it to nested
Code Mode execution.

## Recovery after a hard Gateway stop

On POSIX systems, OpenClaw checks for registered orphaned Codex app-server
processes before spawning each fresh stdio child. Gateway startup also runs a
best-effort background sweep; the before-spawn check remains authoritative.
OpenClaw records the parent and child process identities in the current state
directory's SQLite plugin store
before sending Codex `initialize`, so a child cannot start a native turn before
its registration is durable.

Cleanup only targets a registered child whose original OpenClaw parent is no
longer running. It checks process IDs, start times, and process groups before
terminating the orphan and its discoverable descendants. When recorded, the child
command line must also match the live process before signaling. Another live
OpenClaw instance, processes registered under another state directory, and externally
managed WebSocket or Unix-socket app-servers are left alone. These portable
process checks do not provide an atomic operating-system ownership guarantee
or discover descendants that independently reparented before inspection.

Linux reads process identities directly from `/proc`, including the boot ID
and process start ticks, so Alpine/BusyBox installations do not need `procps`.
macOS uses its native `ps` with a fixed locale and timezone.

If process inspection or bounded cleanup cannot confirm that the registered
orphan is gone, the new stdio connection fails instead of spawning another
child. Follow the reported action: check `/proc` access on Linux or `ps` on
macOS, or verify and stop
the reported orphan process, then retry. If the cleanup budget expires, retry
to finish the remaining registrations.

This recovery requires a spawn-time registration. It does not discover
unregistered children left by an older OpenClaw version or scan command names
to infer ownership. Windows does not yet have equivalent orphan registration
and recovery.

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

Paired-node catalogs expose bounded, paginated transcripts. Eligible stored or
idle rows can also create or reopen a model-locked Chat when the connected node
advertises and permits the catalog list, transcript read, and
`codex.cli.session.resume` commands, and the operator has `operator.admin`.
Later messages resume the exact native thread through the node's Codex CLI and
return its final text; this is not the Gateway-local branch flow or a streaming
App Server harness bridge. Nodes without those capabilities remain readable
without continuation, and paired-node archive remains unavailable. See
[paired-node limits](/plugins/codex-supervision#understand-paired-node-limits).

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
or notify. Heartbeat turns use the same Codex Default collaboration mode as
ordinary chat turns. The heartbeat monitor's cron scratch is appended to the
scheduled heartbeat user message when present.

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
the call, so plugin and middleware behavior runs in the harness adapter. Codex
Code Mode receives generic dynamic results as text and serializes nested
dynamic calls; callers must parse JSON-looking results and cannot rely on
`Promise.all` for concurrent submission. For Codex-native tools, Codex owns the
canonical tool record; OpenClaw can mirror selected events but cannot rewrite
the native thread unless Codex exposes that through app-server or native hook
callbacks.

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

## Experimental sandbox process streaming

Native sandbox execution remains opt-in through
`appServer.experimental.sandboxExecServer`. When enabled for an active
OpenClaw sandbox, sandboxed processes stream ordered stdout, stderr, or PTY
output notifications. OpenClaw retains only a bounded recent-output buffer for
polling and replay, so long-running processes cannot grow the app-server bridge
without limit. Process exit and cleanup remain tied to the sandbox-owned
process. Failed environment registration never falls back to host execution.

See [Sandboxed native execution](/plugins/codex-harness-reference#sandboxed-native-execution)
for configuration and local-only transport restrictions.

Node-backed `remote-exec`, whether on a paired device or the same Crabbox cloud
profile used for OpenClaw worker turns, is separate from the experimental
local sandbox flag. Codex app-server and model auth stay on the Gateway, while
an explicitly authorized managed exec-server on the enrolled node owns
process, filesystem, capability, and credential-free HTTP operations. The
Gateway rejects authentication, cookie, API-key, and other sensitive HTTP
headers before they reach the node; authenticated HTTP must run on the
Gateway. The existing duplex node channel carries the Codex JSON-RPC stream
without starting an OpenClaw worker child or consuming a worker slot. Explicit
Gateway command allowlisting remains required. Launch needs per-attempt
allow-once approval or exact admitted session Full access with node-local
full/off policy. Full access never overrides local deny, ask, or allowlist
restrictions, pairing, hosting consent, command authorization, or tool policy.
The node rechecks local policy immediately before spawning the pinned binary;
a stale launch is refused. Each attempt owns an isolated Gateway app-server client so its
remote environment registration retires with that attempt. Disconnect ends the
active attempt and its remote processes; reconnect allows only a fresh
attempt. Normal Codex turns work, but `/btw` side questions fail closed because
they are not yet placement-bound. The placement workspace does not confine
execution: process and filesystem access remain bounded only by the node's
operating system account.

## V1 support contract

Supported in Codex runtime v1:

| Surface                                       | Support                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI model loop through Codex               | Supported                                                                        | Codex app-server owns the OpenAI turn, native thread resume, and native tool continuation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OpenClaw channel routing and delivery         | Supported                                                                        | Telegram, Discord, Slack, WhatsApp, iMessage, and other channels stay outside the model runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| OpenClaw dynamic tools                        | Supported                                                                        | Codex asks OpenClaw to execute these tools, so OpenClaw stays in the execution path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Prompt and context plugins                    | Supported                                                                        | OpenClaw projects OpenClaw-specific prompt/context into the Codex turn while normally leaving Codex-owned base, model, and configured project-doc prompts in the native Codex lane. For ordinary policy-restricted turns without a native filesystem environment, OpenClaw carries the bounded workspace `AGENTS.md` snapshot as thread-level developer instructions. Ring-zero and other context-restricted internal modes suppress both paths. OpenClaw disables Codex's built-in personality for native threads so agent workspace personality files remain authoritative. Native Codex developer instructions accept only command guidance explicitly scoped to `codex_app_server`; legacy global command hints remain for non-Codex prompt surfaces. |
| Context engine lifecycle                      | Supported                                                                        | Assemble, ingest, and after-turn maintenance run around Codex turns. Context engines do not replace native Codex compaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Dynamic tool hooks                            | Supported                                                                        | `before_tool_call`, `after_tool_call`, and tool-result middleware run around OpenClaw-owned dynamic tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Lifecycle hooks                               | Supported as adapter observations                                                | `llm_input`, `llm_output`, `agent_end`, `before_compaction`, and `after_compaction` fire with honest Codex-mode payloads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Final-answer revision gate                    | Supported through native hook relay                                              | Codex `Stop` is relayed to `before_agent_finalize`; `revise` asks Codex for one more model pass before finalization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Native shell, patch, and MCP block or observe | Supported through native hook relay                                              | Codex `PreToolUse` and `PostToolUse` are relayed for committed native tool surfaces, including MCP payloads on the pinned Codex app-server. Blocking is supported; argument rewriting is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Native permission policy                      | Supported through Codex app-server approvals and compatibility native hook relay | Codex app-server approval requests route through OpenClaw after Codex review. The `PermissionRequest` native hook relay is opt-in for native approval modes because Codex emits it before guardian review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| App-server trajectory capture                 | Supported                                                                        | OpenClaw records the request it sent to app-server and the app-server notifications it receives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
flow when Codex marks `_meta.codex_approval_kind` as `"mcp_tool_call"`.
Plugin, account, Computer Use, and MCP approval classification runs before
ordinary input handling. A denied policy or unmappable approval schema returns
an explicit decline and never becomes a general-purpose form.

OpenClaw supports app-server MCP elicitation modes `form`, `openai/form`, and
`url`. Standard and extended forms can contain at most 12 fields. OpenClaw
normalizes field names to Gateway-safe question IDs, retains the original names
in accepted content, and presents fields in sequential batches of up to three.
Each field may offer at most four choices; fields and choices over those limits
are declined rather than truncated. Supported fields are free-form strings,
string `enum` or `oneOf` choices, booleans, numbers and integers, and
multi-select string arrays. Free-form string values are limited to 4,096
characters. String length, `email`, `uri`, `date`, and
`date-time` constraints and numeric or array bounds are validated before an
accepted response is returned. Optional fields, required fields, and valid
defaults retain their schema meaning.

`openai/form` also supports a single-select `openai/imagePicker` field with up
to four bounded item IDs and titles. OpenClaw uses only those IDs and titles; it
does not fetch or render item images. An unknown extended field type produces a
visible operator message and an explicit decline. This visible fallback is part
of the `openai/form` capability contract.

URL elicitations are shown as literal text with explicit Continue and Decline
choices. OpenClaw does not fetch or open the URL. URLs are limited to 2,048
characters, must use HTTP or HTTPS, cannot include credentials, and cannot
contain control or invisible characters. Invalid URLs produce a visible
explanation and an explicit decline.

Codex `request_user_input` and ordinary MCP elicitations share one per-turn
interactive queue. The Control UI renders each non-secret Gateway question, and
a single choice uses typed channel buttons when the channel supports them.
Button taps, Control UI answers, and the next queued plain-text reply resolve
the same exact app-server request. `serverRequest/resolved` selects a request by
its outer string-or-integer JSON-RPC ID; attempt abort, timeout, and cleanup
cancel the current owner. Late answers cannot resolve a queued replacement.

Only an explicit field `isSecret: true` or Codex question
`isSecret: true` enables secret handling. Secret form fields are requested one
at a time through the warned ephemeral text-reply path and never create durable
Gateway question records. OpenClaw does not infer secrecy from field names.

For the general plugin approval flow that carries these prompts, see
[Plugin permission requests](/plugins/plugin-permission-requests).

## Queue steering

Active-run queue steering maps onto Codex app-server `turn/steer`. With the
default `messages.queue.mode: "steer"`, OpenClaw batches steer-mode chat
messages for the configured quiet window and sends them as one `turn/steer`
request in arrival order.

Inline images and stored attachments keep their original image order. Stored
images use the same hydration, size limits, and filesystem restrictions as a
new turn. If an attachment cannot be prepared or steering is rejected, the
complete message remains queued for a follow-up turn. Preparation and the
`turn/steer` acknowledgment do not count as consumption; a message sent to
Codex without confirmed consumption is not replayed automatically.

When Codex confirms consumption, OpenClaw saves completed visible assistant
items before the steered user message, including items before a tool or sleep
handoff. Each item keeps its own identity so later steers do not duplicate it.
This history prefix is separate from the turn's final-answer selection.

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
settings such as `agents.defaults.mediaModels.image`,
`agents.defaults.mediaModels.video`, `pdfModel`, and `tts`.

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
