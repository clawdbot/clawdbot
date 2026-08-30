import type { AssistantMessage, Model } from "@openclaw/llm-core";
import type { AgentEvent, AgentMessage } from "./types.js";

/** Canonical empty aborted/error assistant recorded when a run ends without output. */
export function createFailureMessage(
  model: Model,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

// Not re-exported from the package barrel on purpose: these helpers are
// internal loop/harness plumbing, not public agent-core API surface.
const INTERRUPTED_TURN_GUIDANCE = `<turn_aborted>
The previous turn was interrupted. Any running background processes may still be active. If any tools or commands were aborted, they may have partially executed.
</turn_aborted>`;

interface AbortHandoffReason {
  readonly code?: unknown;
  readonly turnHandoff?: unknown;
}

// Narrow the abort reason to its handoff shape once; callers check the
// specific owner code + marker fields. The canonical handoff reason is
// produced by the embedded attempt owner as SESSIONS_YIELD_ABORT_REASON
// (src/agents/embedded-agent-runner/run/attempt-sessions-yield.ts); the
// abort-signal wrapper (agent-tools.abort.ts) consumes that reason.
function readAbortHandoffReason(signal: AbortSignal | undefined): AbortHandoffReason | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) {
    return undefined;
  }
  // SAFETY: reason is validated as a non-null object above; the cast only exposes optional unknown fields for safe property access, not a stronger contract.
  return reason as AbortHandoffReason;
}

/**
 * Aborts that end a turn as an intentional handoff (e.g. yield-style tools)
 * mark it with an abort reason carrying `turnHandoff: true`. Interruption
 * guidance is skipped for them: the next turn would otherwise be told tools
 * may have partially executed after a clean, deliberate stop.
 */
export function isTurnHandoffAbort(signal: AbortSignal | undefined): boolean {
  return readAbortHandoffReason(signal)?.turnHandoff === true;
}

/**
 * True only when the given tool is the one that initiated the accepted
 * handoff. The abort reason's `code` field identifies the owning tool
 * (e.g. `SESSIONS_YIELD_ABORT_REASON` carries `code: "sessions_yield"`
 * from `src/agents/embedded-agent-runner/run/attempt-sessions-yield.ts`);
 * generic Agent Core binds that code to the current tool name rather than
 * naming a specific sessions tool. The `turnHandoff: true` marker
 * distinguishes an intentional handoff from a plain cancellation.
 * Settlement catches must match the same owner boundary so a different
 * handoff owner, a concurrent sibling cancellation, or a genuine tool/hook
 * failure is not rewritten as a successful yield result.
 */
export function isAcceptedYieldToolAbort(
  signal: AbortSignal | undefined,
  toolName: string | undefined,
): boolean {
  if (!toolName || !signal?.aborted) {
    return false;
  }
  const reason = readAbortHandoffReason(signal);
  return reason?.code === toolName && reason.turnHandoff === true;
}

/**
 * True when the caught error is causally linked to the accepted handoff's
 * abort reason, not merely any error that looks like an abort. Settlement
 * catches may preserve the accepted handoff only when the hook threw the
 * signal's own reason object (e.g., via `signal.throwIfAborted()`, which
 * throws `signal.reason` directly) or an Error wrapping that reason as
 * `cause`. An unrelated AbortError from the hook's own independent work
 * does not match and must remain an error.
 */
export function isHandoffAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason = signal.reason;
  if (error === reason) {
    return true;
  }
  return error instanceof Error && error.cause === reason;
}

export function createInterruptedTurnMessage(): AgentMessage {
  return {
    role: "custom",
    customType: "openclaw:turn-aborted",
    content: INTERRUPTED_TURN_GUIDANCE,
    display: false,
    timestamp: Date.now(),
  };
}

export async function appendInterruptedTurnMessage(
  messages: AgentMessage[],
  emit: (event: AgentEvent) => Promise<void> | void,
): Promise<void> {
  const interruption = createInterruptedTurnMessage();
  messages.push(interruption);
  await emit({ type: "message_start", message: interruption });
  await emit({ type: "message_end", message: interruption });
}

export function normalizeCoreContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "custom" || message.customType !== "openclaw:turn-aborted") {
      return message;
    }
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content,
      timestamp: message.timestamp,
    };
  });
}
