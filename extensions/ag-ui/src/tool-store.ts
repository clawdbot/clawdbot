import type { EventType } from "@ag-ui/core";

type EventWriter = (event: { type: EventType } & Record<string, unknown>) => void;

/**
 * Per-session store for the SSE event writer, read by the before/after_tool_call
 * hooks — which only ever receive a `sessionKey`, so that has to stay the lookup
 * key.
 *
 * Two requests from the same device and thread share one session key, so this
 * state is NOT safe to key by session alone: whoever registered last would own
 * the session's writer, and whoever finished first would tear down the other
 * run's state. Every entry therefore records the run that owns it, registration
 * refuses to displace a live owner, and teardown only removes your own run.
 *
 * Client-provided tools are NOT stored here: the HTTP handler forwards them per
 * request into runEmbeddedAgent's `clientTools`, bypassing the plugin registry.
 */
type RunState = {
  owner: string;
  writer: EventWriter;
  messageId: string;
  clientToolNames: Set<string>;
  /**
   * Subset of `clientToolNames` the HANDLER executes in-process (state writers).
   * Both sets are skipped by the hooks, but only a real browser tool ends the
   * run — a state writer is followed by a narration turn whose text must still
   * stream. Tracking them apart is what keeps that narration from being
   * suppressed as if the browser had taken over.
   */
  stateWriterNames: Set<string>;
  clientToolCalled: boolean;
};

const runsBySession = new Map<string, RunState>();

const NO_WRITER: EventWriter = () => {};

/**
 * Reserve a session's tool-stream state for one run.
 *
 * Call this BEFORE committing any response headers: contention has to be
 * answerable with a JSON status, and once SSE headers are flushed the response is
 * committed and `setHeader` throws. Pair with `endRun` in a `finally`.
 *
 * Returns false when another run already owns the session. The writer is attached
 * separately via `setRunWriter` once the response stream exists; until then no
 * events can be emitted for this run, which is safe because the run has not
 * started.
 */
export function claimRun(params: { sessionKey: string; owner: string }): boolean {
  const existing = runsBySession.get(params.sessionKey);
  if (existing && existing.owner !== params.owner) {
    return false;
  }
  runsBySession.set(params.sessionKey, {
    owner: params.owner,
    writer: existing?.writer ?? NO_WRITER,
    messageId: existing?.messageId ?? "",
    clientToolNames: existing?.clientToolNames ?? new Set<string>(),
    stateWriterNames: existing?.stateWriterNames ?? new Set<string>(),
    clientToolCalled: existing?.clientToolCalled ?? false,
  });
  return true;
}

/** Attach the SSE writer to a run this caller already owns. */
export function setRunWriter(params: {
  sessionKey: string;
  owner: string;
  writer: EventWriter;
  messageId: string;
}): void {
  const run = runsBySession.get(params.sessionKey);
  if (!run || run.owner !== params.owner) {
    return;
  }
  run.writer = params.writer;
  run.messageId = params.messageId;
}

/** Release the session only if `owner` still holds it. */
export function endRun(sessionKey: string, owner: string): void {
  if (runsBySession.get(sessionKey)?.owner === owner) {
    runsBySession.delete(sessionKey);
  }
}

/** True when `owner` currently holds this session. */
export function ownsRun(sessionKey: string, owner: string): boolean {
  return runsBySession.get(sessionKey)?.owner === owner;
}

export function getWriter(sessionKey: string): EventWriter | undefined {
  return runsBySession.get(sessionKey)?.writer;
}

export function getMessageId(sessionKey: string): string | undefined {
  return runsBySession.get(sessionKey)?.messageId;
}

// --- Client tool name tracking ---
// Tracks which tool names are client-provided so hooks can distinguish them.

export function markClientToolNames(sessionKey: string, names: string[]): void {
  const run = runsBySession.get(sessionKey);
  if (run) {
    run.clientToolNames = new Set(names);
  }
}

export function isClientTool(sessionKey: string, toolName: string): boolean {
  return runsBySession.get(sessionKey)?.clientToolNames.has(toolName) ?? false;
}

/** Names the handler executes itself (state writers), a subset of the client tools. */
export function markStateWriterNames(sessionKey: string, names: string[]): void {
  const run = runsBySession.get(sessionKey);
  if (run) {
    run.stateWriterNames = new Set(names);
  }
}

export function isStateWriterTool(sessionKey: string, toolName: string): boolean {
  return runsBySession.get(sessionKey)?.stateWriterNames.has(toolName) ?? false;
}

// --- Client-tool-called flag ---
// Set when a client tool is invoked during a run so the dispatcher can
// suppress text output and end the run after the tool call events.

export function setClientToolCalled(sessionKey: string): void {
  const run = runsBySession.get(sessionKey);
  if (run) {
    run.clientToolCalled = true;
  }
}

export function wasClientToolCalled(sessionKey: string): boolean {
  return runsBySession.get(sessionKey)?.clientToolCalled ?? false;
}
