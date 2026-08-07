import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
} from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureAgentRunLifecycleGeneration } from "../infra/agent-events.js";
import { assertAgentRunAttributionAdmissionCompatible } from "../infra/agent-run-registry.js";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";
import type { AgentCommandGatewayIngressOpts, AgentCommandOpts } from "./command/types.js";

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
  attribution?: AgentCommandOpts["executionAttribution"];
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
      ...(params.attribution
        ? params.attribution.executionIdentityAdmission
          ? {
              token: params.attribution.executionIdentityAdmission.token,
              retryOnly: params.attribution.executionIdentityAdmission.retryOnly,
            }
          : {
              contextId: params.attribution.contextId,
              executionId: params.attribution.executionId,
              now: params.attribution.createdAt,
            }
        : {}),
    },
  );
}

function resolveAgentCommandExecutionAttribution(
  opts: AgentCommandOpts,
  params: {
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    sessionAgentId?: string;
  },
): {
  attribution: NonNullable<AgentCommandOpts["executionAttribution"]>;
  lifecycleGeneration: string;
} {
  if (opts.executionAttribution && opts.executionAttribution.runId !== params.runId) {
    throw new Error("Agent command execution attribution runId does not match the command runId.");
  }
  const lifecycleGeneration =
    opts.executionAttribution?.lifecycleGeneration ??
    opts.lifecycleGeneration ??
    captureAgentRunLifecycleGeneration(params.runId);
  assertAgentRunAttributionAdmissionCompatible(
    params.runId,
    lifecycleGeneration,
    opts.executionAttribution,
  );
  return {
    attribution:
      opts.executionAttribution ??
      createAgentExecutionAttribution({
        runId: params.runId,
        lifecycleGeneration,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.sessionAgentId,
      }),
    lifecycleGeneration,
  };
}

function replaceAgentCommandExecutionAttribution(
  opts: AgentCommandOpts,
  attribution: AgentCommandOpts["executionAttribution"],
): AgentCommandOpts {
  return attribution === opts.executionAttribution
    ? opts
    : { ...opts, executionAttribution: attribution };
}

function prepareAgentCommandIngress(
  opts: AgentCommandGatewayIngressOpts,
  trustedAttribution: boolean,
): {
  lifecycleGeneration: string;
  opts: AgentCommandGatewayIngressOpts;
} {
  const internalOpts: AgentCommandGatewayIngressOpts = trustedAttribution
    ? opts
    : { ...opts, executionAttribution: undefined };
  if (typeof internalOpts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return {
    lifecycleGeneration:
      internalOpts.lifecycleGeneration ??
      captureAgentRunLifecycleGeneration(internalOpts.runId ?? ""),
    opts: internalOpts,
  };
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  prepareIngress: prepareAgentCommandIngress,
  record: recordAgentCommandExecutionIdentity,
  replaceAttribution: replaceAgentCommandExecutionAttribution,
  resolveAttribution: resolveAgentCommandExecutionAttribution,
  systemIngress,
};
