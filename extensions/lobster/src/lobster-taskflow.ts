import type { OpenClawPluginApi } from "../runtime-api.js";
import type { LobsterEnvelope, LobsterRunner, LobsterRunnerParams } from "./lobster-runner.js";

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["bindSession"]
>;

type FlowRecord = ReturnType<BoundTaskFlow["createManaged"]>;
type MutationResult = ReturnType<BoundTaskFlow["setWaiting"]>;

export type LobsterApprovalWaitState = {
  kind: "lobster_approval";
  prompt: string;
  items: JsonLike[];
  resumeToken?: string;
  approvalId?: string;
};

export type RunManagedLobsterFlowParams = {
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams;
  controllerId: string;
  goal: string;
  stateJson?: JsonLike;
  currentStep?: string;
  waitingStep?: string;
};

export type ResumeManagedLobsterFlowParams = {
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
  if (!envelope.requiresApproval) {
    return {
      kind: "lobster_approval",
      prompt: "",
      items: [],
    } satisfies LobsterApprovalWaitState;
  }
  return {
    kind: "lobster_approval",
    prompt: envelope.requiresApproval.prompt,
    items: envelope.requiresApproval.items.map((item) => toJsonLike(item)),
    ...(envelope.requiresApproval.resumeToken
      ? { resumeToken: envelope.requiresApproval.resumeToken }
      : {}),
    ...(envelope.requiresApproval.approvalId
      ? { approvalId: envelope.requiresApproval.approvalId }
      : {}),
  } satisfies LobsterApprovalWaitState;
}

function applyEnvelopeToFlow(params: {
  taskFlow: BoundTaskFlow;
  flow: FlowRecord;
  envelope: LobsterEnvelope;
  waitingStep: string;
}): MutationResult {
  const { taskFlow, flow, envelope, waitingStep } = params;

  if (!envelope.ok) {
    return taskFlow.fail({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
    });
  }

  if (envelope.status === "needs_approval") {
    return taskFlow.setWaiting({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: waitingStep,
      waitJson: buildApprovalWaitState(envelope),
    });
  }

  return taskFlow.finish({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  });
}

function buildEnvelopeError(envelope: Extract<LobsterEnvelope, { ok: false }>) {
  return new Error(envelope.error.message);
}

export async function runManagedLobsterFlow(
  params: RunManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const flow = params.taskFlow.createManaged({
    controllerId: params.controllerId,
    goal: params.goal,
    currentStep: params.currentStep ?? "run_lobster",
    ...(params.stateJson !== undefined ? { stateJson: params.stateJson } : {}),
  });

  try {
    const envelope = await params.runner.run(params.runnerParams);
    const mutation = applyEnvelopeToFlow({
      taskFlow: params.taskFlow,
      flow,
      envelope,
      waitingStep: params.waitingStep ?? "await_lobster_approval",
    });
    if (!envelope.ok) {
      return {
        ok: false,
        flow,
        mutation,
        error: buildEnvelopeError(envelope),
      };
    }
    return {
      ok: true,
      envelope,
      flow,
      mutation,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const mutation = params.taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
      });
      return {
        ok: false,
        flow,
        mutation,
        error: err,
      };
    } catch {
      return {
        ok: false,
        flow,
        error: err,
      };
    }
  }
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

  try {
    const envelope = await params.runner.run(params.runnerParams);
    const mutation = applyEnvelopeToFlow({
      taskFlow: params.taskFlow,
      flow: resumed.flow,
      envelope,
      waitingStep: params.waitingStep ?? "await_lobster_approval",
    });
    if (!envelope.ok) {
      return {
        ok: false,
        flow: resumed.flow,
        mutation,
        error: buildEnvelopeError(envelope),
      };
    }
    return {
      ok: true,
      envelope,
      flow: resumed.flow,
      mutation,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const mutation = params.taskFlow.fail({
        flowId: params.flowId,
        expectedRevision: resumed.flow.revision,
      });
      return {
        ok: false,
        flow: resumed.flow,
        mutation,
        error: err,
      };
    } catch {
      return {
        ok: false,
        flow: resumed.flow,
        error: err,
      };
    }
  }
}
