---
title: "Codex Harness Context Engine Port"
summary: "Specification for making the bundled Codex app-server harness honor OpenClaw context-engine plugins"
read_when:
  - You are wiring context-engine lifecycle behavior into the Codex harness
  - You need lossless-claw or another context-engine plugin to work with codex/* embedded harness sessions
  - You are comparing embedded PI and Codex app-server context behavior
---

## Status

Draft implementation specification.

## Goal

Make the bundled Codex app-server harness honor the same OpenClaw context-engine
lifecycle contract that embedded PI turns already honor.

A session using `agents.defaults.embeddedHarness.runtime: "codex"` or a
`codex/*` model should still let the selected context-engine plugin, such as
`lossless-claw`, control context assembly, post-turn ingest, maintenance, and
OpenClaw-level compaction policy as far as the Codex app-server boundary allows.

## Non-goals

- Do not reimplement Codex app-server internals.
- Do not make Codex native thread compaction produce a lossless-claw summary.
- Do not require non-Codex models to use the Codex harness.
- Do not change ACP/acpx session behavior. This specification is for the
  non-ACP embedded agent harness path only.
- Do not make third-party plugins register Codex app-server extension factories;
  the existing bundled-plugin trust boundary remains unchanged.

## Current architecture

The embedded run loop resolves the configured context engine once per run before
selecting a concrete low-level harness:

- `src/agents/pi-embedded-runner/run.ts`
  - initializes context-engine plugins
  - calls `resolveContextEngine(params.config)`
  - passes `contextEngine` and `contextTokenBudget` into
    `runEmbeddedAttemptWithBackend(...)`

`runEmbeddedAttemptWithBackend(...)` delegates to the selected agent harness:

- `src/agents/pi-embedded-runner/run/backend.ts`
- `src/agents/harness/selection.ts`

The Codex app-server harness is registered by the bundled Codex plugin:

- `extensions/codex/index.ts`
- `extensions/codex/harness.ts`

The Codex harness implementation receives the same `EmbeddedRunAttemptParams`
as PI-backed attempts:

- `extensions/codex/src/app-server/run-attempt.ts`

That means the required hook point is in OpenClaw-controlled code. The external
boundary is the Codex app-server protocol itself: OpenClaw can control what it
sends to `thread/start`, `thread/resume`, and `turn/start`, and can observe
notifications, but it cannot change Codex's internal thread store or native
compactor.

## Current gap

Embedded PI attempts call the context-engine lifecycle directly:

- bootstrap/maintenance before the attempt
- assemble before the model call
- afterTurn or ingest after the attempt
- maintenance after a successful turn
- context-engine compaction for engines that own compaction

Relevant PI code:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/attempt.context-engine-helpers.ts`
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`

Codex app-server attempts currently run generic agent-harness hooks and mirror
the transcript, but do not call `params.contextEngine.bootstrap`,
`params.contextEngine.assemble`, `params.contextEngine.afterTurn`,
`params.contextEngine.ingestBatch`, `params.contextEngine.ingest`, or
`params.contextEngine.maintain`.

Relevant Codex code:

- `extensions/codex/src/app-server/run-attempt.ts`
- `extensions/codex/src/app-server/thread-lifecycle.ts`
- `extensions/codex/src/app-server/event-projector.ts`
- `extensions/codex/src/app-server/compact.ts`

## Desired behavior

For Codex harness turns, OpenClaw should preserve this lifecycle:

1. Read the mirrored OpenClaw session transcript.
2. Bootstrap the active context engine when a previous session file exists.
3. Run bootstrap maintenance when available.
4. Assemble context using the active context engine.
5. Convert the assembled context into Codex-compatible inputs.
6. Start or resume the Codex thread with developer instructions that include any
   context-engine `systemPromptAddition`.
7. Start the Codex turn with the assembled user-facing prompt.
8. Mirror the Codex result back into the OpenClaw transcript.
9. Call `afterTurn` if implemented, otherwise `ingestBatch`/`ingest`, using the
   mirrored transcript snapshot.
10. Run turn maintenance after successful non-aborted turns.
11. Preserve Codex native compaction signals and OpenClaw compaction hooks.

## Design constraints

### Codex app-server remains canonical for native thread state

Codex owns its native thread and any internal extended history. OpenClaw should
not try to mutate the app-server's internal history except through supported
protocol calls.

OpenClaw's transcript mirror remains the source for OpenClaw features:

- chat history
- search
- `/new` and `/reset` bookkeeping
- future model or harness switching
- context-engine plugin state

### Context engine assembly must be projected into Codex inputs

The context-engine interface returns OpenClaw `AgentMessage[]`, not a Codex
thread patch. Codex app-server `turn/start` accepts a current user input, while
`thread/start` and `thread/resume` accept developer instructions.

Therefore the implementation needs a projection layer. The safe first version
should avoid pretending it can replace Codex internal history. It should inject
assembled context as deterministic prompt/developer-instruction material around
the current turn.

### Prompt-cache stability matters

For engines like lossless-claw, the assembled context should be deterministic
for unchanged inputs. Do not add timestamps, random ids, or nondeterministic
ordering to generated context text.

### Runtime selection semantics do not change

Harness selection remains as-is:

- `runtime: "pi"` forces PI
- `runtime: "codex"` selects the registered Codex harness
- `runtime: "auto"` lets plugin harnesses claim supported providers
- unmatched `auto` runs use PI

This work changes what happens after the Codex harness is selected.

## Implementation plan

### 1. Export or relocate reusable context-engine attempt helpers

Today the reusable lifecycle helpers live under the PI runner:

- `src/agents/pi-embedded-runner/run/attempt.context-engine-helpers.ts`
- `src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts`
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`

Codex should not import from an implementation path whose name implies PI if we
can avoid it.

Create a harness-neutral module, for example:

- `src/agents/harness/context-engine-lifecycle.ts`

Move or re-export:

- `runAttemptContextEngineBootstrap`
- `assembleAttemptContextEngine`
- `finalizeAttemptContextEngineTurn`
- `buildAfterTurnRuntimeContext`
- `buildAfterTurnRuntimeContextFromUsage`
- a small wrapper around `runContextEngineMaintenance`

Keep PI imports working either by re-exporting from the old files or updating PI
call sites in the same PR.

The neutral helper names should not mention PI.

Suggested names:

- `bootstrapHarnessContextEngine`
- `assembleHarnessContextEngine`
- `finalizeHarnessContextEngineTurn`
- `buildHarnessContextEngineRuntimeContext`
- `runHarnessContextEngineMaintenance`

### 2. Add a Codex context projection helper

Add a new module:

- `extensions/codex/src/app-server/context-engine-projection.ts`

Responsibilities:

- Accept the assembled `AgentMessage[]`, original mirrored history, and current
  prompt.
- Determine which context belongs in developer instructions vs current user
  input.
- Preserve the current user prompt as the final actionable request.
- Render prior messages in a stable, explicit format.
- Avoid volatile metadata.

Proposed API:

```ts
export type CodexContextProjection = {
  developerInstructionAddition?: string;
  promptText: string;
  assembledMessages: AgentMessage[];
  prePromptMessageCount: number;
};

export function projectContextEngineAssemblyForCodex(params: {
  assembledMessages: AgentMessage[];
  originalHistoryMessages: AgentMessage[];
  prompt: string;
  systemPromptAddition?: string;
}): CodexContextProjection;
```

Recommended first projection:

- Put `systemPromptAddition` into developer instructions.
- Put the assembled transcript context before the current prompt in `promptText`.
- Label it clearly as OpenClaw assembled context.
- Keep current prompt last.
- Exclude duplicate current user prompt if it already appears at the tail.

Example prompt shape:

```text
OpenClaw assembled context for this turn:

<conversation_context>
[user]
...

[assistant]
...
</conversation_context>

Current user request:
...
```

This is less elegant than native Codex history surgery, but it is implementable
inside OpenClaw and preserves context-engine semantics.

Future improvement: if Codex app-server exposes a protocol for replacing or
supplementing thread history, swap this projection layer to use that API.

### 3. Wire bootstrap before Codex thread startup

In `extensions/codex/src/app-server/run-attempt.ts`:

- Read mirrored session history as today.
- Determine whether the session file existed before this run. Prefer a helper
  that checks `fs.stat(params.sessionFile)` before mirroring writes.
- Open a `SessionManager` or use a narrow session manager adapter if the helper
  requires it.
- Call the neutral bootstrap helper when `params.contextEngine` exists.

Pseudo-flow:

```ts
const hadSessionFile = await fileExists(params.sessionFile);
const sessionManager = SessionManager.open(params.sessionFile);
const historyMessages = sessionManager.buildSessionContext().messages;

await bootstrapHarnessContextEngine({
  hadSessionFile,
  contextEngine: params.contextEngine,
  sessionId: params.sessionId,
  sessionKey: sandboxSessionKey,
  sessionFile: params.sessionFile,
  sessionManager,
  runtimeContext: buildHarnessContextEngineRuntimeContext(...),
  runMaintenance: runHarnessContextEngineMaintenance,
  warn,
});
```

Use the same `sessionKey` convention as the Codex tool bridge and transcript
mirror. Today Codex computes `sandboxSessionKey` from `params.sessionKey` or
`params.sessionId`; use that consistently unless there is a reason to preserve
raw `params.sessionKey`.

### 4. Wire assemble before `thread/start` / `thread/resume` and `turn/start`

In `runCodexAppServerAttempt`:

1. Build dynamic tools first, so the context engine sees the actual available
   tool names.
2. Read mirrored session history.
3. Run context-engine `assemble(...)` when `params.contextEngine` exists.
4. Project the assembled result into:
   - developer instruction addition
   - prompt text for `turn/start`

The existing hook call:

```ts
resolveAgentHarnessBeforePromptBuildResult({
  prompt: params.prompt,
  developerInstructions: buildDeveloperInstructions(params),
  messages: historyMessages,
  ctx: hookContext,
});
```

should become context-aware:

1. compute base developer instructions with `buildDeveloperInstructions(params)`
2. apply context-engine assembly/projection
3. run `before_prompt_build` with the projected prompt/developer instructions

This order lets generic prompt hooks see the same prompt Codex will receive. If
we need strict PI parity, run context-engine assembly before hook composition,
because PI applies context-engine `systemPromptAddition` to the final system
prompt after its prompt pipeline. The important invariant is that both context
engine and hooks get a deterministic, documented order.

Recommended order for first implementation:

1. `buildDeveloperInstructions(params)`
2. context-engine `assemble()`
3. append/prepend `systemPromptAddition` to developer instructions
4. project assembled messages into prompt text
5. `resolveAgentHarnessBeforePromptBuildResult(...)`
6. pass final developer instructions to `startOrResumeThread(...)`
7. pass final prompt text to `buildTurnStartParams(...)`

The spec should be encoded in tests so future changes do not reorder it by
accident.

### 5. Preserve prompt-cache stable formatting

The projection helper must produce byte-stable output for identical inputs:

- stable message order
- stable role labels
- no generated timestamps
- no object key order leakage
- no random delimiters
- no per-run ids

Use fixed delimiters and explicit sections.

### 6. Wire post-turn after transcript mirroring

Codex's `CodexAppServerEventProjector` builds a local `messagesSnapshot` for the
current turn. `mirrorTranscriptBestEffort(...)` writes that snapshot into the
OpenClaw transcript mirror.

After mirroring succeeds or fails, call the context-engine finalizer with the
best available message snapshot:

- Prefer full mirrored session context after the write, because `afterTurn`
  expects the session snapshot, not only the current turn.
- Fall back to `historyMessages + result.messagesSnapshot` if the session file
  cannot be reopened.

Pseudo-flow:

```ts
const prePromptMessageCount = historyMessages.length;
await mirrorTranscriptBestEffort(...);
const finalMessages = readMirroredSessionHistoryMessages(params.sessionFile)
  ?? [...historyMessages, ...result.messagesSnapshot];

await finalizeHarnessContextEngineTurn({
  contextEngine: params.contextEngine,
  promptError: Boolean(finalPromptError),
  aborted: finalAborted,
  yieldAborted,
  sessionIdUsed: params.sessionId,
  sessionKey: sandboxSessionKey,
  sessionFile: params.sessionFile,
  messagesSnapshot: finalMessages,
  prePromptMessageCount,
  tokenBudget: params.contextTokenBudget,
  runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
    attempt: params,
    workspaceDir: effectiveWorkspace,
    agentDir,
    tokenBudget: params.contextTokenBudget,
    lastCallUsage: result.attemptUsage,
    promptCache: result.promptCache,
  }),
  runMaintenance: runHarnessContextEngineMaintenance,
  sessionManager,
  warn,
});
```

If mirroring fails, still call `afterTurn` with the fallback snapshot, but log
that the context engine is ingesting from fallback turn data.

### 7. Normalize usage and prompt-cache runtime context

Codex results include normalized usage from app-server token notifications when
available. Pass that usage into the context-engine runtime context.

If Codex app-server eventually exposes cache read/write details, map them into
`ContextEnginePromptCacheInfo`. Until then, omit `promptCache` rather than
inventing zeros.

### 8. Compaction policy

There are two compaction systems:

1. OpenClaw context-engine `compact()`
2. Codex app-server native `thread/compact/start`

Do not silently conflate them.

#### `/compact` and explicit OpenClaw compaction

When the selected context engine has `info.ownsCompaction === true`, explicit
OpenClaw compaction should prefer the context engine's `compact()` result for
the OpenClaw transcript mirror and plugin state.

When the selected Codex harness has a native thread binding, we may additionally
request Codex native compaction to keep the app-server thread healthy, but this
must be reported as a separate backend action in details.

Recommended behavior:

- If `contextEngine.info.ownsCompaction === true`:
  - call context-engine `compact()` first
  - then best-effort call Codex native compaction when a thread binding exists
  - return the context-engine result as the primary result
  - include Codex native compaction status in `details.codexNativeCompaction`
- If the active context engine does not own compaction:
  - preserve current Codex native compaction behavior

This likely requires changing `extensions/codex/src/app-server/compact.ts` or
wrapping it from the generic compaction path, depending on where
`maybeCompactAgentHarnessSession(...)` is invoked.

#### In-turn Codex native contextCompaction events

Codex may emit `contextCompaction` item events during a turn. Keep the current
before/after compaction hook emission in `event-projector.ts`, but do not treat
that as a completed context-engine compaction.

For engines that own compaction, emit an explicit diagnostic when Codex performs
native compaction anyway:

- stream/event name: existing `compaction` stream is acceptable
- details: `{ backend: "codex-app-server", ownsCompaction: true }`

This makes the split auditable.

### 9. Session reset and binding behavior

The existing Codex harness `reset(...)` clears the Codex app-server binding from
the OpenClaw session file. Preserve that behavior.

Also ensure context-engine state cleanup continues to happen through existing
OpenClaw session lifecycle paths. Do not add Codex-specific cleanup unless the
context-engine lifecycle currently misses reset/delete events for all harnesses.

### 10. Error handling

Follow PI semantics:

- bootstrap failures warn and continue
- assemble failures warn and fall back to unassembled pipeline messages/prompt
- afterTurn/ingest failures warn and mark post-turn finalization unsuccessful
- maintenance runs only after successful, non-aborted, non-yield turns
- compaction errors should not be retried as fresh prompts

Codex-specific additions:

- If context projection fails, warn and fall back to the original prompt.
- If transcript mirror fails, still attempt context-engine finalization with
  fallback messages.
- If Codex native compaction fails after context-engine compaction succeeds,
  do not fail the whole OpenClaw compaction when the context engine is primary.

## Test plan

### Unit tests

Add tests under `extensions/codex/src/app-server`:

1. `run-attempt.context-engine.test.ts`
   - Codex calls `bootstrap` when a session file exists.
   - Codex calls `assemble` with mirrored messages, token budget, tool names,
     citations mode, model id, and prompt.
   - `systemPromptAddition` is included in developer instructions.
   - Assembled messages are projected into the prompt before current request.
   - Codex calls `afterTurn` after transcript mirroring.
   - Without `afterTurn`, Codex calls `ingestBatch` or per-message `ingest`.
   - Turn maintenance runs after successful turns.
   - Turn maintenance does not run on prompt error, abort, or yield abort.

2. `context-engine-projection.test.ts`
   - stable output for identical inputs
   - no duplicate current prompt when assembled history includes it
   - handles empty history
   - preserves role order
   - includes system prompt addition only in developer instructions

3. `compact.context-engine.test.ts`
   - owning context engine primary result wins
   - Codex native compaction status appears in details when also attempted
   - Codex native failure does not fail owning context-engine compaction
   - non-owning context engine preserves current native compaction behavior

### Existing tests to update

- `extensions/codex/src/app-server/run-attempt.test.ts` if present, otherwise
  nearest Codex app-server run tests.
- `extensions/codex/src/app-server/event-projector.test.ts` only if compaction
  event details change.
- `src/agents/harness/selection.test.ts` should not need changes unless config
  behavior changes; it should remain stable.
- PI context-engine tests should continue to pass unchanged.

### Integration / live tests

Add or extend live Codex harness smoke tests:

- configure `plugins.slots.contextEngine` to a test engine
- configure `agents.defaults.model` to a `codex/*` model
- configure `agents.defaults.embeddedHarness.runtime = "codex"`
- assert test engine observed:
  - bootstrap
  - assemble
  - afterTurn or ingest
  - maintenance

Avoid requiring lossless-claw in OpenClaw core tests. Use a small in-repo fake
context engine plugin.

## Observability

Add debug logs around Codex context-engine lifecycle calls:

- `codex context engine bootstrap started/completed/failed`
- `codex context engine assemble applied`
- `codex context engine finalize completed/failed`
- `codex context engine maintenance skipped` with reason
- `codex native compaction completed alongside context-engine compaction`

Avoid logging full prompts or transcript contents.

Add structured fields where useful:

- `sessionId`
- `sessionKey` redacted or omitted according to existing logging practice
- `engineId`
- `threadId`
- `turnId`
- `assembledMessageCount`
- `estimatedTokens`
- `hasSystemPromptAddition`

## Migration / compatibility

This should be backward-compatible:

- If no context engine is configured, legacy context engine behavior should be
  equivalent to today's Codex harness behavior.
- If context-engine `assemble` fails, Codex should continue with the original
  prompt path.
- Existing Codex thread bindings should remain valid.
- Dynamic tool fingerprinting should not include context-engine output; otherwise
  every context change could force a new Codex thread. Only the tool catalog
  should affect the dynamic tool fingerprint.

## Open questions

1. Should assembled context be injected entirely into the user prompt, entirely
   into developer instructions, or split?

   Recommendation: split. Put `systemPromptAddition` in developer instructions;
   put assembled transcript context in the user prompt wrapper. This best matches
   the current Codex protocol without mutating native thread history.

2. Should Codex native compaction be disabled when a context engine owns
   compaction?

   Recommendation: no, not initially. Codex native compaction may still be
   necessary to keep the app-server thread alive. But it must be reported as
   native Codex compaction, not as context-engine compaction.

3. Should `before_prompt_build` run before or after context-engine assembly?

   Recommendation: after context-engine projection for Codex, so generic harness
   hooks see the actual prompt/developer instructions Codex will receive. If PI
   parity requires the opposite, encode the chosen order in tests and document it
   here.

4. Can Codex app-server accept a future structured context/history override?

   Unknown. If it can, replace the text projection layer with that protocol and
   keep the lifecycle calls unchanged.

## Acceptance criteria

- A `codex/*` embedded harness turn invokes the selected context engine's
  assemble lifecycle.
- A context-engine `systemPromptAddition` affects Codex developer instructions.
- Assembled context affects the Codex turn input deterministically.
- Successful Codex turns call `afterTurn` or ingest fallback.
- Successful Codex turns run context-engine turn maintenance.
- Failed/aborted/yield-aborted turns do not run turn maintenance.
- Context-engine-owned compaction remains primary for OpenClaw/plugin state.
- Codex native compaction remains auditable as native Codex behavior.
- Existing PI context-engine behavior is unchanged.
- Existing Codex harness behavior is unchanged when no non-legacy context engine
  is selected or when assembly fails.
