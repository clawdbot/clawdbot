import type { WorkerTranscriptMessage } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  resolvePreparedRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
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
import { resolveEffectiveToolFsWorkspaceOnly } from "../../agents/tool-fs-policy.js";
import { hasNonzeroUsage, normalizeUsage } from "../../agents/usage.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import {
  windowWorkerReplayMessages,
  type WorkerReplayMessageWindowUnavailable,
} from "../../worker/replay-message-window.js";
import {
  toWorkerTranscriptMessage,
  type WorkerProviderReplayUnavailable,
} from "../../worker/transcript-message.js";
import { parseWorkerRuntimeResult } from "../../worker/worker-process-protocol.js";
import type { WorkerRuntimeResult } from "../../worker/worker.runtime.js";
import {
  measureAgentRuntimeIdentityTokenBytes,
  mintAgentRuntimeIdentityToken,
  type AgentRuntimeIdentityTokenParams,
} from "../agent-runtime-identity-token.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  bindWorkerTurnAdmissionContinuation,
  bindWorkerTurnExecutionIdentity,
} from "./placement-turn-claim-events.js";
import { WorkerTurnExecutionError } from "./worker-turn-failure.js";

export async function prepareWorkerTurnImages(
  turn: SessionPlacementTurnParams,
  agentId: string,
  workspaceDir: string,
) {
  // Managed image references belong to the Gateway filesystem. Rendered PDF
  // pages use the same ordered image input before crossing the worker boundary.
  const { prepareEmbeddedAttemptPromptExecution } =
    await import("../../agents/embedded-agent-runner/run/prompt-image-preparation.js");
  const result = await prepareEmbeddedAttemptPromptExecution({
    attempt: {
      ...turn,
      model: { input: turn.modelHasVision === false ? ["text"] : ["text", "image"] },
    },
    mediaOwnerAgentId: agentId,
    effectiveFsWorkspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg: turn.config, agentId }),
    effectiveWorkspace: workspaceDir,
    prompt: "",
    skipPromptSubmission: false,
  });
  if (result.failedMediaCount > 0) {
    throw new WorkerTurnExecutionError(
      `Cloud worker could not load ${result.failedMediaCount} image attachment(s). Resend the attachments and retry.`,
    );
  }
  return result.images;
}

type WorkerInitialMessagePlan =
  | { kind: "complete"; messages: WorkerTranscriptMessage[] }
  | {
      kind: "provider-replay-unavailable";
      details: WorkerProviderReplayUnavailable | WorkerReplayMessageWindowUnavailable;
    };

function buildWorkerAgentRuntimeIdentity(params: {
  admittedRunContext: AdmittedRunContext;
  agentId: string;
  sessionKey: string;
  turn: Pick<
    SessionPlacementTurnParams,
    | "agentAccountId"
    | "currentChannelId"
    | "currentMessagingTarget"
    | "currentThreadTs"
    | "messageChannel"
    | "messageProvider"
  >;
  turnClaim: WorkerSessionTurnClaim;
}): AgentRuntimeIdentityTokenParams {
  const { turn } = params;
  // Worker-local process keys isolate ephemeral state only. The signed caller
  // identity retains the host-owned session and route used by approvals.
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    operationalRunInstance: params.admittedRunContext.operationalRunInstance,
    executionIdentityToken: params.admittedRunContext.executionIdentityToken,
    turnSourceChannel: turn.messageChannel ?? turn.messageProvider,
    turnSourceTo: turn.currentMessagingTarget ?? turn.currentChannelId,
    turnSourceAccountId: turn.agentAccountId,
    turnSourceThreadId: turn.currentThreadTs,
    workerTurnClaim: params.turnClaim,
  };
}

type PrepareWorkerAgentRuntimeIdentityParams = Omit<
  Parameters<typeof buildWorkerAgentRuntimeIdentity>[0],
  "admittedRunContext" | "turn"
> & {
  runtimeInstanceId: string;
  turn: SessionPlacementTurnParams;
  placements: WorkerSessionPlacementStore;
};

export async function prepareWorkerAgentRuntimeIdentity(
  params: PrepareWorkerAgentRuntimeIdentityParams,
) {
  const admittedRunContext = await resolvePreparedRunAdmission({
    runId: params.turn.runId,
    runtimeKind: "worker",
    runtimeInstanceId: params.runtimeInstanceId,
    admittedRunContext: params.turn.admittedRunContext,
    preparedRunAdmission: params.turn.preparedRunAdmission,
  });
  const runtimeIdentity = buildWorkerAgentRuntimeIdentity({ ...params, admittedRunContext });
  // Worker session RPC carries no raw identity token. Bind provenance to the exact
  // host claim before launch so child lineage cannot become bearer authority.
  if (runtimeIdentity.executionIdentityToken) {
    bindWorkerTurnExecutionIdentity(
      params.placements,
      params.turnClaim,
      runtimeIdentity.executionIdentityToken,
      admittedRunContext.operationalRunInstance,
      { agentId: params.agentId, sessionKey: params.sessionKey },
    );
  }
  bindWorkerTurnAdmissionContinuation(
    params.placements,
    params.turnClaim,
    admittedRunContext.operationalRunInstance,
  );
  return {
    operationalRunInstance: admittedRunContext.operationalRunInstance,
    runtimeIdentity,
  };
}

export function emitProviderReplayRejected(
  config: SessionPlacementTurnParams["config"],
  details: { reason: string; bytes?: number; limitBytes?: number; count?: number },
): void {
  if (isDiagnosticsEnabled(config)) {
    emitTrustedDiagnosticEvent({
      type: "payload.large",
      surface: "worker.provider-replay",
      action: "rejected",
      ...details,
    });
  }
}

export function windowInitialMessages(messages: AgentMessage[]): WorkerInitialMessagePlan {
  const windowed = windowWorkerReplayMessages(messages, WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1);
  if (windowed.kind === "provider-replay-unavailable") {
    return windowed;
  }
  const projected: WorkerTranscriptMessage[] = [];
  for (const message of windowed.messages) {
    const result = toWorkerTranscriptMessage(message, "inference");
    if (!result) {
      continue;
    }
    if (result.kind === "provider-replay-unavailable") {
      return result;
    }
    projected.push(result.message);
  }
  return { kind: "complete", messages: projected };
}

// Node hosts append their own bounded websocket endpoint after sizing; reserve
// its 4 KiB URL, TLS pin, keys, and JSON escaping before admitting replay bytes.
const WORKER_LAUNCH_ENDPOINT_OVERHEAD_BYTES = 4_608;

type WorkerLaunchFit =
  | { kind: "launch"; plan: WorkerLaunchPlan }
  | {
      kind: "local-fallback";
      reason: "provider-replay-launch-payload-limit";
      bytes: number;
      limitBytes: number;
    };

/** Fits replay context before minting the exact worker-bound identity bearer. */
export async function fitLaunchDescriptorWithRuntimeIdentity(params: {
  build: (identityToken: string, messages: WorkerTranscriptMessage[]) => WorkerLaunchPlan;
  messages: WorkerTranscriptMessage[];
  runtimeIdentity: AgentRuntimeIdentityTokenParams;
}): Promise<WorkerLaunchFit> {
  const tokenBytes = measureAgentRuntimeIdentityTokenBytes(params.runtimeIdentity);
  const plan = fitLaunchDescriptor(
    (messages) => params.build("x".repeat(tokenBytes), messages),
    params.messages,
  );
  if (plan.kind !== "launch") {
    return plan;
  }
  const token = await mintAgentRuntimeIdentityToken(params.runtimeIdentity);
  if (Buffer.byteLength(token, "utf8") !== tokenBytes) {
    throw new Error("Agent runtime identity changed while preparing worker launch");
  }
  return {
    kind: "launch",
    plan: {
      ...plan.plan,
      assignment: { ...plan.plan.assignment, agentRuntimeIdentityToken: token },
    },
  };
}

function fitLaunchDescriptor(
  build: (initialMessages: WorkerTranscriptMessage[]) => WorkerLaunchPlan,
  messages: WorkerTranscriptMessage[],
): WorkerLaunchFit {
  let initialMessages = messages;
  while (true) {
    const plan = build(initialMessages);
    const bytes =
      Buffer.byteLength(JSON.stringify(plan), "utf8") + WORKER_LAUNCH_ENDPOINT_OVERHEAD_BYTES;
    if (bytes <= WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
      return { kind: "launch", plan };
    }
    const replayIndex = initialMessages.findLastIndex(
      (message) => message.role === "assistant" && message.providerReplay !== undefined,
    );
    if (replayIndex === 0) {
      return {
        kind: "local-fallback",
        reason: "provider-replay-launch-payload-limit",
        bytes,
        limitBytes: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
      };
    }
    const nextTurn = initialMessages.findIndex(
      (message, index) => index > 0 && message.role === "user",
    );
    // A replay owner is a valid context start because its checkpoint replaces
    // the discarded prefix; never advance past it to reach a later user turn.
    const nextStart =
      replayIndex > 0 && (nextTurn < 0 || nextTurn > replayIndex) ? replayIndex : nextTurn;
    if (nextStart < 0) {
      throw new Error("Worker turn context exceeds the launch descriptor payload limit");
    }
    initialMessages = initialMessages.slice(nextStart);
  }
}

type StartedWorkerRuntimeResult = Exclude<WorkerRuntimeResult, { status: "not-started" }>;

export function parseRuntimeResult(stdout: string): StartedWorkerRuntimeResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    throw new Error("Worker process returned invalid output", { cause: error });
  }
  const result = parseWorkerRuntimeResult(value);
  if (!result) {
    throw new Error("Worker process returned invalid output");
  }
  if (result.status === "not-started") {
    throw new Error(result.errorText);
  }
  return result;
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
    latestUsage: lastAssistant?.usage,
    lastRunPromptUsage,
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
