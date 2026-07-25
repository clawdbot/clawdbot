import type { WorkerTranscriptMessage } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agents/agent-runtime-id.js";
import {
  buildUsageAgentMetaFields,
  resolveReportedModelRef,
} from "../../agents/embedded-agent-runner/run/helpers.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
} from "../../agents/embedded-agent-runner/usage-accumulator.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { hasNonzeroUsage, normalizeUsage } from "../../agents/usage.js";
import type { WorkerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import { toWorkerTranscriptMessage } from "../../worker/transcript-message.js";
import type { WorkerRuntimeResult } from "../../worker/worker.runtime.js";

export function windowInitialMessages(messages: AgentMessage[]): WorkerTranscriptMessage[] {
  const projected = messages.flatMap((message) => {
    const value = toWorkerTranscriptMessage(message);
    return value ? [value] : [];
  });
  if (projected.length <= WORKER_INFERENCE_MAX_CONTEXT_MESSAGES) {
    return projected;
  }
  const minimumStart = projected.length - WORKER_INFERENCE_MAX_CONTEXT_MESSAGES;
  const completeTurnStart = projected.findIndex(
    (message, index) => index >= minimumStart && message.role === "user",
  );
  if (completeTurnStart < 0) {
    throw new Error("Worker turn transcript has no complete context window");
  }
  return projected.slice(completeTurnStart);
}

export function fitLaunchDescriptor(
  build: (initialMessages: WorkerTranscriptMessage[]) => WorkerLaunchDescriptor,
  messages: WorkerTranscriptMessage[],
): WorkerLaunchDescriptor {
  let initialMessages = messages;
  while (true) {
    const descriptor = build(initialMessages);
    if (
      Buffer.byteLength(JSON.stringify(descriptor), "utf8") <=
      WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES
    ) {
      return descriptor;
    }
    const nextTurn = initialMessages.findIndex(
      (message, index) => index > 0 && message.role === "user",
    );
    if (nextTurn < 0) {
      throw new Error("Worker turn context exceeds the launch descriptor payload limit");
    }
    initialMessages = initialMessages.slice(nextTurn);
  }
}

export function parseRuntimeResult(stdout: string): WorkerRuntimeResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    throw new Error("Worker process returned invalid output", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker process returned invalid output");
  }
  const result = value as Record<string, unknown>;
  if (
    result.status === "failed" &&
    result.reason === "turn-failed" &&
    Object.keys(result).every((key) => ["status", "reason"].includes(key))
  ) {
    return result as WorkerRuntimeResult;
  }
  if (
    result.status === "completed" &&
    (result.transcriptLeafId === null || typeof result.transcriptLeafId === "string") &&
    typeof result.transcriptNextSeq === "number" &&
    Number.isSafeInteger(result.transcriptNextSeq) &&
    result.transcriptNextSeq >= 1 &&
    Object.keys(result).every((key) =>
      ["status", "transcriptLeafId", "transcriptNextSeq"].includes(key),
    )
  ) {
    return result as WorkerRuntimeResult;
  }
  if (
    result.status === "fenced" &&
    (result.reason === "credential-replaced" || result.reason === "owner-epoch-mismatch") &&
    Object.keys(result).every((key) => ["status", "reason"].includes(key))
  ) {
    return result as WorkerRuntimeResult;
  }
  throw new Error("Worker process returned invalid output");
}

export function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function buildWorkerAgentMeta(params: {
  messages: AgentMessage[];
  modelRef: { provider: string; model: string };
}) {
  const usageAccumulator = createUsageAccumulator();
  const assistants = params.messages.filter(
    (message): message is Extract<AgentMessage, { role: "assistant" }> =>
      message.role === "assistant",
  );
  let lastRunPromptUsage: ReturnType<typeof normalizeUsage>;
  for (const assistant of assistants) {
    const usage = normalizeUsage(assistant.usage);
    mergeUsageIntoAccumulator(usageAccumulator, usage);
    if (hasNonzeroUsage(usage)) {
      lastRunPromptUsage = usage;
    }
  }
  const lastAssistant = assistants.at(-1);
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator,
    lastAssistantUsage: lastAssistant?.usage,
    lastRunPromptUsage,
    lastTurnTotal: lastRunPromptUsage?.total,
  });
  const reportedModelRef = resolveReportedModelRef({
    ...params.modelRef,
    assistant: lastAssistant,
  });
  return {
    provider: reportedModelRef.provider,
    model: reportedModelRef.model,
    usage: usageMeta.usage,
    lastCallUsage: usageMeta.lastCallUsage,
    promptTokens: usageMeta.promptTokens,
  };
}

function resolveTurnModelRef(params: SessionPlacementTurnParams): {
  provider: string;
  model: string;
} {
  const explicitProvider = params.provider?.trim();
  const explicitModel = params.model?.trim();
  const defaults =
    explicitProvider && explicitModel
      ? undefined
      : resolveDefaultModelForAgent({ cfg: params.config ?? {}, agentId: params.agentId });
  return {
    provider: explicitProvider ?? defaults?.provider ?? "",
    model: explicitModel ?? defaults?.model ?? "",
  };
}

export function assertSupportedTurn(params: SessionPlacementTurnParams): {
  provider: string;
  model: string;
} {
  if (params.images?.length || params.imageOrder?.length) {
    throw new Error("Cloud worker turns do not yet support current-turn image input");
  }
  if (params.clientTools?.length) {
    throw new Error("Cloud worker turns do not support client-provided tools");
  }
  const modelRef = resolveTurnModelRef(params);
  const explicitRuntime =
    normalizeOptionalAgentRuntimeId(params.agentHarnessId) ??
    normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const runtime =
    explicitRuntime && !isDefaultAgentRuntimeId(explicitRuntime)
      ? explicitRuntime
      : resolveEffectiveAgentRuntime({
          cfg: params.config ?? {},
          provider: modelRef.provider,
          modelId: modelRef.model,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
  if (runtime !== OPENCLAW_AGENT_RUNTIME_ID) {
    throw new Error(`Cloud worker turns require the OpenClaw runtime, not ${runtime}`);
  }
  return modelRef;
}
