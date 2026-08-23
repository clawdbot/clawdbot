import type {
  ExecutionIdentityAdmissionFacts,
  ExecutionIdentityAdmissionToken,
} from "../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../audit/execution-identity-spawn-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type OperationalRunInstanceRef,
} from "./admitted-run-context.js";
import {
  attachAgentCommandAdmissionFacts,
  getAgentCommandAdmissionFacts,
} from "./agent-command-admission-facts.js";
import {
  type AgentCommandExecutionIdentitySpawnFacts,
  readAgentCommandExecutionIdentitySpawnFacts,
  withoutAgentCommandExecutionIdentitySpawnFacts,
} from "./agent-command-execution-identity-spawn.js";
import type {
  AgentCommandGatewayIngressOpts,
  AgentCommandIngressOpts,
  AgentCommandOpts,
} from "./command/types.js";
import { commitMainSessionRecovery } from "./main-session-recovery/main-session-recovery-store.js";

export type AgentCommandAdmissionIngress = ExecutionIdentityAdmissionFacts["ingress"];

const log = createSubsystemLogger("agents/agent-command");

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
  return prepareAgentCommandRunAdmissionWithSpawnFacts(params);
}

function prepareAgentCommandRunAdmissionWithSpawnFacts(
  params: Parameters<typeof prepareAgentCommandRunAdmission>[0],
  spawnFacts?: AgentCommandExecutionIdentitySpawnFacts,
) {
  const admissionFacts = getAgentCommandAdmissionFacts(params.operationalRunInstance) ?? {
    ingress: params.ingress,
  };
  const applicableGrants = spawnFacts?.applicableGrants;
  const assurance = spawnFacts?.assurance ?? admissionFacts.assurance;
  return prepareAgentRunAdmission({
    cfg: params.cfg,
    operationalRunInstance: params.operationalRunInstance,
    facts: executionIdentitySpawnAdmission({
      operation: "attach",
      value: {
        runId: params.runId,
        agentId: params.agentId,
        ingress: spawnFacts?.ingress ?? admissionFacts.ingress,
        ...((spawnFacts?.invoker ?? admissionFacts.invoker)
          ? { invoker: spawnFacts?.invoker ?? admissionFacts.invoker }
          : {}),
        ...(applicableGrants ? { applicableGrants } : {}),
        ...(assurance ? { assurance } : {}),
      },
      extra: spawnFacts?.spawnAdmission,
    }),
    ...(params.admission ? { recovery: params.admission } : {}),
    ...(params.onAdmitted ? { onAdmitted: params.onAdmitted } : {}),
  });
}

async function bindAgentCommandRecoveryExecutionIdentity(params: {
  attempt: number;
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
        attempt: params.attempt,
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

export function prepareAgentCommandExecutionIdentity(params: {
  opts: AgentCommandOpts;
  prepared: {
    cfg: OpenClawConfig;
    runId: string;
    sessionAgentId: string;
    sessionId: string;
    sessionKey?: string;
    storePath?: string;
  };
  ingress: AgentCommandAdmissionIngress;
  lifecycleGeneration: string;
}) {
  const { opts, prepared } = params;
  const operationalRunInstance =
    opts.operationalRunInstance ?? createOperationalRunInstanceRef(prepared.runId);
  const admissionFacts = getAgentCommandAdmissionFacts(params.opts.runContext ?? params.opts);
  if (admissionFacts) {
    attachAgentCommandAdmissionFacts(operationalRunInstance, admissionFacts);
  }
  const admissionParams: Parameters<typeof prepareAgentCommandRunAdmission>[0] = {
    admission: opts.executionIdentityAdmission,
    agentId: prepared.sessionAgentId,
    cfg: prepared.cfg,
    ingress: params.ingress,
    operationalRunInstance,
    runId: prepared.runId,
    onAdmitted: async (admittedRunContext) => {
      await opts.onAdmittedRunContext?.(admittedRunContext);
      if (
        opts.mainRestartRecoveryAdmitted !== true ||
        opts.mainRestartRecoveryAttempt === undefined ||
        !opts.mainRestartRecoveryOwnerLease ||
        !admittedRunContext.executionIdentityToken ||
        !prepared.sessionKey ||
        !prepared.storePath
      ) {
        return;
      }
      const bindingFailure = await bindAgentCommandRecoveryExecutionIdentity({
        attempt: opts.mainRestartRecoveryAttempt,
        cycleId: opts.mainRestartRecoveryOwnerLease.cycleId,
        lifecycleGeneration: params.lifecycleGeneration,
        runId: prepared.runId,
        sessionId: prepared.sessionId,
        sessionKey: prepared.sessionKey,
        storePath: prepared.storePath,
        token: admittedRunContext.executionIdentityToken,
      });
      if (bindingFailure) {
        log.warn(`failed to bind restart recovery execution identity: ${bindingFailure}`);
      }
    },
  };
  const spawnFacts = readAgentCommandExecutionIdentitySpawnFacts(opts);
  return spawnFacts
    ? prepareAgentCommandRunAdmissionWithSpawnFacts(admissionParams, spawnFacts)
    : executionIdentity.prepare(admissionParams);
}

export function sanitizePublicAgentCommandIngressOpts(
  opts: AgentCommandIngressOpts,
): AgentCommandGatewayIngressOpts {
  return withoutAgentCommandExecutionIdentitySpawnFacts({
    ...opts,
    mainRestartRecoveryOwnerLease: undefined,
    mainRestartRecoveryAdmitted: undefined,
    mainRestartRecoveryAttempt: undefined,
    executionIdentityAdmission: undefined,
    operationalRunInstance: undefined,
    cronCreatorAuthorityCapability: undefined,
    onAdmittedRunContext: undefined,
  });
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  prepare: prepareAgentCommandRunAdmission,
  systemIngress,
};
