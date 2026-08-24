// Lobster plugin module implements lobster taskflow behavior.
import type { OpenClawPluginApi } from "../runtime-api.js";
import type { LobsterEnvelope, LobsterRunner, LobsterRunnerParams } from "./lobster-runner.js";

export type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

export type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["bindSession"]
>;

type FlowRecord = NonNullable<ReturnType<BoundTaskFlow["tryCreateManaged"]>>;
type MutationResult = ReturnType<BoundTaskFlow["setWaiting"]>;

type LobsterApprovalWaitState = {
  kind: "lobster_approval";
  prompt: string;
  items: JsonLike[];
  resumeToken?: string;
  approvalId?: string;
};

type RunManagedLobsterFlowParams = {
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams;
  controllerId: string;
  goal: string;
  stateJson?: JsonLike;
  currentStep?: string;
  waitingStep?: string;
};

type ResumeManagedLobsterFlowParams = {
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams & {
    action: "resume";
    approve: boolean;
  } & ({ token: string } | { approvalId: string });
  flowId: string;
  expectedRevision: number;
  currentStep?: string;
  waitingStep?: string;
};

export type ManagedLobsterFlowResult =
  | {
      ok: true;
      envelope: LobsterEnvelope;
      flow: FlowRecord;
      mutation: MutationResult;
    }
  | {
      ok: false;
      flow?: FlowRecord;
      mutation?: MutationResult;
      error: Error;
    };

function toJsonLike(value: unknown, seen = new WeakSet<object>()): JsonLike {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return null;
    case "object": {
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (Array.isArray(value)) {
        return value.map((item) => toJsonLike(item, seen));
      }
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      const jsonObject: Record<string, JsonLike> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          continue;
        }
        jsonObject[key] = toJsonLike(entry, seen);
      }
      seen.delete(value);
      return jsonObject;
    }
  }
  return null;
}

function buildApprovalWaitState(envelope: Extract<LobsterEnvelope, { ok: true }>): JsonLike {
  const approval = envelope.requiresApproval;
  return {
    kind: "lobster_approval",
    prompt: approval ? approval.prompt : "",
    items: approval ? approval.items.map((item) => toJsonLike(item)) : [],
    ...(approval?.resumeToken ? { resumeToken: approval.resumeToken } : {}),
    ...(approval?.approvalId ? { approvalId: approval.approvalId } : {}),
  } satisfies LobsterApprovalWaitState;
}

function applyEnvelopeToFlow(params: {
  taskFlow: BoundTaskFlow;
  flow: FlowRecord;
  envelope: LobsterEnvelope;
  waitingStep: string;
}): MutationResult {
  const { taskFlow, flow, envelope, waitingStep } = params;
  const flowMutation = { flowId: flow.flowId, expectedRevision: flow.revision };

  if (!envelope.ok) {
    return taskFlow.fail(flowMutation);
  }

  if (envelope.status === "needs_approval") {
    return taskFlow.setWaiting({
      ...flowMutation,
      currentStep: waitingStep,
      waitJson: buildApprovalWaitState(envelope),
    });
  }

  return taskFlow.finish(flowMutation);
}

async function executeManagedLobsterFlow(
  params: Pick<RunManagedLobsterFlowParams, "taskFlow" | "runner" | "runnerParams" | "waitingStep">,
  flow: FlowRecord,
  failureFlowId = flow.flowId,
): Promise<ManagedLobsterFlowResult> {
  try {
    const envelope = await params.runner.run(params.runnerParams);
    const mutation = applyEnvelopeToFlow({
      taskFlow: params.taskFlow,
      flow,
      envelope,
      waitingStep: params.waitingStep ?? "await_lobster_approval",
    });
    if (!envelope.ok) {
      return { ok: false, flow, mutation, error: new Error(envelope.error.message) };
    }
    return { ok: true, envelope, flow, mutation };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const mutation = params.taskFlow.fail({
        flowId: failureFlowId,
        expectedRevision: flow.revision,
      });
      return { ok: false, flow, mutation, error: err };
    } catch {
      return { ok: false, flow, error: err };
    }
  }
}

export async function runManagedLobsterFlow(
  params: RunManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const createFlowParams = {
    controllerId: params.controllerId,
    goal: params.goal,
    currentStep: params.currentStep ?? "run_lobster",
    ...(params.stateJson !== undefined ? { stateJson: params.stateJson } : {}),
  };
  const flow = params.taskFlow.tryCreateManaged
    ? params.taskFlow.tryCreateManaged(createFlowParams)
    : params.taskFlow.createManaged(createFlowParams);
  if (!flow) {
    return { ok: false, error: new Error("TaskFlow persistence failed.") };
  }
  return await executeManagedLobsterFlow(params, flow);
}

export async function resumeManagedLobsterFlow(
  params: ResumeManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const resumed = params.taskFlow.resume({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    status: "running",
    currentStep: params.currentStep ?? "resume_lobster",
  });

  if (!resumed.applied) {
    return {
      ok: false,
      mutation: resumed,
      error: new Error(`TaskFlow resume failed: ${resumed.code}`),
    };
  }
  return await executeManagedLobsterFlow(params, resumed.flow, params.flowId);
}
