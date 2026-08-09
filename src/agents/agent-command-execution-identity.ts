import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
} from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentCommandOpts } from "./command/types.js";

type AgentCommandAdmissionIngress = ExecutionIdentityAdmissionFacts["ingress"];

const LOCAL_CLI_ADMISSION_INGRESS: AgentCommandAdmissionIngress = {
  kind: "local-cli",
  boundary: "agent-command.local",
  state: "present",
};

function systemIngress(boundary: string): AgentCommandAdmissionIngress {
  return { kind: "system", boundary, state: "present" };
}

function recordAgentCommandExecutionIdentity(params: {
  admission?: AgentCommandOpts["executionIdentityAdmission"];
  agentId: string;
  cfg: OpenClawConfig;
  ingress: AgentCommandAdmissionIngress;
  runId: string;
  runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"];
}): void {
  // Session work admission owns these facts. Queue acceptance is not persistence;
  // audit loss must never become run loss.
  enqueueExecutionIdentityContextAtAdmission(
    {
      runId: params.runId,
      agentId: params.agentId,
      ingress: params.ingress,
      runtime: { kind: params.runtimeKind },
    },
    {
      enabled: isExecutionIdentityCollectionEnabled(params.cfg),
      ...(params.admission
        ? { token: params.admission.token, retryOnly: params.admission.retryOnly }
        : {}),
    },
  );
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  record: recordAgentCommandExecutionIdentity,
  systemIngress,
};
