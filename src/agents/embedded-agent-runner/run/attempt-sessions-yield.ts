import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionManager } from "../../sessions/index.js";
/**
 * Handles sessions-yield interruption, persistence, and artifact cleanup.
 */
import { isRunnerAbortError } from "../abort.js";
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt-finalize.js";

const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE = "openclaw.sessions_yield";

const SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS = resolveEmbeddedAbortSettleTimeoutMs();

// Persist a hidden context reminder so the next turn knows why the runner stopped.
function buildSessionsYieldContextMessage(message: string): string {
  return `${message}\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]`;
}

export async function waitForSessionsYieldAbortSettle(params: {
  settlePromise: Promise<void> | null;
  runId: string;
  sessionId: string;
}): Promise<void> {
  if (!params.settlePromise) {
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    params.settlePromise
      .then(() => "settled" as const)
      .catch((err: unknown) => {
        log.warn(
          `sessions_yield abort settle failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`,
        );
        return "errored" as const;
      }),
    new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (outcome === "timed_out") {
    log.warn(
      `sessions_yield abort settle timed out: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS}`,
    );
  }
}

// Return a synthetic aborted response so agent runtime unwinds without a real provider call.
export function createYieldAbortedResponse(model: {
  api?: string;
  provider?: string;
  id?: string;
}): {
  [Symbol.asyncIterator]: () => AsyncGenerator<never, void, unknown>;
  result: () => Promise<{
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "aborted";
    api: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    timestamp: number;
  }>;
} {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "" }],
    stopReason: "aborted" as const,
    api: model.api ?? "",
    provider: model.provider ?? "",
    model: model.id ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message,
  };
}

// sessions_yield ends the turn as a clean handoff, not an interruption.
// turnHandoff:true tells agent-core to skip <turn_aborted> guidance
// (packages/agent-core/src/turn-interruption.ts); code keys the runner's
// own yield checks in attempt.ts and attempt-stream.ts.
export const SESSIONS_YIELD_ABORT_REASON = { code: "sessions_yield", turnHandoff: true } as const;

/** True when a runner abort error was raised by the sessions_yield handoff. */
export function isSessionsYieldAbortError(err: unknown): boolean {
  return isRunnerAbortError(err) && err instanceof Error && isSessionsYieldAbortReason(err.cause);
}

export function isSessionsYieldAbortReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { code?: unknown }).code === "sessions_yield"
  );
}

// Queue a hidden steering message so agent runtime injects it before the next
// LLM call once the current assistant turn finishes executing its tool calls.
export function queueSessionsYieldInterruptMessage(activeSession: {
  agent: { steer: (message: AgentMessage) => void };
}) {
  activeSession.agent.steer({
    role: "custom",
    customType: SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
    content: "[sessions_yield interrupt]",
    display: false,
    details: { source: "sessions_yield" },
    timestamp: Date.now(),
  });
}

// Append the caller-provided yield payload as a hidden session message once the run is idle.
export async function persistSessionsYieldContextMessage(
  activeSession: {
    sendCustomMessage: (
      message: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
      },
      options?: { triggerTurn?: boolean },
    ) => Promise<void>;
  },
  message: string,
) {
  await activeSession.sendCustomMessage(
    {
      customType: SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE,
      content: buildSessionsYieldContextMessage(message),
      display: false,
      details: { source: "sessions_yield", message },
    },
    { triggerTurn: false },
  );
}

// Remove the synthetic yield interrupt + aborted assistant entry from the live transcript.
// After strip, the transcript must end with a non-assistant role so subagent
// completion auto-announce can inject a continuation turn.
export function stripSessionsYieldArtifacts(activeSession: {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
  sessionManager: Pick<SessionManager, "removeTrailingEntries">;
}) {
  const strippedMessages = activeSession.messages.slice();

  // The tool-calling assistant turn and synthetic abort artifacts form one
  // non-continuable suffix after sessions_yield.
  while (strippedMessages.length > 0) {
    const last = strippedMessages.at(-1);
    const removable =
      last?.role === "assistant" ||
      (last?.role === "custom" && last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE);
    if (!removable) {
      break;
    }
    strippedMessages.pop();
  }

  const removedMessages = activeSession.messages.slice(strippedMessages.length);
  if (removedMessages.length === 0) {
    return;
  }

  activeSession.agent.state.messages = strippedMessages;

  // The interrupt marker can settle independently in live and persisted state.
  // Only assistant removals need the live-suffix cap to prevent data loss.
  let remainingAssistantCount = removedMessages.filter(
    (message) => message.role === "assistant",
  ).length;
  activeSession.sessionManager.removeTrailingEntries(
    (entry) => {
      if (
        entry.type === "custom_message" &&
        entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE
      ) {
        return true;
      }
      if (
        entry.type !== "message" ||
        entry.message.role !== "assistant" ||
        remainingAssistantCount === 0
      ) {
        return false;
      }
      remainingAssistantCount -= 1;
      return true;
    },
    {
      preserveTrailing: (entry) =>
        entry.type === "custom" ||
        entry.type === "label" ||
        entry.type === "session_info" ||
        (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
    },
  );
}
