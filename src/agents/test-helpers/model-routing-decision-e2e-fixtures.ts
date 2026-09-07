import {
  configureExecutionDecisionWorkSink,
  type ExecutionDecisionWork,
} from "../../audit/execution-decision-work.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";

export function createModelRoutingTestAdmission(params: {
  cfg: OpenClawConfig;
  runId: string;
  agentId?: string;
  boundary: string;
}) {
  return prepareAgentRunAdmission({
    cfg: params.cfg,
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: params.agentId ?? "test",
      ingress: { kind: "system", boundary: params.boundary, state: "present" },
    },
  });
}

export async function captureRoutingDecisionWork<T>(
  run: () => Promise<T>,
): Promise<{ decisionWork: ExecutionDecisionWork[]; result: T }> {
  const decisionWork: ExecutionDecisionWork[] = [];
  const clearAdmissionSink = configureExecutionIdentityAdmissionSink(() => true);
  const clearDecisionSink = configureExecutionDecisionWorkSink((work) => {
    decisionWork.push(work);
    return true;
  });
  try {
    return { decisionWork, result: await run() };
  } finally {
    clearDecisionSink();
    clearAdmissionSink();
  }
}
