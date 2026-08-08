import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  prepareAgentRunAdmission,
  type OperationalRunInstanceRef,
} from "./admitted-run-context.js";
import type { AgentCommandOpts } from "./command/types.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";

type AgentCommandAdmissionIngress = ExecutionIdentityAdmissionFacts["ingress"];

const LOCAL_CLI_ADMISSION_INGRESS: AgentCommandAdmissionIngress = {
  kind: "local-cli",
  boundary: "agent-command.local",
  state: "present",
};

function systemIngress(boundary: string): AgentCommandAdmissionIngress {
  return { kind: "system", boundary, state: "present" };
}

function prepareAgentCommandRunAdmission(params: {
  admission?: AgentCommandOpts["executionIdentityAdmission"];
  agentId: string;
  cfg: OpenClawConfig;
  ingress: AgentCommandAdmissionIngress;
  operationalRunInstance: OperationalRunInstanceRef;
  runId: string;
  onAdmitted?: Parameters<typeof prepareAgentRunAdmission>[0]["onAdmitted"];
}) {
  return prepareAgentRunAdmission({
    cfg: params.cfg,
    operationalRunInstance: params.operationalRunInstance,
    facts: {
      runId: params.runId,
      agentId: params.agentId,
      ingress: params.ingress,
    },
    ...(params.admission ? { recovery: params.admission } : {}),
    ...(params.onAdmitted ? { onAdmitted: params.onAdmitted } : {}),
  });
}

export async function bindAgentCommandRecoveryExecutionIdentity(params: {
  cycleId: string;
  lifecycleGeneration: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  token: ExecutionIdentityAdmissionToken;
}): Promise<string | undefined> {
  try {
    const bound = await commitMainSessionRecovery({
      command: {
        kind: "bind_admitted_execution_identity",
        cycleId: params.cycleId,
        lifecycleGeneration: params.lifecycleGeneration,
        runId: params.runId,
        sessionId: params.sessionId,
        token: params.token,
      },
      expectedSessionId: params.sessionId,
      requireWriteSuccess: true,
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
    });
    return bound.transition.kind === "rejected" ? bound.transition.reason : undefined;
  } catch (error) {
    return formatErrorMessage(error);
  }
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  prepare: prepareAgentCommandRunAdmission,
  systemIngress,
};
