import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";
import {
  type ManagedLobsterFlowResult,
  resumeManagedLobsterFlow,
  runManagedLobsterFlow,
} from "./lobster-taskflow.js";

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["taskFlow"]["bindSession"]
>;

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

type LobsterToolOptions = {
  runner?: LobsterRunner;
  taskFlow?: BoundTaskFlow;
};

type ManagedFlowRunParams = {
  controllerId: string;
  goal: string;
  currentStep?: string;
  waitingStep?: string;
  stateJson?: JsonLike;
};

type ManagedFlowResumeParams = {
  flowId: string;
  expectedRevision: number;
  currentStep?: string;
  waitingStep?: string;
};

type ManagedFlowSuccessResult = {
  ok: true;
  envelope: unknown;
  flow: unknown;
  mutation: unknown;
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
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return value;
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
  try {
    return JSON.parse(value) as JsonLike;
  } catch {
    throw new Error("flowStateJson must be valid JSON");
  }
}

function parseRunFlowParams(params: Record<string, unknown>): ManagedFlowRunParams | null {
  const controllerId = readOptionalTrimmedString(params.flowControllerId, "flowControllerId");
  const goal = readOptionalTrimmedString(params.flowGoal, "flowGoal");
  const currentStep = readOptionalTrimmedString(params.flowCurrentStep, "flowCurrentStep");
  const waitingStep = readOptionalTrimmedString(params.flowWaitingStep, "flowWaitingStep");
  const stateJson = parseOptionalFlowStateJson(params.flowStateJson);
  const resumeFlowId = readOptionalTrimmedString(params.flowId, "flowId");
  const resumeRevision = readOptionalNumber(params.flowExpectedRevision, "flowExpectedRevision");

  const hasRunFields =
    controllerId !== undefined ||
    goal !== undefined ||
    currentStep !== undefined ||
    waitingStep !== undefined ||
    stateJson !== undefined;

  if (!hasRunFields) {
    return null;
  }
  if (resumeFlowId !== undefined || resumeRevision !== undefined) {
    throw new Error("run action does not accept flowId or flowExpectedRevision");
  }
  if (!controllerId) {
    throw new Error("flowControllerId required when using managed TaskFlow run mode");
  }
  if (!goal) {
    throw new Error("flowGoal required when using managed TaskFlow run mode");
  }
  return {
    controllerId,
    goal,
    ...(currentStep ? { currentStep } : {}),
    ...(waitingStep ? { waitingStep } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
  };
}

function parseResumeFlowParams(params: Record<string, unknown>): ManagedFlowResumeParams | null {
  const flowId = readOptionalTrimmedString(params.flowId, "flowId");
  const expectedRevision = readOptionalNumber(params.flowExpectedRevision, "flowExpectedRevision");
  const currentStep = readOptionalTrimmedString(params.flowCurrentStep, "flowCurrentStep");
  const waitingStep = readOptionalTrimmedString(params.flowWaitingStep, "flowWaitingStep");
  const token = readOptionalTrimmedString(params.token, "token");
  const approvalId = readOptionalTrimmedString(params.approvalId, "approvalId");
  const approve = readOptionalBoolean(params.approve, "approve");
  const runControllerId = readOptionalTrimmedString(params.flowControllerId, "flowControllerId");
  const runGoal = readOptionalTrimmedString(params.flowGoal, "flowGoal");
  const stateJson = params.flowStateJson;

  const hasResumeFields =
    flowId !== undefined ||
    expectedRevision !== undefined ||
    currentStep !== undefined ||
    waitingStep !== undefined;

  if (!hasResumeFields) {
    return null;
  }
  if (runControllerId !== undefined || runGoal !== undefined || stateJson !== undefined) {
    throw new Error("resume action does not accept flowControllerId, flowGoal, or flowStateJson");
  }
  if (!flowId) {
    throw new Error("flowId required when using managed TaskFlow resume mode");
  }
  if (expectedRevision === undefined) {
    throw new Error("flowExpectedRevision required when using managed TaskFlow resume mode");
  }
  if (!token && !approvalId) {
    throw new Error("token or approvalId required when using managed TaskFlow resume mode");
  }
  if (approve === undefined) {
    throw new Error("approve required when using managed TaskFlow resume mode");
  }
  return {
    flowId,
    expectedRevision,
    ...(currentStep ? { currentStep } : {}),
    ...(waitingStep ? { waitingStep } : {}),
  };
}

function formatManagedFlowResult(result: ManagedFlowSuccessResult) {
  const envelope =
    result.envelope && typeof result.envelope === "object" && !Array.isArray(result.envelope)
      ? result.envelope
      : { envelope: result.envelope };
  const details = {
    ...envelope,
    flow: result.flow,
    mutation: result.mutation,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function requireTaskFlowRuntime(taskFlow: BoundTaskFlow | undefined, action: "run" | "resume") {
  if (!taskFlow) {
    throw new Error(`Managed TaskFlow ${action} mode requires a bound taskFlow runtime`);
  }
  return taskFlow;
}

function resolveManagedFlowToolResult(result: ManagedLobsterFlowResult) {
  if (!result.ok) {
    throw result.error;
  }
  return formatManagedFlowResult(result);
}

export function createLobsterTool(api: OpenClawPluginApi, options?: LobsterToolOptions) {
  const runner = options?.runner ?? createEmbeddedLobsterRunner();
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description:
      "Run Lobster pipelines as a local-first workflow runtime (typed JSON envelope + resumable approvals).",
    parameters: Type.Object({
      // NOTE: Prefer string enums in tool schemas; some providers reject unions/anyOf.
      action: Type.Unsafe<"run" | "resume">({ type: "string", enum: ["run", "resume"] }),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative working directory (optional). Must stay within the gateway working directory.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Number()),
      maxStdoutBytes: Type.Optional(Type.Number()),
      flowControllerId: Type.Optional(Type.String()),
      flowGoal: Type.Optional(Type.String()),
      flowStateJson: Type.Optional(Type.String()),
      flowId: Type.Optional(Type.String()),
      flowExpectedRevision: Type.Optional(Type.Number()),
      flowCurrentStep: Type.Optional(Type.String()),
      flowWaitingStep: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new Error("action required");
      }
      if (action !== "run" && action !== "resume") {
        throw new Error(`Unknown action: ${action}`);
      }

      const cwd = resolveLobsterCwd(params.cwd);
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 20_000;
      const maxStdoutBytes =
        typeof params.maxStdoutBytes === "number" ? params.maxStdoutBytes : 512_000;

      if (api.runtime?.version && api.logger?.debug) {
        api.logger.debug(`lobster plugin runtime=${api.runtime.version}`);
      }

      const runnerParams: LobsterRunnerParams = {
        action,
        ...(typeof params.pipeline === "string" ? { pipeline: params.pipeline } : {}),
        ...(typeof params.argsJson === "string" ? { argsJson: params.argsJson } : {}),
        ...(typeof params.token === "string" ? { token: params.token } : {}),
        ...(typeof params.approvalId === "string" ? { approvalId: params.approvalId } : {}),
        ...(typeof params.approve === "boolean" ? { approve: params.approve } : {}),
        cwd,
        timeoutMs,
        maxStdoutBytes,
      };

      const taskFlow = options?.taskFlow;
      if (action === "run") {
        const flowParams = parseRunFlowParams(params);
        if (flowParams) {
          return resolveManagedFlowToolResult(
            await runManagedLobsterFlow({
              taskFlow: requireTaskFlowRuntime(taskFlow, "run"),
              runner,
              runnerParams,
              controllerId: flowParams.controllerId,
              goal: flowParams.goal,
              ...(flowParams.stateJson !== undefined ? { stateJson: flowParams.stateJson } : {}),
              ...(flowParams.currentStep ? { currentStep: flowParams.currentStep } : {}),
              ...(flowParams.waitingStep ? { waitingStep: flowParams.waitingStep } : {}),
            }),
          );
        }
      } else {
        const flowParams = parseResumeFlowParams(params);
        if (flowParams) {
          return resolveManagedFlowToolResult(
            await resumeManagedLobsterFlow({
              taskFlow: requireTaskFlowRuntime(taskFlow, "resume"),
              runner,
              runnerParams: runnerParams as LobsterRunnerParams & {
                action: "resume";
                approve: boolean;
              } & ({ token: string } | { approvalId: string }),
              flowId: flowParams.flowId,
              expectedRevision: flowParams.expectedRevision,
              ...(flowParams.currentStep ? { currentStep: flowParams.currentStep } : {}),
              ...(flowParams.waitingStep ? { waitingStep: flowParams.waitingStep } : {}),
            }),
          );
        }
      }

      const envelope = await runner.run(runnerParams);
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
        details: envelope,
      };
    },
  };
}
