// Lobster plugin module implements lobster tool behavior.
import {
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
} from "openclaw/plugin-sdk/channel-actions";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/param-readers";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";
import {
  type BoundTaskFlow,
  type JsonLike,
  type ManagedLobsterFlowResult,
  inspectManagedLobsterFlows,
  resumeManagedLobsterFlow,
  runManagedLobsterFlow,
} from "./lobster-taskflow.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 512_000;

function parseResponseJson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("responseJson must be a JSON string of at most 64 KiB");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("responseJson must be valid JSON");
  }
}

type LobsterToolOptions = {
  runner?: LobsterRunner;
  taskFlow?: BoundTaskFlow;
};

function readOptionalTrimmedString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalNumber(value: unknown, fieldName: string): number | undefined {
  return readNonNegativeIntegerParam({ [fieldName]: value }, fieldName, {
    message: `${fieldName} must be a non-negative integer`,
  });
}

function readOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function parseOptionalFlowStateJson(value: unknown): JsonLike | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("flowStateJson must be a JSON string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as JsonLike;
  } catch {
    throw new Error("flowStateJson must be valid JSON");
  }
}

function isEmptyJsonObject(value: JsonLike | undefined): boolean {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function parseManagedFlowParams(
  action: "run" | "resume",
  params: Record<string, unknown>,
  runnerParams: LobsterRunnerParams,
) {
  if (action === "run") {
    const controllerId = readOptionalTrimmedString(params.flowControllerId, "flowControllerId");
    const goal = readOptionalTrimmedString(params.flowGoal, "flowGoal");
    const currentStep = readOptionalTrimmedString(params.flowCurrentStep, "flowCurrentStep");
    const waitingStep = readOptionalTrimmedString(params.flowWaitingStep, "flowWaitingStep");
    const stateJson = parseOptionalFlowStateJson(params.flowStateJson);
    const resumeFlowId = readOptionalTrimmedString(params.flowId, "flowId");
    const resumeRevision = readOptionalNumber(params.flowExpectedRevision, "flowExpectedRevision");
    const stateJsonSignalsRunMode = stateJson !== undefined && !isEmptyJsonObject(stateJson);

    if (resumeFlowId !== undefined || (resumeRevision !== undefined && resumeRevision !== 0)) {
      throw new Error("run action does not accept flowId or flowExpectedRevision");
    }
    if (
      controllerId === undefined &&
      goal === undefined &&
      currentStep === undefined &&
      waitingStep === undefined &&
      !stateJsonSignalsRunMode
    ) {
      return null;
    }
    if (!controllerId) {
      throw new Error("flowControllerId required when using managed TaskFlow run mode");
    }
    if (!goal) {
      throw new Error("flowGoal required when using managed TaskFlow run mode");
    }
    return {
      action,
      controllerId,
      goal,
      ...(currentStep ? { currentStep } : {}),
      ...(waitingStep ? { waitingStep } : {}),
      ...(stateJson !== undefined ? { stateJson } : {}),
    };
  }

  const flowId = readOptionalTrimmedString(params.flowId, "flowId");
  const expectedRevision = readOptionalNumber(params.flowExpectedRevision, "flowExpectedRevision");
  const currentStep = readOptionalTrimmedString(params.flowCurrentStep, "flowCurrentStep");
  const waitingStep = readOptionalTrimmedString(params.flowWaitingStep, "flowWaitingStep");
  // Credential validation stays resume-only and before fallback; run intentionally ignores these fields.
  readOptionalTrimmedString(params.token, "token");
  readOptionalTrimmedString(params.approvalId, "approvalId");
  const approve = readOptionalBoolean(params.approve, "approve");
  const runControllerId = readOptionalTrimmedString(params.flowControllerId, "flowControllerId");
  const runGoal = readOptionalTrimmedString(params.flowGoal, "flowGoal");
  const stateJson = parseOptionalFlowStateJson(params.flowStateJson);
  const stateJsonDisallowed = stateJson !== undefined && !isEmptyJsonObject(stateJson);

  if (runControllerId !== undefined || runGoal !== undefined || stateJsonDisallowed) {
    throw new Error("resume action does not accept flowControllerId, flowGoal, or flowStateJson");
  }

  const hasResumeFields =
    flowId !== undefined ||
    (expectedRevision !== undefined && expectedRevision !== 0) ||
    currentStep !== undefined ||
    waitingStep !== undefined;

  if (!hasResumeFields) {
    return null;
  }
  if (!flowId) {
    throw new Error("flowId required when using managed TaskFlow resume mode");
  }
  if (expectedRevision === undefined) {
    throw new Error("flowExpectedRevision required when using managed TaskFlow resume mode");
  }
  if (
    approve === undefined &&
    runnerParams.response === undefined &&
    runnerParams.cancel !== true
  ) {
    throw new Error(
      "approve, responseJson, or cancel:true required when using managed TaskFlow resume mode",
    );
  }
  return {
    action,
    flowId,
    expectedRevision,
    ...(currentStep ? { currentStep } : {}),
    ...(waitingStep ? { waitingStep } : {}),
    runnerParams: {
      ...runnerParams,
      action,
    } satisfies Parameters<typeof resumeManagedLobsterFlow>[0]["runnerParams"],
  };
}

function resolveManagedFlowToolResult(result: ManagedLobsterFlowResult, maxStdoutBytes: number) {
  const payload = result.ok
    ? { ...result.envelope, flow: result.flow, mutation: result.mutation }
    : {
        ok: false,
        error: { message: result.error.message },
        ...(result.flow ? { flow: result.flow } : {}),
        ...(result.mutation ? { mutation: result.mutation } : {}),
      };
  if (
    Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") > Math.max(1024, maxStdoutBytes)
  ) {
    return {
      ...jsonResult({
        ok: false,
        error: {
          message:
            "TaskFlow result exceeds maxStdoutBytes. Use status with the flowId and a larger maxStdoutBytes to inspect the saved state; do not replay the workflow.",
        },
        ...(result.flow
          ? {
              flow: {
                flowId: result.flow.flowId,
                revision: result.flow.revision,
                status: result.flow.status,
              },
            }
          : {}),
      }),
      isError: true,
    };
  }
  return { ...jsonResult(payload), ...(!result.ok ? { isError: true } : {}) };
}

function requireTaskFlowRuntime(
  taskFlow: BoundTaskFlow | undefined,
  action: "run" | "resume" | "status",
) {
  if (!taskFlow) {
    throw new Error(`Managed TaskFlow ${action} mode requires a bound taskFlow runtime`);
  }
  return taskFlow;
}

export function createLobsterTool(api: OpenClawPluginApi, options?: LobsterToolOptions) {
  const runner = options?.runner ?? createEmbeddedLobsterRunner();
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description:
      "Run deterministic workflows with approvals. For durable input, run with flowControllerId and flowGoal. Use status to rediscover this session's pending flows; status with flowId reads the saved question and revision. Resume with flowId, flowExpectedRevision and responseJson (input), approve (approval), or cancel:true. Managed resume uses the saved checkpoint; no token copy is needed. Never invent a user's answer.",
    parameters: Type.Object({
      action: Type.Enum(["run", "resume", "status"], { type: "string" }),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
      responseJson: Type.Optional(Type.String({ maxLength: MAX_RESPONSE_BYTES })),
      cancel: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative working directory (optional). Must stay within the gateway working directory.",
        }),
      ),
      timeoutMs: optionalPositiveIntegerSchema(),
      maxStdoutBytes: optionalPositiveIntegerSchema(),
      flowControllerId: Type.Optional(Type.String()),
      flowGoal: Type.Optional(Type.String()),
      flowStateJson: Type.Optional(Type.String()),
      flowId: Type.Optional(Type.String()),
      flowExpectedRevision: optionalNonNegativeIntegerSchema(),
      flowCurrentStep: Type.Optional(Type.String()),
      flowWaitingStep: Type.Optional(Type.String()),
      flowOffset: optionalNonNegativeIntegerSchema(),
    }),
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new Error("action required");
      }
      if (action !== "run" && action !== "resume" && action !== "status") {
        throw new Error(`Unknown action: ${action}`);
      }

      const taskFlow = options?.taskFlow;
      const maxStdoutBytes =
        readPositiveIntegerParam(params, "maxStdoutBytes") ?? DEFAULT_MAX_STDOUT_BYTES;
      if (action === "status") {
        const result = inspectManagedLobsterFlows(
          requireTaskFlowRuntime(taskFlow, action),
          readOptionalTrimmedString(params.flowId, "flowId"),
          readOptionalNumber(params.flowOffset, "flowOffset") ?? 0,
        );
        if (Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > maxStdoutBytes) {
          throw new Error(
            "TaskFlow detail exceeds maxStdoutBytes; retry status with a larger maxStdoutBytes",
          );
        }
        return jsonResult(result);
      }
      const response = parseResponseJson(params.responseJson);
      const cancel = readOptionalBoolean(params.cancel, "cancel");
      if (action === "run" && (response !== undefined || cancel === true)) {
        throw new Error("responseJson and cancel are resume-only fields");
      }

      const cwd = resolveLobsterCwd(params.cwd);
      const timeoutMs = readPositiveIntegerParam(params, "timeoutMs") ?? 20_000;

      if (api.runtime?.version && api.logger?.debug) {
        api.logger.debug(`lobster plugin runtime=${api.runtime.version}`);
      }

      const runnerParams: LobsterRunnerParams = {
        action,
        ...(signal ? { signal } : {}),
        ...(typeof params.pipeline === "string" ? { pipeline: params.pipeline } : {}),
        ...(typeof params.argsJson === "string" ? { argsJson: params.argsJson } : {}),
        ...(typeof params.token === "string" ? { token: params.token } : {}),
        ...(typeof params.approvalId === "string" ? { approvalId: params.approvalId } : {}),
        ...(typeof params.approve === "boolean" ? { approve: params.approve } : {}),
        ...(response !== undefined ? { response } : {}),
        ...(cancel === true ? { cancel: true } : {}),
        cwd,
        timeoutMs,
        maxStdoutBytes,
      };

      const flowParams = parseManagedFlowParams(action, params, runnerParams);
      if (flowParams?.action === "run") {
        return resolveManagedFlowToolResult(
          await runManagedLobsterFlow({
            taskFlow: requireTaskFlowRuntime(taskFlow, "run"),
            config: api.config,
            runner,
            runnerParams,
            controllerId: flowParams.controllerId,
            goal: flowParams.goal,
            ...(flowParams.stateJson !== undefined ? { stateJson: flowParams.stateJson } : {}),
            ...(flowParams.currentStep ? { currentStep: flowParams.currentStep } : {}),
            ...(flowParams.waitingStep ? { waitingStep: flowParams.waitingStep } : {}),
          }),
          maxStdoutBytes,
        );
      }
      if (flowParams?.action === "resume") {
        return resolveManagedFlowToolResult(
          await resumeManagedLobsterFlow({
            taskFlow: requireTaskFlowRuntime(taskFlow, "resume"),
            config: api.config,
            runner,
            runnerParams: flowParams.runnerParams,
            flowId: flowParams.flowId,
            expectedRevision: flowParams.expectedRevision,
            ...(flowParams.currentStep ? { currentStep: flowParams.currentStep } : {}),
            ...(flowParams.waitingStep ? { waitingStep: flowParams.waitingStep } : {}),
          }),
          maxStdoutBytes,
        );
      }

      if (response !== undefined || cancel === true) {
        throw new Error(
          "Structured input and cancellation require managed TaskFlow mode with flowId and flowExpectedRevision",
        );
      }
      const envelope = await runner.run(runnerParams);
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      if (
        Buffer.byteLength(JSON.stringify(envelope, null, 2), "utf8") >
        Math.max(1024, maxStdoutBytes)
      ) {
        throw new Error("lobster runtime result exceeded maxStdoutBytes");
      }
      if (envelope.status === "needs_input") {
        throw new Error(
          "Structured input requires managed TaskFlow mode; run with flowControllerId and flowGoal",
        );
      }
      return jsonResult(envelope);
    },
  };
}
