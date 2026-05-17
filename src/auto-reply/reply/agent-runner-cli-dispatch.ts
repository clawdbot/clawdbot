import { runCliAgent } from "../../agents/cli-runner.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded.js";
import { emitAgentEvent, onAgentEvent } from "../../infra/agent-events.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

function shouldBridgeCliAssistantTextToReasoning(provider: string): boolean {
  return normalizeLowercaseStringOrEmpty(provider) === "claude-cli";
}

function createAssistantTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (text: string) => Promise<void>;
}) {
  const deliver = params.deliver;
  if (!deliver) {
    return {
      unsubscribe: () => undefined,
      drain: async (): Promise<void> => undefined,
    };
  }
  let lastText: string | undefined;
  let unsubscribed = false;
  let delivery = Promise.resolve();
  const rawUnsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== params.runId || evt.stream !== "assistant") {
      return;
    }
    if (params.suppressed) {
      return;
    }
    const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
    if (text === undefined || text === lastText) {
      return;
    }
    lastText = text;
    delivery = delivery.then(() => deliver(text)).catch(() => undefined);
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
  onErrorBeforeLifecycle?: (err: unknown) => Promise<void>;
  transformResult?: (result: EmbeddedPiRunResult) => EmbeddedPiRunResult;
}): Promise<EmbeddedPiRunResult> {
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
  let lifecycleTerminalEmitted = false;
  try {
    const rawResult = await runCliAgent(params.runParams);
    const result = params.transformResult?.(rawResult) ?? rawResult;
    assistantBridge.unsubscribe();
    reasoningBridge.unsubscribe();
    await assistantBridge.drain();
    await reasoningBridge.drain();

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
    await assistantBridge.drain();
    await reasoningBridge.drain();
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
