import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../audit/execution-identity-spawn-admission.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
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
import type { MainSessionRecoveryCommand } from "./main-session-recovery/main-session-recovery-types.js";

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

async function commitAgentCommandRecoveryState(params: {
  command: Extract<
    MainSessionRecoveryCommand,
    {
      kind: "bind_admitted_execution_identity" | "register_recovery_turn";
    }
  >;
  sessionKey: string;
  storePath: string;
  isActive: () => boolean;
}): Promise<void> {
  try {
    const bound = await commitMainSessionRecovery({
      command: params.command,
      expectedSessionId: params.command.sessionId,
      requireWriteSuccess: true,
      shouldContinue: params.isActive,
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
    });
    if (bound.transition.kind === "rejected") {
      log.warn(`failed to ${params.command.kind}: ${bound.transition.reason}`);
    }
  } catch (error) {
    log.warn(`failed to ${params.command.kind}: ${formatErrorMessage(error)}`);
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
    sessionEntry?: InternalSessionEntry;
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
  const cycleId = prepared.sessionEntry?.mainRestartRecovery?.cycleId;
  const recovery =
    opts.mainRestartRecoveryAdmitted === true &&
    opts.mainRestartRecoveryAttempt !== undefined &&
    cycleId &&
    prepared.sessionKey &&
    prepared.storePath
      ? {
          owner: {
            attempt: opts.mainRestartRecoveryAttempt,
            cycleId,
            lifecycleGeneration: params.lifecycleGeneration,
            runId: prepared.runId,
            sessionId: prepared.sessionId,
          },
          sessionKey: prepared.sessionKey,
          storePath: prepared.storePath,
        }
      : undefined;
  let admittedContext: AdmittedRunContext | undefined;
  let turnRegistration: Promise<void> | undefined;
  const isActive = () =>
    admittedContext !== undefined &&
    !opts.abortSignal?.aborted &&
    getAdmittedRunDelegatedAuthority(admittedContext) !== undefined;
  const admissionParams: Parameters<typeof prepareAgentCommandRunAdmission>[0] = {
    admission: opts.executionIdentityAdmission,
    agentId: prepared.sessionAgentId,
    cfg: prepared.cfg,
    ingress: params.ingress,
    operationalRunInstance,
    runId: prepared.runId,
    onAdmitted: async (admittedRunContext) => {
      await opts.onAdmittedRunContext?.(admittedRunContext);
      admittedContext = admittedRunContext;
      if (!recovery || !admittedRunContext.executionIdentityToken) {
        return;
      }
      await commitAgentCommandRecoveryState({
        ...recovery,
        command: {
          kind: "bind_admitted_execution_identity",
          ...recovery.owner,
          token: admittedRunContext.executionIdentityToken,
        },
        isActive,
      });
    },
  };
  const spawnFacts = readAgentCommandExecutionIdentitySpawnFacts(opts);
  const preparedAdmission = spawnFacts
    ? prepareAgentCommandRunAdmissionWithSpawnFacts(admissionParams, spawnFacts)
    : executionIdentity.prepare(admissionParams);
  const admission = opts.onPostAdmittedRunContext
    ? withPostAdmissionExecutionOwnerBinding(preparedAdmission, opts.onPostAdmittedRunContext)
    : preparedAdmission;
  return Object.freeze({
    ...admission,
    // Observational events do not await consumers. Finish their recovery write
    // before releasing the admission; explicit close remains immediate.
    finish: () => Promise.resolve(turnRegistration).finally(admission.close),
    onRuntimeTurnStarted: (): Promise<void> | undefined => {
      if (!recovery || !isActive()) {
        return undefined;
      }
      // Auth/runtime preparation is not backend acceptance. This closure is
      // invoked only by the admitted turn's lifecycle or observed CLI activity.
      return (turnRegistration ??= commitAgentCommandRecoveryState({
        ...recovery,
        command: { kind: "register_recovery_turn", ...recovery.owner },
        isActive,
      }));
    },
  });
}

export function sanitizePublicAgentCommandIngressOpts(
  opts: AgentCommandIngressOpts,
): AgentCommandGatewayIngressOpts {
  return withoutAgentCommandExecutionIdentitySpawnFacts({
    ...opts,
    senderIsOwner: false,
    mainRestartRecoveryOwnerLease: undefined,
    mainRestartRecoveryAdmitted: undefined,
    mainRestartRecoveryAttempt: undefined,
    executionIdentityAdmission: undefined,
    operationalRunInstance: undefined,
    cronCreatorAuthorityCapability: undefined,
    onAdmittedRunContext: undefined,
    onPostAdmittedRunContext: undefined,
  });
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  prepare: prepareAgentCommandRunAdmission,
  systemIngress,
};
