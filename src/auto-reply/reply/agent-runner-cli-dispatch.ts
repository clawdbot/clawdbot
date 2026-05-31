import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { runCliAgent } from "../../agents/cli-runner.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { clearCliSession } from "../../agents/cli-session.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import { emitAgentEvent, onAgentEvent } from "../../infra/agent-events.js";

function shouldBridgeCliAssistantTextToReasoning(provider: string): boolean {
  return normalizeLowercaseStringOrEmpty(provider) === "claude-cli";
}

function createAgentEventBridge<T>(params: {
  runId: string;
  suppressed?: boolean;
  read: (evt: AgentEventPayload) => T | undefined;
  deliver?: (payload: T) => Promise<void>;
}) {
  const deliver = params.deliver;
  if (!deliver) {
    return {
      unsubscribe: () => undefined,
      drain: async (): Promise<void> => undefined,
    };
  }
  let unsubscribed = false;
  let delivery = Promise.resolve();
  const rawUnsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== params.runId) {
      return;
    }
    if (params.suppressed) {
      return;
    }
    const payload = params.read(evt);
    if (payload === undefined) {
      return;
    }
    delivery = delivery.then(() => deliver(payload)).catch(() => undefined);
  });
  return {
    unsubscribe() {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      rawUnsubscribe();
    },
    async drain(): Promise<void> {
      await delivery;
    },
  };
}

function createAssistantTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (text: string) => Promise<void>;
}) {
  let lastText: string | undefined;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    read: (evt) => {
      if (evt.stream !== "assistant") {
        return undefined;
      }
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text === undefined || text === lastText) {
        return undefined;
      }
      lastText = text;
      return text;
    },
  });
}

export type CliToolEventPayload = {
  name: string | undefined;
  phase: "start" | "update";
  args: Record<string, unknown> | undefined;
};

export function keepCliSessionBindingOnlyWhenReused(params: {
  result: EmbeddedAgentRunResult;
  existingSessionId?: string;
  onDroppedReplacement?: () => void;
}): EmbeddedAgentRunResult {
  const existingSessionId = normalizeOptionalString(params.existingSessionId);
  const agentMeta = params.result.meta.agentMeta;
  const returnedSessionId = normalizeOptionalString(agentMeta?.cliSessionBinding?.sessionId);
  const shouldClearStoredSession = agentMeta?.clearCliSessionBinding === true;
  if (
    agentMeta === undefined ||
    (!shouldClearStoredSession && existingSessionId === undefined) ||
    returnedSessionId === existingSessionId
  ) {
    return params.result;
  }
  if (returnedSessionId || shouldClearStoredSession) {
    params.onDroppedReplacement?.();
  }
  return {
    ...params.result,
    meta: {
      ...params.result.meta,
      agentMeta: {
        ...agentMeta,
        sessionId: "",
        cliSessionBinding: undefined,
        clearCliSessionBinding: undefined,
      },
    },
  };
}

export async function clearDroppedCliSessionBinding(params: {
  provider: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  activeSessionEntry?: SessionEntry;
}): Promise<void> {
  const updatedAt = Date.now();
  const clearEntry = (entry: SessionEntry | undefined) => {
    if (!entry) {
      return;
    }
    clearCliSession(entry, params.provider);
    entry.updatedAt = updatedAt;
  };
  clearEntry(params.activeSessionEntry);
  clearEntry(params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!params.storePath || !params.sessionKey) {
    return;
  }
  await updateSessionStore(params.storePath, (store) => {
    clearEntry(store[params.sessionKey!]);
  });
}

function createToolEventBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: CliToolEventPayload) => Promise<void>;
}) {
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    read: (evt) => {
      if (evt.stream !== "tool") {
        return undefined;
      }
      const phaseValue = evt.data.phase;
      if (phaseValue !== "start" && phaseValue !== "update") {
        return undefined;
      }
      const phase: CliToolEventPayload["phase"] = phaseValue === "start" ? "start" : "update";
      return {
        name: typeof evt.data.name === "string" ? evt.data.name : undefined,
        phase,
        args: isRecord(evt.data.args) ? evt.data.args : undefined,
      };
    },
  });
}

export async function runCliAgentWithLifecycle(params: {
  runId: string;
  provider: string;
  runParams: RunCliAgentParams;
  startedAt?: number;
  emitLifecycleStart?: boolean;
  emitLifecycleTerminal?: boolean;
  onAgentRunStart?: () => void;
  suppressAssistantBridge?: boolean;
  onAssistantText?: (text: string) => Promise<void>;
  onReasoningText?: (text: string) => Promise<void>;
  onToolEvent?: (payload: CliToolEventPayload) => Promise<void>;
  onErrorBeforeLifecycle?: (err: unknown) => Promise<void>;
  transformResult?: (result: EmbeddedAgentRunResult) => EmbeddedAgentRunResult;
}): Promise<EmbeddedAgentRunResult> {
  const startedAt = params.startedAt ?? Date.now();
  const emitLifecycleStart = params.emitLifecycleStart ?? true;
  const emitLifecycleTerminal = params.emitLifecycleTerminal ?? true;
  params.onAgentRunStart?.();
  if (emitLifecycleStart) {
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: {
        phase: "start",
        startedAt,
      },
    });
  }
  const assistantBridge = createAssistantTextBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onAssistantText,
  });
  const reasoningBridge = createAssistantTextBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: shouldBridgeCliAssistantTextToReasoning(params.provider)
      ? params.onReasoningText
      : undefined,
  });
  const toolBridge = createToolEventBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onToolEvent,
  });
  let lifecycleTerminalEmitted = false;
  try {
    const rawResult = await runCliAgent(params.runParams);
    const result = params.transformResult?.(rawResult) ?? rawResult;
    assistantBridge.unsubscribe();
    reasoningBridge.unsubscribe();
    toolBridge.unsubscribe();
    await assistantBridge.drain();
    await reasoningBridge.drain();
    await toolBridge.drain();

    const cliText = normalizeOptionalString(result.payloads?.[0]?.text);
    if (cliText) {
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: cliText },
      });
    }

    if (emitLifecycleTerminal) {
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
        },
      });
      lifecycleTerminalEmitted = true;
    }
    return result;
  } catch (err) {
    assistantBridge.unsubscribe();
    reasoningBridge.unsubscribe();
    toolBridge.unsubscribe();
    await assistantBridge.drain();
    await reasoningBridge.drain();
    await toolBridge.drain();
    await params.onErrorBeforeLifecycle?.(err);
    if (emitLifecycleTerminal) {
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: String(err),
        },
      });
      lifecycleTerminalEmitted = true;
    }
    throw err;
  } finally {
    assistantBridge.unsubscribe();
    reasoningBridge.unsubscribe();
    toolBridge.unsubscribe();
    if (emitLifecycleTerminal && !lifecycleTerminalEmitted) {
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: "CLI run completed without lifecycle terminal event",
        },
      });
    }
  }
}
