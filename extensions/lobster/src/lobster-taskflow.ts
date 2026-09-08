// Lobster plugin module implements lobster taskflow behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  LobsterRunnerError,
  type LobsterEnvelope,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

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

type FlowRecord = NonNullable<ReturnType<BoundTaskFlow["get"]>>;
type MutationResult =
  | ReturnType<BoundTaskFlow["setWaiting"]>
  | Awaited<ReturnType<BoundTaskFlow["cancel"]>>;

type LobsterApprovalWaitState = {
  kind: "lobster_approval";
  prompt: string;
  items: JsonLike[];
  resumeToken?: string;
  approvalId?: string;
  cwd?: string;
};

type LobsterInputWaitState = {
  kind: "lobster_input";
  prompt: string;
  responseSchema: JsonLike;
  defaults?: JsonLike;
  subject?: JsonLike;
  resumeToken: string;
  cwd: string;
};

type LobsterWaitState = LobsterApprovalWaitState | LobsterInputWaitState;

type RunManagedLobsterFlowParams = {
  taskFlow: BoundTaskFlow;
  config: OpenClawPluginApi["config"];
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
  config: OpenClawPluginApi["config"];
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams & {
    action: "resume";
  };
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
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const jsonArray = value.map((item) => toJsonLike(item, seen));
    seen.delete(value);
    return jsonArray;
  }
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

function buildWaitState(
  envelope: Extract<LobsterEnvelope, { ok: true }>,
  cwd: string,
): LobsterWaitState {
  if (envelope.status === "needs_input") {
    const input = envelope.requiresInput;
    if (!input?.resumeToken || input.responseSchema === undefined) {
      throw new Error("Lobster returned an incomplete input checkpoint");
    }
    return {
      kind: "lobster_input",
      prompt: input.prompt,
      // The dependency owns these JSON values. Preserve schema keys verbatim,
      // including own properties such as __proto__, rather than coercing them.
      // SAFETY: the pinned runtime supplies a JSON schema; cloning preserves its own keys.
      responseSchema: structuredClone(input.responseSchema) as JsonLike,
      ...(input.defaults !== undefined
        ? {
            // SAFETY: the pinned runtime's input defaults are JSON checkpoint data.
            defaults: structuredClone(input.defaults) as JsonLike,
          }
        : {}),
      ...(input.subject !== undefined
        ? {
            // SAFETY: the pinned runtime's input subject is JSON checkpoint data.
            subject: structuredClone(input.subject) as JsonLike,
          }
        : {}),
      resumeToken: input.resumeToken,
      cwd,
    };
  }
  const approval = envelope.requiresApproval;
  return {
    kind: "lobster_approval",
    prompt: approval ? approval.prompt : "",
    items: approval ? approval.items.map((item) => toJsonLike(item)) : [],
    ...(approval?.resumeToken ? { resumeToken: approval.resumeToken } : {}),
    ...(approval?.approvalId ? { approvalId: approval.approvalId } : {}),
    cwd,
  } satisfies LobsterApprovalWaitState;
}

function readWaitState(value: JsonLike | undefined): LobsterWaitState | undefined {
  if (!isRecord(value) || typeof value.prompt !== "string") {
    return undefined;
  }
  if (
    value.kind === "lobster_input" &&
    value.responseSchema !== undefined &&
    typeof value.resumeToken === "string" &&
    value.resumeToken.length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0
  ) {
    // SAFETY: required input fields are checked above; remaining values are already JsonLike.
    return value as LobsterInputWaitState;
  }
  if (
    value.kind === "lobster_approval" &&
    Array.isArray(value.items) &&
    (value.resumeToken === undefined || typeof value.resumeToken === "string") &&
    (value.approvalId === undefined || typeof value.approvalId === "string") &&
    (Boolean(value.resumeToken) || Boolean(value.approvalId)) &&
    (value.cwd === undefined || typeof value.cwd === "string")
  ) {
    // SAFETY: required approval fields are checked above; remaining values are already JsonLike.
    return value as LobsterApprovalWaitState;
  }
  return undefined;
}

/** Read through the existing owner-bound runtime; flow ids do not grant access. */
export function inspectManagedLobsterFlows(taskFlow: BoundTaskFlow, flowId?: string, offset = 0) {
  if (flowId) {
    const flow = taskFlow.get(flowId);
    if (!flow || flow.syncMode !== "managed") {
      throw new Error("Managed TaskFlow not found in this session");
    }
    // Arbitrary caller state is not needed to answer a saved question and can
    // dwarf it. Keep the checkpoint and its current revision discoverable.
    return {
      ok: true,
      flow: {
        flowId: flow.flowId,
        revision: flow.revision,
        status: flow.status,
        goal: flow.goal,
        currentStep: flow.currentStep,
        waitJson: flow.waitJson,
        cancelRequestedAt: flow.cancelRequestedAt,
        endedAt: flow.endedAt,
      },
    };
  }
  const pending = taskFlow
    .list()
    .filter(
      (flow) =>
        flow.syncMode === "managed" &&
        flow.status === "waiting" &&
        flow.cancelRequestedAt == null &&
        readWaitState(flow.waitJson),
    )
    .toSorted((a, b) => a.createdAt - b.createdAt || a.flowId.localeCompare(b.flowId));
  const flows = pending.slice(offset, offset + 20).map((flow) => ({
    flowId: flow.flowId,
    revision: flow.revision,
    status: flow.status,
    goal: flow.goal.slice(0, 200),
    currentStep: flow.currentStep?.slice(0, 200),
  }));
  return {
    ok: true,
    flows,
    ...(offset + flows.length < pending.length ? { nextOffset: offset + flows.length } : {}),
  };
}

function assertFlowClaim(taskFlow: BoundTaskFlow, flow: FlowRecord): void {
  const current = taskFlow.get(flow.flowId);
  if (
    !current ||
    current.revision !== flow.revision ||
    current.status !== flow.status ||
    current.cancelRequestedAt != null ||
    current.endedAt != null
  ) {
    throw new Error("TaskFlow execution claim is no longer active; inspect its current status");
  }
}

async function executeManagedLobsterFlow(
  params: Pick<
    RunManagedLobsterFlowParams,
    "taskFlow" | "config" | "runner" | "runnerParams" | "waitingStep"
  >,
  flow: FlowRecord,
  previousWait?: { wait: LobsterWaitState; currentStep?: string },
): Promise<ManagedLobsterFlowResult> {
  try {
    assertFlowClaim(params.taskFlow, flow);
    const envelope = await params.runner.run({
      ...params.runnerParams,
      beforeExecute: () => assertFlowClaim(params.taskFlow, flow),
    });
    assertFlowClaim(params.taskFlow, flow);
    if (envelope.ok && envelope.status === "cancelled") {
      try {
        const mutation = await params.taskFlow.cancel({ flowId: flow.flowId, cfg: params.config });
        return mutation.cancelled
          ? { ok: true, envelope, flow: { ...flow, ...mutation.flow }, mutation }
          : {
              ok: false,
              flow,
              mutation,
              error: new Error(`TaskFlow cancellation failed: ${mutation.reason ?? "unknown"}`),
            };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { ok: false, flow, error: err };
      }
    }
    const flowMutation = { flowId: flow.flowId, expectedRevision: flow.revision };
    if (!envelope.ok) {
      throw new LobsterRunnerError(envelope.error.message, envelope.error.type);
    }
    const mutation =
      envelope.status === "needs_approval" || envelope.status === "needs_input"
        ? params.taskFlow.setWaiting({
            ...flowMutation,
            currentStep:
              params.waitingStep ??
              (envelope.status === "needs_input"
                ? "await_lobster_input"
                : "await_lobster_approval"),
            waitJson: buildWaitState(envelope, params.runnerParams.cwd),
          })
        : params.taskFlow.finish(flowMutation);
    return mutation.applied
      ? { ok: true, envelope, flow: mutation.flow, mutation }
      : {
          ok: false,
          flow,
          mutation,
          error: new Error(
            `TaskFlow result could not be persisted: ${mutation.code}; do not replay the workflow`,
          ),
        };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const current = params.taskFlow.get(flow.flowId);
      if (
        current?.syncMode === "managed" &&
        current.controllerId === flow.controllerId &&
        current.status === "running" &&
        current.endedAt == null &&
        current.cancelRequestedAt != null &&
        current.revision === flow.revision + 1
      ) {
        // A cancellation-only successor invalidated this claim. Settle that
        // request now; never use an old runner to cancel a newer claim.
        const mutation = await params.taskFlow.cancel({ flowId: flow.flowId, cfg: params.config });
        return { ok: false, flow: mutation.flow ?? current, mutation, error: err };
      }
      // Only dependency parse_error proves downstream execution never started.
      // Runtime errors/timeouts may follow side effects and must not reopen the checkpoint.
      assertFlowClaim(params.taskFlow, flow);
      const flowMutation = {
        flowId: flow.flowId,
        expectedRevision: flow.revision,
      };
      const mutation =
        previousWait && err instanceof LobsterRunnerError && err.type === "parse_error"
          ? params.taskFlow.setWaiting({
              ...flowMutation,
              currentStep: previousWait.currentStep,
              waitJson: previousWait.wait,
            })
          : params.taskFlow.fail(flowMutation);
      return { ok: false, flow: mutation.applied ? mutation.flow : flow, mutation, error: err };
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
    status: "running" as const,
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
  const flow = params.taskFlow.get(params.flowId);
  const wait = flow?.syncMode === "managed" ? readWaitState(flow.waitJson) : undefined;
  if (
    !flow ||
    !wait ||
    flow.status !== "waiting" ||
    flow.endedAt != null ||
    flow.cancelRequestedAt != null
  ) {
    return {
      ok: false,
      error: new Error("No pending Lobster checkpoint in this session; inspect the flow status"),
    };
  }
  const supplied = params.runnerParams;
  if (
    (supplied.token && supplied.token.trim() !== wait.resumeToken) ||
    (supplied.approvalId &&
      (wait.kind !== "lobster_approval" || supplied.approvalId.trim() !== wait.approvalId))
  ) {
    return {
      ok: false,
      error: new Error("Resume credential does not match the saved TaskFlow checkpoint"),
    };
  }
  const decisions =
    Number(supplied.response !== undefined) +
    Number(supplied.approve !== undefined) +
    Number(supplied.cancel === true);
  if (
    decisions !== 1 ||
    (supplied.cancel !== true &&
      (wait.kind === "lobster_input"
        ? supplied.response === undefined
        : supplied.approve === undefined))
  ) {
    return {
      ok: false,
      error: new Error(
        wait.kind === "lobster_input"
          ? "Input checkpoint requires responseJson or cancel:true, not approve"
          : "Approval checkpoint requires approve or cancel:true, not responseJson",
      ),
    };
  }
  const credential = wait.resumeToken
    ? { token: wait.resumeToken }
    : wait.kind === "lobster_approval"
      ? { approvalId: wait.approvalId }
      : {};
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
  return await executeManagedLobsterFlow(
    {
      ...params,
      runnerParams: {
        action: "resume",
        ...(supplied.signal ? { signal: supplied.signal } : {}),
        ...credential,
        ...(supplied.approve !== undefined ? { approve: supplied.approve } : {}),
        ...(supplied.response !== undefined ? { response: supplied.response } : {}),
        ...(supplied.cancel === true ? { cancel: true } : {}),
        cwd: wait.cwd ?? supplied.cwd,
        timeoutMs: supplied.timeoutMs,
        maxStdoutBytes: supplied.maxStdoutBytes,
      },
    },
    resumed.flow,
    { wait, currentStep: flow.currentStep },
  );
}
