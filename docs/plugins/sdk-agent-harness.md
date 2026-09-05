---
summary: "Experimental SDK surface for plugins that replace the low level embedded agent executor"
title: "Agent harness plugins"
sidebarTitle: "Agent Harness"
read_when:
  - You are changing the embedded agent runtime or harness registry
  - You are registering an agent harness from a bundled or trusted plugin
  - You need to understand how the Codex plugin relates to model providers
---

An **agent harness** is the low level executor for one prepared OpenClaw agent
turn. It is not a model provider, not a channel, and not a tool registry. For
the user-facing mental model, see [Agent runtimes](/concepts/agent-runtimes).

Use this surface only for bundled or trusted native plugins. The contract is
still experimental because the parameter types intentionally mirror the
current embedded runner.

## When to use a harness

Register an agent harness when a model family has its own native session
runtime and the normal OpenClaw provider transport is the wrong abstraction:

- a native coding-agent server that owns threads and compaction
- a local CLI or daemon that must stream native plan/reasoning/tool events
- a model runtime that needs its own resume id in addition to the OpenClaw
  session transcript

Do **not** register a harness just to add a new LLM API. For normal HTTP or
WebSocket model APIs, build a [provider plugin](/plugins/sdk-provider-plugins).

## What core still owns

For ordinary concrete-model turns, OpenClaw prepares these inputs before
calling `runAttempt`:

- provider and model, including discovery and concrete request parameters
- runtime auth state, unless the harness declares that it owns auth bootstrap
- thinking level and context budget
- the OpenClaw transcript/session file
- workspace, sandbox, and tool policy
- channel reply callbacks and streaming callbacks
- model fallback and live model switching policy

A harness runs a prepared attempt; it does not pick providers, replace channel
delivery, or silently switch models. Locking a concrete model chat does not skip
model discovery, auth preparation, or Responses parameters. An explicit
`pluginOwnerId` owns session control; a later producing `agentHarnessId` is an
observation, not a native ownership claim. Bound native sessions use the separate
ownership contract below.

### Native tool-policy enforcement

Set `conversationToolPolicySupport: "exact"` only when `runAttempt` enforces every
explicit OpenClaw tool-policy layer across native and built-in tools, OpenClaw
tools, requester and configured MCP servers, apps, delegation, and resumed
threads. Core passes `params.pluginHarnessToolPolicyRestricted` as the prepared
decision that the native surface must be isolated. Default tool-profile narrowing
does not set this flag.

Harnesses with an independently managed native surface can also declare
`conversationToolPolicySafeDenyTools` using canonical OpenClaw tool names. Core
preserves the native surface only when every expanded deny is a known core tool
in that audited safe list and passes the matching names in
`params.pluginHarnessToolPolicySafeDeniedTools`. The harness must disable any
native equivalents for those names. Finite allowlists, undeclared or unknown
tool names, wildcards, and groups containing any undeclared name remain
native-surface restrictions. Omit the list to retain the conservative behavior
where every explicit restriction isolates the native surface. Because omissions
fail closed, new tools cannot silently relax the policy boundary.

Omit the declaration when any native capability can bypass those layers.
OpenClaw then visibly rejects explicitly restricted turns before invoking the
harness. The operator can switch the session to the embedded runtime or upgrade
the harness. Channel `/btw` side questions with a restrictive direct policy are
rejected by core and are not covered by this declaration.

### Harness-owned auth bootstrap

By default, core resolves provider credentials before calling a harness. A
trusted harness that can authenticate through its own native runtime may set
`authBootstrap: "harness"` on its static `AgentHarness` registration. Core can
then delegate credential bootstrap instead of rejecting a route merely because
generic provider credentials are absent. Prepared route and explicit profile
requirements still apply.

Core still forwards a compatible, explicitly selected or ordered OpenClaw auth
profile and its scoped store when one exists. The harness must resolve that
profile or its native credentials before issuing model requests, keep secrets
scoped to the attempt, and surface actionable authentication failures. Do not
set this capability on a harness that only sometimes owns authentication.
This static bootstrap capability is distinct from ownership of an already-bound
native session's model and connection.

### Bound native session ownership

The optional `resolveSessionRuntimeOwnership({ config, agentId, sessionId,
sessionKey, assertCurrent })` callback reports private binding ownership. Core
calls it only on the exact pinned harness after validating the durable session
identity. `sessionId` and `assertCurrent` are required; `config`, `agentId`, and
`sessionKey` are optional. Return synchronously:

- `{ model: "native", auth: "native" }` when the binding owns both model selection
  and authentication through its native connection.
- `{ model: "native", auth: "host" }` when it owns model selection but still needs
  host auth preparation.
- `undefined` when no matching native-model binding exists. For a validated
  native harness pin, an implemented callback returning `undefined` is an
  unavailable-owner error: fail visibly, without ordinary discovery or a fresh
  native thread. Reattach the original native session before retrying.

Omitting the callback preserves normal concrete model/auth preparation for
third-party harnesses. Concrete plugin-owned chats never query it; a runtime
request or model lock alone cannot establish native ownership. Paired-node
Codex sessions use their owning node handler; a missing local binding must not
turn a misrouted continuation into a local run.

Include `modelRef: { provider, model }` only when both values are known from that
same binding. Do not infer a missing value from outer configuration, credentials,
or usage. Host-auth ownership requires this tuple before credential preparation;
native-auth pending branches may omit it until their native owner selects a model.

Read the existing private binding synchronously. Call `assertCurrent()` before
and after the read. Do not discover models, reclaim a generation, start a client,
authenticate, or mutate the binding. The assertion expires when the callback
returns. This ownership fact is neither execution authority nor credential readiness.

The Codex implementation reports native model ownership from `preserveNativeModel`.
It reports native auth only for the separate private supervision connection;
preserving a model on a managed connection leaves auth with the host. A
native-auth binding uses its verified connection instead of testing irrelevant
outer model route/auth metadata or forwarding a host profile. Native connection
policy still applies. Explicit per-run provider stream parameters are rejected
rather than dropped; use a concrete model chat to apply them.

For host-auth bindings, the actual native tuple controls model, auth, and request
transport preparation. Explicit profile locks remain strict; automatic profile
rotation remains available. Authored settings on that tuple and explicit per-run
parameters must be supported by the pinned runtime, not silently dropped or
redirected through another runtime.

Core binds steering and pending-question authority to the final prepared model
route, using the reply's original caller-policy snapshot for both its fingerprint
and incoming-message projection. Native ownership or model-selection hooks do not
replace that snapshot or authorize a different caller.

Core carries optional `expectedSessionRuntimeOwnership` into the attempt, including
`modelRef` for host-auth bindings. This is a nonauthorizing comparison, not a binding,
credential, or retained capability. Revalidate during preflight, under the binding
lease, and against the ready thread after resume before inference. A changed host-auth
tuple rejects stale prepared credentials while retaining the newly observed binding.
Native-auth connections may follow their native owner's model changes. Missing or
changed ownership must never start a replacement thread.

The same synchronous read supplies session rows, events, and session-scoped chat
metadata. Native-auth metadata omits inapplicable host availability fields only for
the session's rendered model; it does not set `available: true` or modify the shared
catalog. Pending native branches may still show a configured placeholder until a
native tuple exists.

An attempt may report `runtimeModelSelection: { provider, model }` from its ready
native thread. Core accepts this diagnostic only for a prepared native-owned run.
It records the selected model separately from response/billing attribution, so a
host finalizer's model does not overwrite the native session's selection.

### Verified setup runtime artifacts

A local harness that can supply inference for first-run setup must attest the
implementation that completed the probe. When
`params.captureRuntimeArtifact` is true, return an opaque
`result.runtimeArtifact` with a stable id and content fingerprint. Register a
matching `runtimeArtifact.validate(...)` capability that rechecks that binding
without loading a different harness or scanning unrelated plugins.

Verified OpenClaw continuations also pass `params.expectedRuntimeArtifact`.
The harness must compare it with the exact native process it acquired and fail
before starting or resuming a native thread if they differ. Ordinary agent
turns omit both fields, so content hashing stays out of the normal request hot
path. Remote/WebSocket harnesses need a server attestation contract before
they can participate; a version string alone is not an artifact identity.

The prepared attempt also includes `params.runtimePlan`, an OpenClaw-owned
policy bundle for runtime decisions that must stay shared across OpenClaw and
native harnesses:

- `runtimePlan.tools.normalize(...)` and `runtimePlan.tools.logDiagnostics(...)`
  for provider-aware tool schema policy
- `runtimePlan.transcript.resolvePolicy(...)` for transcript sanitization and
  tool-call repair policy
- `runtimePlan.delivery.isSilentPayload(...)` for shared `NO_REPLY` and media
  delivery suppression
- `runtimePlan.outcome.classifyRunResult(...)` for model fallback
  classification
- `runtimePlan.observability` for resolved provider/model/harness metadata

Harnesses may use the plan for decisions that need to match OpenClaw behavior,
but treat it as host-owned attempt state: do not mutate it or use it to switch
providers/models inside a turn.

For auxiliary session control calls, `resolveSessionModelRef` from
`openclaw/plugin-sdk/model-session-runtime` resolves the current model selection.
`prepareAgentRuntimeAuth` from `openclaw/plugin-sdk/agent-harness-runtime` selects
its auth route and ordered credential attempts from the caller's loaded auth
snapshot. Preserve the selected attempt's profile, API, and fallback restrictions
when materializing credentials; this keeps control calls on the same billing
route as agent turns.

For tools that support both standalone and Gateway execution,
`hasGatewayToolRoutingContext()` from
`openclaw/plugin-sdk/agent-harness-runtime` reports whether the caller or hosting
process owns Gateway routing. Local embedded RPC contexts do not count as a
running Gateway. A caller's or ambient binding remains present after its
Gateway retires, so dispatch can reject the stale call. The helper does not
check credentials, grant authority, or guarantee that the Gateway is available.

### Request-transport contract

`supports(ctx)` receives the resolved model transport in `ctx.modelProvider`.
Two secret-free provider-owned facts describe the selected route:

- `runtimePolicy.compatibleIds` lists the runtime ids the provider declares
  compatible with that concrete route. An absent policy means the provider did
  not declare route-level compatibility; it is not permission to assume support.
- `requestTransportOverrides: "none"` means no authored provider/model request
  override must be reproduced. `"present"` means authored headers, auth
  transport, proxy, TLS, local-service, private-network behavior, or request
  parameters exist. The fact does not expose those values.

Return `{ supported: false, reason }` when the harness cannot reproduce the
prepared transport. Do not infer support by reading raw config after selection.
Add `fallbackRuntime: "openclaw"` only when the built-in runtime can reproduce
the exact prepared request without dropping authored behavior. Core then uses
that fallback for explicit and persisted selections as well as multi-route
retry sets. Leave it absent for provider, route, or authentication failures
that must remain fail-closed.

When auth preparation yields multiple retry routes, one harness must support
all of them before dispatch. Implicit selection uses OpenClaw if no plugin can
own the full set; an explicit or persisted plugin selection fails closed unless
the plugin declares the lossless OpenClaw fallback.

### Per-turn temporal context

Native harnesses that own their model prompt can use `buildTemporalContextText`
from `openclaw/plugin-sdk/agent-harness-runtime`. It renders the same current
local date and time zone as the built-in OpenClaw runtime. It uses
`agents.defaults.userTimezone` when configured and the host zone otherwise.

Call it for each turn, after the final tool surface is known. Pass
`sessionStatusAvailable: true` only when that exact surface includes
`session_status`; this keeps the exact-time hint out of prompts where the tool
is unavailable. Carry the result through the native runtime's existing
per-turn application or developer context instead of appending it to stable
thread instructions.

## Register a harness

**Import:** `openclaw/plugin-sdk/agent-harness`

```typescript
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const myHarness: AgentHarnessV2 = {
  id: "my-harness",
  label: "My native agent harness",

  supports(ctx) {
    const routeSupportsHarness =
      ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("my-harness") === true;
    const canReproduceRequest = ctx.modelProvider?.requestTransportOverrides !== "present";
    return ctx.provider === "my-provider" && routeSupportsHarness && canReproduceRequest
      ? { supported: true, priority: 100 }
      : { supported: false, reason: "effective route is not harness-compatible" };
  },

  async runAttempt(params) {
    // Start or resume your native thread.
    // Use params.prompt, params.tools, params.images, params.onPartialReply,
    // params.onAgentEvent, and the other prepared attempt fields.
    return await runMyNativeTurn(params);
  },
};

export default definePluginEntry({
  id: "my-native-agent",
  name: "My Native Agent",
  description: "Runs selected models through a native agent daemon.",
  register(api) {
    api.registerAgentHarness(myHarness);
  },
});
```

`authBootstrap` is intentionally absent from this generic example. Add
`authBootstrap: "harness"` only when the harness meets the contract above.

### Isolated completion

The optional `runIsolatedCompletionV2(params)` capability serves product paths
that require one fresh prompt-only inference call with a literal empty
model-callable tool surface. Core passes provider and model ids, prompts,
deadline controls, and one prepared `authorization`:

- `owner: "host"` contains the exact transport `model` and resolved `auth`.
- `owner: "harness"` contains the prepared runtime auth plan and a credential
  snapshot restricted to the single profile selected for that call. Core owns
  automatic fallback order and invokes the harness separately for each candidate.

Host-authorized calls must use the supplied model and credential without substitution.
Bundled host-authorized harnesses share one host-prepared completion helper that
preserves the exact route, deadline, sampling options, and empty tool surface.
Harness-authorized calls may resolve only the supplied prepared
route and scoped profiles, or the harness's native account when the plan leaves
auth to the harness. The harness must not switch routes, reuse a native thread,
attach tools, invoke agent lifecycle hooks, or deliver output.

When supplied, call `params.assertCurrent()` after preparation awaits and
immediately before each credential handoff, inference request, or process start,
including retries.
It revalidates the caller's live authority and expires when the completion ends.
A thrown assertion ends execution; do not treat it as a credential failure or
retry with another profile. Continue to honor `abortSignal`; cleanup must remain
available after authority expires.

Return `{ assistant: AssistantMessage }`. Core accepts only terminal text/thinking
content with a `stop` or `length` stop reason; tool calls, failed stops, and empty
output are rejected. Title requests set `outputTextPolicy: "strict-visible"`:
keep reasoning separate without recovering ambiguous reasoning as visible text;
an empty visible result is valid. The host-prepared helper maps this policy to
strict parsing before recovery. Omission preserves ordinary recovery behavior.
CLI-backed title calls also allow clean empty output without a silent-reply token;
ordinary CLI calls still reject empty responses.
Older external harnesses may ignore the policy; a final title filter cannot
restore provenance that a harness already discarded, so this is not a universal
reasoning-privacy guarantee. If the harness cannot enforce isolation, omit the capability.
Callers that require isolated completion then fail closed before invoking that
harness; OpenClaw does not replay the request through another runtime.
Plugin callers request isolated execution through
`api.runtime.llm.complete({ execution: { mode: "isolated-agent-runtime" } })`;
the harness callback is the provider-side enforcement SPI, not a second caller
API.

The legacy `runIsolatedCompletion(params)` host-auth-only capability is
deprecated and remains available for external plugins through 2026-10-12.
Implement V2 for harness-owned or native authentication; OpenClaw never invents
a host credential when only the legacy capability is present.

Native agent servers often have ambient built-in tools even when OpenClaw sends
an empty tool list. Disable and attest those native capabilities for the fresh
turn, use a separate transport that can serialize a true zero-tool request, or
leave the capability unsupported.

Audit evidence follows the same boundary. OpenClaw can record registered plugin
ownership and run admission, but it cannot claim an external native side effect
from an ACP update or transcript. A side effect wholly inside that runtime is
`unsupported` unless an adapter invokes an OpenClaw-owned callback before the
action. Do not reconstruct the callback from native tool status events.

### Delegated execution

A harness owner may set `delegatedExecutionPluginIds` to the ids of trusted
plugins that need to execute an existing model-locked session, such as a voice
transport continuing a Codex-backed conversation. This is static owner consent,
not a core allowlist. Keep it narrow.

Delegates receive only work admission and embedded execution. OpenClaw requires
the exact stored session key, store path, and session id; `modelSelectionLocked:
true`; and matching `agentHarnessId` and `agentHarnessRuntimeOverride` values.
The run is then scoped through the harness owner. Session creation, patching,
reset, deletion, archive, and Gateway mutation remain owner-only.

## Selection policy

OpenClaw chooses a harness after provider/model resolution:

1. Model-scoped runtime policy wins.
2. Provider-scoped runtime policy comes next.
3. `auto` asks registered harnesses if they support the resolved effective
   route. Provider/model prefixes alone never select a harness.
4. If no registered harness matches, OpenClaw uses its embedded runtime.

Plugin harness failures surface as run failures. In `auto` mode, embedded
fallback only applies when no registered plugin harness supports the resolved
provider/model. Once a plugin harness has claimed a run, OpenClaw does not
replay that same turn through another runtime, because that can change
auth/runtime semantics or duplicate side effects.

A failure that occurs before the harness starts any model work may use
`AgentHarnessPreflightError` from
`openclaw/plugin-sdk/agent-harness-runtime`. The default error remains terminal
for the whole model-fallback chain. Pass `{ scope: "harness" }` only when the
failure is local to the selected harness and retrying another model on that same
harness would repeat it. OpenClaw records the actual selected harness at the
attempt boundary, skips only later candidates proven to use that harness, and
runs any differently owned candidate through its normal runtime and policy
checks. Plugins opt into the scope but never name the harness owner on the
error. Do not use harness scope after a request or tool action may have produced
side effects.

Configured runtime policy remains authoritative about the desired runtime.
A durable native harness pin retains its transcript owner; an observed harness
on a plugin-owned concrete model chat does not become a pin, even when model
selection is locked. For concrete-model execution, neither a request nor a pin
makes an incompatible route compatible: the harness must support the prepared
facts, declare the exact-request OpenClaw fallback, or fail closed.
[Bound native session ownership](/plugins/sdk-agent-harness#bound-native-session-ownership) separately
identifies sessions whose verified native connection owns model and auth, so
unrelated outer route metadata does not replace that connection.

Next-turn metadata uses the registered support decision and retains its
model/provider/session source. Historical producer observations do not pin the
next turn. Projection never loads a harness or reads credentials.
Prepared status is explicit: missing `runtimePolicy` stays undeclared instead
of being inferred from whichever transport fields happen to be present.
When harness-owned auth leaves multiple physical routes unresolved, the
prepared support fact is the intersection of their compatible runtime ids and
reports request overrides if any candidate has them. One undeclared candidate
therefore makes native compatibility empty; `preparedAuth.source: "harness"`
is an auth owner, not permission to infer route support.

If the selected harness is surprising, enable `agents/harness` debug logging
and inspect the gateway's structured `agent harness selected` record: it
includes the selected harness id, selection reason, runtime/fallback policy,
and, in `auto` mode, each plugin candidate's support result.

The bundled Codex plugin registers `codex` as its harness id. Core treats that
as an ordinary plugin harness id; Codex-specific aliases belong in the plugin
or operator config, not in the shared runtime selector.

## Provider plus harness pairing

Most harnesses should also register a provider. The provider makes model refs,
auth status, model metadata, and `/model` selection visible to the rest of
OpenClaw. The harness then claims that provider in `supports(...)`.

The bundled Codex plugin follows this pattern:

- preferred user model refs: `openai/gpt-5.6-sol`
- compatibility refs: legacy `codex/gpt-*` refs remain accepted, but new
  configs should not use them as normal provider/model refs
- harness id: `codex`
- auth: prepared OpenAI route/profile policy for concrete requests; verified
  native-auth bindings use their native connection
- app-server request: OpenClaw sends the bare model id to Codex and lets the
  harness talk to the native app-server protocol

The Codex plugin is additive. With runtime policy unset or `auto`, OpenAI may
select Codex only when its provider-owned route contract declares `codex`
compatible: an exact official HTTPS Platform Responses or ChatGPT Responses
route with no authored request override. The `openai/*` prefix alone never
selects Codex. Custom endpoints, Completions adapters, and authored request
behavior stay on OpenClaw. Plaintext official HTTP endpoints are rejected. Older `codex/gpt-*`
refs remain compatibility inputs. See
[OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).

For operator setup, model prefix examples, and Codex-only configs, see
[Codex Harness](/plugins/codex-harness).

The Codex plugin enforces the minimum app-server version documented in
[Codex Harness](/plugins/codex-harness). It checks the initialize handshake and
blocks older, malformed, or unversioned servers. Admission permits startup to
continue; it does not prove later runtime or capability operations will succeed.

### Guarded active-run injection

Backends that accept source-bound controls advertise `messageInjectionV2` on
their active-run handle. The capability is contextually typed by
`setActiveEmbeddedRun` from `openclaw/plugin-sdk/agent-harness-runtime`; its type
can also be derived from that function's handle parameter. It requires
`version: 2`, `isAvailable()`, and
`queueMessage(text, options, assertCurrent, authorityKind)`.
The required third argument is a host-owned assertion for that individual
injection, not a run ID, fingerprint, or diagnostic identity. The required
`authorityKind` is `"run"` for ordinary input or `"source-bound"` for input
whose source lifetime also constrains dispatch. Both retain the backing-run
check; a source-bound input must never be relabeled as ordinary input.

Invoke `assertCurrent()` alongside the backend's own live-run check after
awaited preparation and immediately before queue mutation or provider dispatch.
The host normalizes false or throwing source authority into rejection and keeps
that injection revoked even if the source later appears current again. Plugins
invoke the supplied assertion; they do not reconstruct its authority. Batched
backends retain and revalidate each item's assertion, including before retries;
omit revoked items without cancelling independently accepted work or poisoning
later authorized controls.

Optional V2 `claimPendingUserInputAnswer(text, options, assertCurrent, authorityKind)`
and `cancelPendingUserInput(resolvedBy, assertCurrent, authorityKind)` methods
require the same assertion and authority kind. Carry it through question registration and persistence to the final
claim or cancellation boundary. Do not implement V2 by checking only before
calling an SDK method that itself awaits before dispatch. If the sink cannot
enforce the assertion, leave V2 unsupported.

The V1 `messageInjection`, queue options, `queueAgentHarnessMessage`, and
`setActiveEmbeddedRun` signatures shipped in v2026.8.1 remain source-compatible.
Unscoped V1 injection retains its existing behavior. Source-bound controls
require V2 and reject visibly before queue or I/O when only V1 is available;
they never fall back to an unchecked V1 callback. Existing deprecation windows
are unchanged.

Copilot remains V1-only: `@github/copilot-sdk` 1.0.11 awaits trace-context and
JSON-RPC writer preparation after `send` entry without a final-dispatch guard.
Scoped steering therefore fails before its queue, question claim, or provider
I/O; ordinary unscoped injection is unchanged. Check status, cancel the run, or
start a new explicit request instead. Update the runtime when guarded injection
is supported. Once upstream supplies a final-dispatch assertion, migrate
Copilot to V2 and remove this internal V1 reliance; do not add an unchecked
fallback or shorten the shipped API's deprecation window.

### Tool-result middleware

Bundled plugins and explicitly enabled installed plugins with matching
manifest contracts can attach runtime-neutral tool-result middleware through
`api.registerAgentToolResultMiddleware(...)` when their manifest declares the
targeted runtime ids in `contracts.agentToolResultMiddleware`. This trusted
seam is for async tool-result transforms that must run before OpenClaw or
Codex feeds tool output back into the model.

Middleware options may combine `runtimes` with a `matcher` tool-name list.
Each registration keeps that pair intact, so registering the same handler for
different runtimes does not broaden either matcher. Matchers use non-empty
canonical OpenClaw tool ids; omit `matcher` to match all tools.

Legacy bundled plugins can still use
`api.registerCodexAppServerExtensionFactory(...)` for Codex app-server-only
middleware, but new result transforms should use the runtime-neutral API. The
embedded-runner-only `api.registerEmbeddedExtensionFactory(...)` hook has been
removed; embedded tool-result transforms must use runtime-neutral middleware.

Retain `details.messageDelivery.sourceReplyDelivered` from the host message tool
before middleware transforms its result, and carry it into the attempt result.
This confirms a final external source reply and does not depend on destination
arguments or transcript mirrors.

### Terminal outcome classification

Native harnesses that own their own protocol projection can use
`classifyAgentHarnessTerminalOutcome(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` when a completed turn produced no
visible assistant text. The helper returns `empty`, `reasoning-only`, or
`planning-only` so OpenClaw's fallback policy can decide whether to retry on a
different model. `planning-only` requires the harness's explicit `planText`
field; OpenClaw does not infer it from assistant prose. The helper
intentionally leaves prompt errors, in-flight turns, and intentional silent
replies such as `NO_REPLY` unclassified.

### Live output-token usage

Call `params.hostCapabilities.reportOutputTokens?.(outputTokens)` once per
completed model response. Pass that response's output tokens, not a
thread-lifetime or cumulative attempt total. Deduplicate native response
notifications before calling it.

The host binds this callback to the admitted run, adds the response to its
lifecycle-scoped total, and publishes the cumulative `usage` event globally and
through `params.onAgentEvent`. Do not emit a second usage event. Retries share
the same run total; run cleanup releases it. A closed or superseded capability
rejects reporting. Invalid or nonpositive counts do not emit an event.

The capability is optional for compatibility with older hosts; when absent,
live output-token reporting is unavailable. Keep last-response context
snapshots and persisted billing usage separate from this live counter.

### Agent-end side effects

Native harnesses must call `runAgentEndSideEffects(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` after they finalize an attempt. It
dispatches the portable `agent_end` hook and OpenClaw's research capture
without delaying interactive replies. Use `awaitAgentEndSideEffects(...)` for
local, non-interactive runs where the attempt must not resolve until those
side effects finish. Both helpers accept the same `{ event, ctx }` payload as
`runAgentHarnessAgentEndHook(...)`; their failures do not alter the completed
attempt result.

Pass `ctx.foregroundPromptContext` built with
`buildEmbeddedForegroundPromptContext(params, agentDir)` from the same
`EmbeddedRunAttemptParams` the attempt ran with. The detached Skill Workshop
experience review rebuilds its system prompt and tool catalog from that
context, so the review shares the foreground turn's prompt-cache prefix.
Omit it only for runs that have no foreground prompt, such as CLI hook
contexts; the review is skipped for those.

### User input and tool surfaces

Native harnesses that expose a runtime-level user-input request should use the
user-input helpers from `openclaw/plugin-sdk/agent-harness-runtime` to format
the prompt, deliver it through OpenClaw's blocking reply path, and normalize
choice/free-form answers back into the runtime's native response shape. The
helper keeps channel/TUI presentation consistent while each harness keeps its
own protocol parsing and pending-request lifecycle.

OpenClaw's own blocking question tools — `ask_user`, and a `secrets` request —
are a separate case. They register a Gateway question and then wait, and the
prompt that lets a person answer it is published by whatever runs the tool. A
harness whose tools go through the embedded tool lifecycle gets that publication
from its tool-start handler. A harness that dispatches tools itself passes
`questionPrompt` to `createOpenClawCodingTools` instead, on every path where it
builds a tool surface — a side thread is its own such path: `send` is the run's
`onToolResult`, and `messageChannel` is the conversation the prompt would appear
in. Leave it out and the question is registered but never shown, so the turn
waits out its whole timeout and then reports that nobody answered.

For schema-backed forms and literal URL confirmation, use the
`agentHarnessStructuredInput` runtime surface from the same subpath. It
snapshots bounded own data without invoking accessors, compiles supported
primitive fields into Gateway questions, and executes them with batching,
secret-input, timeout, and cancellation fencing. Harnesses keep ownership of
their protocol envelope and must pass the exact turn signal and active-owner
check; `run(...)` returns an answered, declined, cancelled, or unsupported
outcome for the adapter to translate.

Pass the original prepared attempt, including its exact `hostCapabilities`
object, as `delivery` when using the native question helpers. Core captures the
question creator's prepared caller policy and lifetime before any steering handle
is published. Copies of the capability object do not carry that binding. Built-in
tools capture their creation scope; CLI native questions retain the original
caller policy before tool-cap translation. The answering turn's model choice or
queued operation never replaces the question creator's authority.

Plain-text channel answers use this creator binding even when the runtime cannot
accept ordinary steering. Missing, closed, or mismatched creator authority produces
a visible refusal, not a new agent turn. The incoming source and creator must
both remain current through the final answer dispatch. Gateway-launched CLI MCP
tools use the same original caller snapshot, bound to their exact live grant.
Standalone attach grants have no prepared run snapshot; their questions retain
structured question controls but do not accept ordinary channel text.

Omit `gatewayCall` in `runAgentHarnessGatewayQuestion(...)` or
`agentHarnessStructuredInput.run(...)` to use the core-owned Gateway transport.
It carries each input's source and backing-run assertion through registration,
persistence, connection preparation, and hello, then checks synchronously
immediately before the resolve request is sent. A refused input releases only
its own reservation: the question remains pending and its prompt and later
valid input remain usable. Persistence and a local reservation are not an
answered transition. Closure after dispatch does not make an accepted answer
replayable. Plain-text submissions carry a fresh, bounded `resolutionId` on
`question.resolve`; the question owner records it only when that submission commits.
Host waiters request `includeResolutionId: true` on `question.waitAnswer` and use
that receipt to recover a lost response using the question waiter's existing
deadline, not a separate shorter timer. Another actor's answer, even identical
text, does not establish consumption of this input. A definitive resolve rejection
releases the input immediately; a cancelled or expired waiter proves non-consumption.

If the receipt is missing, rejected, or still pending when the waiter settles,
the host records the input as unconfirmed and non-replayable rather than sending
it through ordinary steering again. This is routing ownership, not proof that the
answer committed. Channel replies, Gateway chat, Talk, and the TUI surface the
uncertainty without starting another turn or cancelling independently accepted
backing work. Notice delivery or source adoption failure does not release the
input for replay. Backing-run abort, timeout, and error cleanup retain independent
authority.

Custom transports must preserve these request and response fields for lost-response
recovery. A legacy receipt-less response remains unconfirmed; it does not prove
that another submission answered the question. `resolutionId` is an opaque
1–128-character correlation value, not permission
to resolve a question or reuse closed-source authority. Ordinary waiters omit
`includeResolutionId` (default `false`) and receive the existing response shape;
question records, lookup results, and broadcast events never gain the receipt.
The receipt is transient question-lifecycle state, not a durable record or migration.

The shipped `AgentHarnessQuestionGatewayCall` function type is unchanged.
Legacy function overrides remain valid for ordinary, unscoped input, including
run-lifetime checks. Source-bound input with only a legacy callback fails before
input persistence or resolution I/O. Function arity or the presence of a callback
does not establish guarded transport support.

A custom guarded transport instead supplies an explicit object:

```typescript
type QuestionDispatcher = Exclude<
  Parameters<typeof agentHarnessStructuredInput.run>[0]["gatewayCall"],
  AgentHarnessQuestionGatewayCall | undefined
>;
```

That object has `version: 2` and `call(request)`. The request contains `method`,
`options` (`timeoutMs?`), `params?`, `signal?`, and a required `authority`:
`{ kind: "unscoped" }` or `{ kind: "source-bound", assertCurrent }`.
The source-bound variant requires a synchronous assertion. Invoke it after all
awaited preparation and immediately before every dispatch or retry, without an
intervening await. Never substitute an observer or an after-response check.
When delegating to `callGatewayTool`, forward the protected assertion in its
existing extra bag as
`dispatchAuthority: { version: 2, kind: "source-bound", assertCurrent }`.
The same bag accepts `kind: "run"` for run-only assertions. These are local code
contracts, not Gateway wire fields, operator settings, or new SDK exports.

Each prepared attempt also receives a versioned `params.hostCapabilities`
object. Use `bindToolSurface(...)` before exposing plugin-built OpenClaw tools,
and use its policy and approval operations for native actions. A native action
whose working directory differs from the attempt may pass
`nativeOperation: { cwd }` to `runBeforeToolCall(...)`; the host normalizes that
bounded action fact while keeping identity and policy authority closure-bound. The closure
binds the host-resolved run, sandbox, requester, route, and approval identity;
plugins must not reconstruct those fields or retain the capability after the
attempt returns. Calls made after attempt settlement fail closed.

When trajectory capture has a valid host-owned session target,
`params.hostCapabilities.trajectory` provides closure-bound `recordEvent(...)`
and `flush()` operations. The host adds session attribution, bounds and redacts
event data, and persists it through the canonical trajectory store. Treat the
capability as optional, send only structured non-secret facts, and await
`flush()` before the attempt settles; do not infer storage paths or create a
plugin-side fallback when the capability is absent.

New harnesses should implement `AgentHarnessV2` and type prepared attempts as
`AgentHarnessAttemptParamsV2`, `EmbeddedRunAttemptParamsV2`, and
`AgentHarnessSideQuestionParamsV2`; those contracts require
`hostCapabilities`. Packages adopting V2 must declare
`openclaw.compat.pluginApi: ">=2026.8.1"` (or a newer floor) so older hosts
reject them before load. Import the parameter types from the runtime subpath:

```typescript
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessSideQuestionParamsV2,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
```

The older `AgentHarness`,
`AgentHarnessAttemptParams`, and `EmbeddedRunAttemptParams` names remain
source-compatible for existing plugins, so the capability field is optional
in those deprecated parameter types through 2026-10-12. The public
`AgentHarnessSideQuestionParams` contract has the same compatibility window
and optional field. Core still supplies
the capability on every selected attempt. Compatibility is type-level only:
current harness code must not add a runtime path that operates without the
host capability.

Native harnesses that need PI-like compact tool routing should use
`createAgentHarnessToolSurfaceRuntime(...)` from
`openclaw/plugin-sdk/agent-harness-tool-runtime`. It owns
tool-search/code-mode control selection, local-model lean defaults,
runtime-compatible schema filtering, hidden catalog execution, directory
hydration, and catalog cleanup. Harnesses still own their SDK-specific tool
conversion and native execution callback.

After the last policy filter, schema quarantine, and native registration
intersection, call `finalizeAgentToolAvailability(tools, options?)` from
`openclaw/plugin-sdk/agent-harness-runtime` before snapshotting tool definitions.
It returns a new array containing the same tool objects and updates only
host-owned dependent affordances, such as collector spawning when its native
result reader is callable. It does not add tools, change profiles, replace
executors, or rebind authorization and approval wrappers.

Pass `options.toolExecutionAllow` when a run retains schemas for tools it cannot
execute. Omission uses the supplied tool set; an empty list permits no execution.
The optional synchronous `options.onPrepared(tool)` observer identifies definitions
whose owner participated, so a harness can refresh their cached schemas and
prompt text without changing unrelated definitions. Reapply finalization after
later filtering, and keep the existing attempt-lifecycle guards on every tool.
Finalization does not update declarations already registered in a native runtime.
Preserve native-owned catalog bytes and fingerprints; current executor guards
still reject unavailable modes. New host-owned declarations use the harness's
existing catalog-registration lifecycle.
OpenClaw Code Mode's joined `agents.run()` path retains internal waiting; this
helper does not make raw collector calls available without a native result reader.

### Paired-device execution

Declare `cloudPlacement.devicePlacement.requiredNodeCommands` for the exact node
commands the harness needs to execute on a paired device. Core snapshots this
set when it creates the selected harness's host capabilities. An admitted
**Full access** session can authorize only those commands through the node
policy's `invokeNodeWithSessionFull` callback; other commands owned by the same
plugin do not inherit that permission. An absent declaration or an unlisted
command returns `undefined`, so the policy must use its ordinary approval or
denial path. Mutating the declaration during the attempt cannot widen authority.

This declaration narrows authority; it does not grant it. Pairing, command
allowlisting, hosting consent, node-local policy, and the exact live session,
placement, and turn remain independently enforced. Plugins remain trusted code,
not sandboxed by this callback.

### Native model inventory

`loadModelCatalog(params)` lists models for the supplied agent, workspace, and
config snapshot. Rows owned by native model selection set `nativeRuntime` to
the harness ID and omit host `api` and `baseUrl` claims. Core does not enrich
these rows with transport or capabilities from a host route.

An optional synchronous `readModelCatalogReadiness(params)` returns only
`{ accountType: string }` for a current native account observation
covering that exact scope and model. Preserve the native account type; it does
not imply a host credential or OAuth refresh lifecycle. Return `undefined` for missing, failed,
superseded, or disposed observations. Readiness must remain with the physical
native owner and be revalidated at use; never serialize it on catalog rows,
perform I/O in this callback, or infer it from a successful earlier turn.
Gateway uses this metadata for native-owned picker rows; authored host routes,
credentials, and profile locks still use host readiness. This is not execution
authorization, and all run-time compatibility and permission checks still apply.

### Native MCP inventory

A harness that owns MCP connections outside OpenClaw's in-process MCP runtime
can implement `loadMcpToolCatalog(params)`. The callback is used by read-only
control surfaces such as the composer Tool access view. It receives the
authoritative session identity, runtime config, workspace, and sparse session
MCP overrides. `mcpServerNames` is the bounded set of OpenClaw-configured
servers whose session policy the harness may represent. Return OpenClaw's
`McpToolCatalog` shape for only that set.

Use only an already-bound native process and thread. Returning `undefined`
means no live catalog is available; do not start a new harness process merely
to answer inventory. Preserve raw server/tool names, assign collision-safe
server names with `assignMcpCatalogSafeServerNames(...)`, and retain tools
hidden only by a session denial in `sessionDeniedTools`. Core still applies the
final OpenClaw tool policy and schema compatibility checks before exposing the
rows.

Harnesses that forward embedded attempt params should pass
`skillWorkshopProposalOnly` through. Proposal-only skill-workshop runs are
deliberately narrow single-tool runs, and the runtime keeps them on the raw
tool surface instead of engaging code mode or a tool-search catalog.

### Native Codex harness mode

The bundled `codex` harness is the native Codex mode for embedded OpenClaw
agent turns. Enable the bundled `codex` plugin first, and include `codex` in
`plugins.allow` if your config uses a restrictive allowlist. Native app-server
configs should use `openai/gpt-*`; OpenAI agent turns select the Codex harness
only when the effective route declares Codex compatibility. Legacy Codex model
refs should be repaired with `openclaw doctor --fix`, and legacy `codex/*`
model refs remain compatibility aliases for the native harness.

When this mode runs, Codex owns the native thread id, resume behavior,
compaction, and app-server execution. OpenClaw still owns the chat channel,
visible transcript mirror, tool policy, approvals, media delivery, and session
selection. Use provider/model `agentRuntime.id: "codex"` to require a registered
Codex harness. Unsupported routes/auth fail closed unless the harness declares
an exact-request fallback before execution. Codex runtime failures are not
retried through another runtime.

## Runtime strictness

By default, OpenClaw uses `auto` provider/model runtime policy: registered
plugin harnesses can claim compatible effective routes, and the embedded
runtime handles the turn when none match. A provider/model prefix alone never
selects a harness. Use an explicit provider/model plugin runtime such as
`agentRuntime.id: "codex"` when missing harness selection should fail instead
of routing through the embedded runtime. Explicit selection does not make an
incompatible route compatible. Selected plugin harness failures always fail
hard. This does not block an explicit provider/model
`agentRuntime.id: "openclaw"`.

To request Codex for embedded runs:

```json
{
  "models": {
    "providers": {
      "openai": {
        "agentRuntime": {
          "id": "codex"
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "openai/gpt-5.6-sol"
    }
  }
}
```

If you want a CLI backend for one canonical model, put the runtime on that
model entry:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-5",
      "models": {
        "anthropic/claude-opus-5": {
          "agentRuntime": {
            "id": "claude-cli"
          }
        }
      }
    }
  }
}
```

Per-agent overrides use the same model-scoped shape:

```json
{
  "agents": {
    "entries": {
      "codex-only": {
        "default": true,
        "model": "openai/gpt-5.6-sol",
        "models": {
          "openai/gpt-5.6-sol": {
            "agentRuntime": { "id": "codex" }
          }
        }
      }
    }
  }
}
```

Legacy whole-agent runtime examples like this are ignored:

```json validate=false
{
  "agents": {
    "defaults": {
      "agentRuntime": {
        "id": "codex"
      }
    }
  }
}
```

With an explicit plugin runtime, a session fails early when the requested
harness is not registered or rejects the resolved provider/model without a
declared fallback. An authored transport override may select OpenClaw through
that fallback even with an explicit runtime. To prove native execution, inspect
the actual harness in the completed result; configured intent alone is not proof.

This setting only controls the embedded agent harness. It does not disable
image, video, music, TTS, PDF, or other provider-specific model routing.

## Native sessions and transcript mirror

A harness may keep a native session id, thread id, or daemon-side resume
token. Keep that binding explicitly associated with the OpenClaw session, and
keep mirroring user-visible assistant/tool output into the OpenClaw
transcript.

The OpenClaw transcript remains the compatibility layer for:

- channel-visible session history
- transcript search and indexing
- switching back to the built-in OpenClaw harness on a later turn
- generic `/new`, `/reset`, and session deletion behavior

For user-message mirrors, use
`restorePreparedUserTurnOperationalMetaForRuntime({ runtimeMessage, preparedMessage })`
from `openclaw/plugin-sdk/agent-harness-runtime`. Pass an independent, trusted
snapshot of the host-prepared input as `preparedMessage`. Clone `content` and
selected-mention metadata before hooks that can mutate them in place, and keep
that snapshot unchanged.

The helper restores operational metadata on user messages without replacing
native or hook-rewritten content. Non-user runtime messages are returned unchanged.
Human mentions survive only when the entire `content` value exactly matches the
prepared snapshot; changed text must not inherit the old selections.

Restored metadata neither authorizes actions nor proves a fresh transcript append.
After the canonical append, pass its committed message, anchor, and actual
`{ appended }` result to `userTurnTranscriptRecorder.markRuntimePersisted(...)`.
Only `appended: true` can trigger an original-input commit notification; an
idempotent history match must report `false`.

Store native bindings in plugin state. Implement `reset(...)` for an in-place
session reset and `withSessionDeletion(params, run)` for removal of a session
key, including expiry and maintenance. A physical session ID changing at the
same key is a transfer, not deletion; preserve any compaction adoption path.

`withSessionDeletion` acquires the native owner's lease before calling
`run({ commit, rollback })`. Core invokes the synchronous `commit()` at the
session row deletion boundary and `rollback()` if the transaction fails.
Rollback must also tolerate a failed or unapplied commit. Keep asynchronous
subscription cleanup after `run` so it does not hold the SQLite writer queue;
do not restore bindings for errors after the session transaction committed.

Recheck `params.assertCurrent()` after awaited work and immediately before
mutating native state. The callback belongs to one registered harness lifetime;
retaining it after the operation closes does not retain authority. Post-delete
hooks are notifications, not the owner of durable binding removal.

## Tool and media results

Core constructs the OpenClaw tool list and passes it into the prepared
attempt. When a harness executes a dynamic tool call, return the tool result
back through the harness result shape instead of sending channel media
yourself.

This keeps text, image, video, music, TTS, approval, and messaging-tool
outputs on the same delivery path as OpenClaw-backed runs.

Set `AgentHarnessAttemptResult.hostOwnedToolMediaUrls` only for native artifacts
that the trusted harness runtime created and persisted itself. Every entry must
also appear in `toolMediaUrls`. Never include model-selected dynamic-tool or
OpenClaw-tool media. On `message_tool_only` routes, this narrow provenance lets
native runtime artifacts survive source-reply suppression; normal send policy
and ambient-room admission still apply.

### Terminal tool outcomes

`AgentHarnessAttemptParams.observeToolTerminal` is the host-owned terminal
outcome accumulator. A harness that executes OpenClaw dynamic tools or native
tools must call it when each tool reaches one terminal outcome, before the
attempt result is finalized. Harnesses that do not execute tools do not need to
call it.

Report facts from the execution boundary:

- Pass the protocol call id when one exists, the canonical tool name, and the
  arguments that actually reached the tool after preparation or hook rewrites.
- Pass the original host tool result or thrown error as `result`. Core reads
  private effect provenance from that object; serialized fields cannot provide
  this proof. Preserve internal result state when projecting a host result.
- Set `executionStarted: false` when validation, approval, or another guard
  stopped the call before the tool implementation began. Once dispatch may
  have happened, report `true` conservatively.
- Report `outcome: "success"` or `outcome: "failure"`. Include the structured
  failure fields available from the runtime instead of inferring failure from
  display text.
- Use `nativeMutation` only for native tools that do not use an OpenClaw tool
  definition. Supply protocol-owned mutation and replay facts there; do not
  copy OpenClaw's mutation classifier into the harness.

The callback returns the canonical resolution for that call. Carry its
`lastToolError` into `AgentHarnessAttemptResult` and use its execution,
arguments, and side-effect facts in the harness projection instead of deriving
parallel state. The host keeps an unresolved mutating failure across unrelated
successful tools and clears it only after the matching action succeeds.

The callback remains optional for source compatibility with older experimental
harnesses. Optional does not mean ignorable for a harness that executes tools:
without terminal reports, OpenClaw cannot preserve mutating-tool failure truth
across later tool calls, including quiet heartbeat completion.

### Settled tool finalization

OpenClaw may need one final visible answer after a harness has completed every
tool call but its native turn ended without assistant text. A harness can opt
into that recovery by implementing `finalizeSettledTurn({ attempt,
settledAttempt })`.

The callback is a separate capability, not another ordinary attempt. It must:

- use either the exact restricted native transcript or a complete application
  transcript frozen through the settled tool-result boundary;
- expose no tools, permission-grant or user-input capabilities, native execution
  hooks, agents, skills, memory, scheduling, extensions, or remote control;
- send only the host-provided finalization prompt; and
- fail closed if its selected transcript/isolation strategy cannot enforce
  those restrictions.

OpenClaw invokes the callback once as a terminal sub-operation, outside the
ordinary attempt and retry loop. A failure ends the run with the
side-effect-aware incomplete-turn warning; it cannot enter ordinary
auth/profile rotation, model fallback, context recovery, compaction
continuation, or hook-requested revision paths. Finalization also skips plugin
prompt mutation, `before_agent_run`, LLM input/output, terminal revision, and
`agent_end` hooks. Core diagnostics still record the operation and its failure.

The callback returns `AgentHarnessSettledTurnFinalizationResult`, not an
ordinary attempt result. Its public fields are limited to the completed
assistant message, finalization-call usage, transcript-ownership metadata, and
diagnostic trace. Tool, delivery, media, spawn, lifecycle, replay, session, and
fallback state cannot cross this result boundary. Unknown fields and assistant
tool calls fail closed.

A harness that internally reuses its full attempt engine can call
`projectSettledTurnFinalizationAttemptResult(...)` before returning. The helper
rejects canonical failure, tool, delivery, replay, and lifecycle evidence, then
projects only the narrow result. It is defense in depth after native isolation,
not a substitute for removing the native capability surface.

A projection-backed harness must capture the active branch after the settled
turn is mirrored and prove that the current prompt and every current tool
call/result are present through that boundary. Put the frozen evidence on
`settledAttempt.settledTurnFinalizationContext` as one of:

- `source: "openclaw-transcript"` with `messages`: the complete application
  transcript through the boundary.
- `source: "harness"` with `data`: an immutable, bounded projection interpreted
  only by the owning harness. Core passes this opaque value through; the
  finalizer must verify its own context type before using it.
- `source: "unavailable"`: the harness permits finalization for this settled
  turn, but safe replay evidence could not be captured. The finalizer must
  reject this state before provider or native I/O; core can still use its
  existing host-owned fallback without repeating tools.

The unavailable state records eligibility, not validated history. Eligible
capture failures, including missing, drifting, or oversized evidence, can reach
that no-model fallback. Do not emit it for failures the harness excludes from
finalization, such as authentication or usage-limit errors. Command-only
harnesses must retain the attributed assistant tool-call entry in
`messagesSnapshot`; the host fallback can use that settled-batch identity when
visible-assistant fields are absent.

Enforce projection limits while acquiring messages, rather than cloning the
whole transcript before checking its size. Successful capture must finish all
identity and source-evidence checks before returning the attempt. Do not retain
an open transcript reader in `data`. The finalizer must reject a missing,
unsupported, ambiguous, or oversized context. It must not truncate messages,
drop earlier history, or describe an application projection as exact native
history. Harnesses that resume one restricted native session do not need this
projection field.

Do not implement this callback by calling `runAttempt` with a best-effort
`disableTools` hint. The harness owner must enforce the complete native
capability boundary. OpenClaw does not provide a generic fallback because it
cannot attest that an arbitrary native runtime honored those restrictions.

The callback remains optional for experimental third-party harness
compatibility. When the selected harness omits it, OpenClaw preserves the
existing incomplete-turn error instead of risking repeated side effects.

## Current limitations

- The public import path is generic, but some attempt/result type aliases
  still carry legacy names for compatibility.
- Third-party harness installation is experimental. Prefer provider plugins
  until you need a native session runtime.
- Harness switching is supported across turns. Do not switch harnesses in the
  middle of a turn after native tools, approvals, assistant text, or message
  sends have started.

## Related

- [SDK Overview](/plugins/sdk-overview)
- [Runtime Helpers](/plugins/sdk-runtime)
- [Provider Plugins](/plugins/sdk-provider-plugins)
- [Codex Harness](/plugins/codex-harness)
- [Model Providers](/concepts/model-providers)
