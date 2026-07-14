import type { AssistantMessage, Model } from "../../llm-core/src/index.js";
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

/**
 * Aborts that end a turn as an intentional handoff (e.g. yield-style tools)
 * mark it with an abort reason carrying `turnHandoff: true`. Interruption
 * guidance is skipped for them: the next turn would otherwise be told tools
 * may have partially executed after a clean, deliberate stop.
 */
export function isTurnHandoffAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason: unknown = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { turnHandoff?: unknown }).turnHandoff === true
  );
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
