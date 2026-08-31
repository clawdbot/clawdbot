import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { loadPendingSessionDelivery } from "../../../infra/session-delivery-queue-storage.js";
import { decodeDelegateFlow, delegateFlowRecords } from "../delegate-flow-store.js";
import { returnCovenantAuthorityFromDelegate } from "./case-dispatch.js";
import {
  returnCovenantExecutionKey,
  type ReturnCovenantCaseState,
  type ReturnCovenantFixtureContext,
} from "./case-state.js";
import type { ReturnCovenantDatabaseProfilesSnapshot } from "./database.js";
import {
  parseReturnCovenantGatewayBinding,
  returnCovenantGatewayBindingsEqual,
} from "./gateway-generation.js";
import { parseReturnCovenantPhaseRequest, type ReturnCovenantPlan } from "./protocol.js";

export const RETURN_COVENANT_RUN_SNAPSHOT_SCHEMA = "openclaw.k6.return-covenant-run-snapshot.v1";

export type CompletedReturnCovenantCase = {
  caseHandle: string;
  observation: Record<string, unknown>;
};

export type ReturnCovenantFixtureRunSnapshot = {
  schema: typeof RETURN_COVENANT_RUN_SNAPSHOT_SCHEMA;
  runId: string;
  activeState: ReturnCovenantCaseState | null;
  caseHandles: string[];
  closedCaseHandles: string[];
  completed: Array<[string, CompletedReturnCovenantCase]>;
  profiles: ReturnCovenantDatabaseProfilesSnapshot;
};

const runSnapshotSchema = z
  .object({
    schema: z.literal(RETURN_COVENANT_RUN_SNAPSHOT_SCHEMA),
    runId: z.string().min(1),
    activeState: z
      .custom<ReturnCovenantCaseState>((value) => value === null || isRecord(value))
      .nullable(),
    caseHandles: z.array(z.string().min(1)),
    closedCaseHandles: z.array(z.string().min(1)),
    completed: z.array(
      z.tuple([
        z.string().min(1),
        z.custom<CompletedReturnCovenantCase>(
          (value) =>
            isRecord(value) && typeof value.caseHandle === "string" && isRecord(value.observation),
        ),
      ]),
    ),
    profiles: z.object({ activeExecutionKey: z.string().min(1).nullable() }).strict(),
  })
  .strict();

export function parseReturnCovenantRunSnapshot(value: unknown): ReturnCovenantFixtureRunSnapshot {
  return runSnapshotSchema.parse(value);
}

function stateDirectory(context: ReturnCovenantFixtureContext): string {
  const stateDir = context.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("return-covenant fixture lost its isolated state directory");
  }
  return stateDir;
}

export async function restoreReturnCovenantActiveState(params: {
  context: ReturnCovenantFixtureContext;
  plan: ReturnCovenantPlan;
  snapshot: ReturnCovenantCaseState;
}): Promise<ReturnCovenantCaseState> {
  const { context, plan, snapshot } = params;
  const request = parseReturnCovenantPhaseRequest(snapshot.request);
  if (
    request.phase !== "prepare" ||
    snapshot.closed ||
    snapshot.phase !== "dispatched" ||
    snapshot.casePlan.restartBetweenAcceptanceAndRelease !== true ||
    request.caseId !== snapshot.casePlan.id ||
    request.form !== snapshot.form
  ) {
    throw new Error("return-covenant active restart snapshot is malformed");
  }
  const casePlan = plan.cases.find((entry) => entry.id === request.caseId);
  if (!casePlan || casePlan.restartBetweenAcceptanceAndRelease !== true) {
    throw new Error("return-covenant active restart case is not in the frozen plan");
  }
  const prepareGateway = parseReturnCovenantGatewayBinding(snapshot.gatewayPhases.prepare);
  const dispatchGateway = parseReturnCovenantGatewayBinding(snapshot.gatewayPhases.dispatch);
  if (!returnCovenantGatewayBindingsEqual(prepareGateway, dispatchGateway)) {
    throw new Error("return-covenant active restart snapshot changed pre-restart generation");
  }
  context.profiles.assertActive(request.caseId, request.form);
  const database = context.profiles.receiptFor({
    caseHandle: snapshot.caseHandle,
    caseId: request.caseId,
    form: request.form,
    gateway: prepareGateway,
    runId: plan.runId,
  });
  if (stableStringify(database) !== stableStringify(snapshot.database)) {
    throw new Error("return-covenant restart database receipt changed across generations");
  }
  const flowId = snapshot.acceptance?.originEvidence.receiptId;
  const flow = flowId ? delegateFlowRecords.get(flowId) : undefined;
  const delegate = flow ? decodeDelegateFlow(flow) : undefined;
  if (!delegate || delegate.flowId !== flowId) {
    throw new Error("return-covenant restart did not recover its durable delegate flow");
  }
  const authority = returnCovenantAuthorityFromDelegate(delegate, casePlan.logicalSessionKey);
  if (authority.epoch !== snapshot.acceptance?.capturedAuthorityGeneration) {
    throw new Error("return-covenant restart recovered different recipient authority");
  }
  if (
    !snapshot.deliveryId ||
    !(await loadPendingSessionDelivery(snapshot.deliveryId, stateDirectory(context)))
  ) {
    throw new Error("return-covenant restart did not recover its held queue delivery");
  }
  if (
    !snapshot.childSessionKey ||
    !loadSessionEntry({
      agentId: "proof",
      env: context.env,
      sessionKey: snapshot.childSessionKey,
      storePath: context.profiles.canonicalDatabasePath,
    })
  ) {
    throw new Error("return-covenant restart did not recover its child session");
  }
  return {
    ...structuredClone(snapshot),
    casePlan,
    database,
    delegate,
    gatewayPhases: {
      prepare: prepareGateway,
      dispatch: dispatchGateway,
    },
    request,
  };
}

export function activeReturnCovenantExecutionKey(state: ReturnCovenantCaseState): string {
  return returnCovenantExecutionKey(state.casePlan.id, state.form);
}
