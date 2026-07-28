import type { PolicyRoutingRules } from "./policy-routing.js";
import {
  scanPolicyChannels,
  scanPolicyMcpServers,
  scanPolicyModelProviders,
  scanPolicyModelRefs,
  scanPolicyNetwork,
} from "./policy-state-core.js";
import {
  scanPolicyAuthProfiles,
  scanPolicyDataHandling,
  scanPolicySecrets,
} from "./policy-state-data.js";
import { scanPolicyExecApprovals } from "./policy-state-exec-approvals.js";
import { scanPolicyGatewayExposure } from "./policy-state-gateway.js";
import { scanPolicyIngress } from "./policy-state-ingress.js";
import { scanPolicyRouting } from "./policy-state-routing.js";
import { scanPolicySandboxPosture } from "./policy-state-sandbox.js";
import { scanPolicyToolPosture } from "./policy-state-tool-posture.js";
import { scanPolicyTools } from "./policy-state-tools.js";
// Policy plugin evidence collection facade.
import type { PolicyEvidence } from "./policy-state-types.js";
import { scanPolicyAgentWorkspace } from "./policy-state-workspace.js";

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options?: {
    readonly toolsRaw?: undefined;
    readonly includeIngress?: boolean;
    readonly includeGatewayExposure?: boolean;
    readonly includeAgentWorkspace?: boolean;
    readonly includeDataHandling?: boolean;
    readonly includeToolPosture?: boolean;
    readonly includeSandboxPosture?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
    readonly execApprovalsRaw?: string | null;
    readonly includeExecApprovals?: boolean;
    readonly routing?: PolicyRoutingRules;
  },
): PolicyEvidence;

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: {
    readonly toolsRaw: string;
    readonly includeIngress?: boolean;
    readonly includeGatewayExposure?: boolean;
    readonly includeAgentWorkspace?: boolean;
    readonly includeDataHandling?: boolean;
    readonly includeToolPosture?: boolean;
    readonly includeSandboxPosture?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
    readonly execApprovalsRaw?: string | null;
    readonly includeExecApprovals?: boolean;
    readonly routing?: PolicyRoutingRules;
  },
): Promise<PolicyEvidence>;

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: {
    readonly toolsRaw?: string;
    readonly includeIngress?: boolean;
    readonly includeGatewayExposure?: boolean;
    readonly includeAgentWorkspace?: boolean;
    readonly includeDataHandling?: boolean;
    readonly includeToolPosture?: boolean;
    readonly includeSandboxPosture?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
    readonly execApprovalsRaw?: string | null;
    readonly includeExecApprovals?: boolean;
    readonly routing?: PolicyRoutingRules;
  } = {},
): PolicyEvidence | Promise<PolicyEvidence> {
  const evidence = {
    channels: scanPolicyChannels(cfg),
    mcpServers: scanPolicyMcpServers(cfg),
    modelProviders: scanPolicyModelProviders(cfg),
    modelRefs: scanPolicyModelRefs(cfg),
    network: scanPolicyNetwork(cfg),
    ...(options.includeIngress === false ? {} : { ingress: scanPolicyIngress(cfg) }),
    ...(options.includeGatewayExposure === false
      ? {}
      : { gatewayExposure: scanPolicyGatewayExposure(cfg) }),
    ...(options.includeAgentWorkspace === false
      ? {}
      : { agentWorkspace: scanPolicyAgentWorkspace(cfg) }),
    ...(options.includeDataHandling === false ? {} : { dataHandling: scanPolicyDataHandling(cfg) }),
    ...(options.includeToolPosture === false ? {} : { toolPosture: scanPolicyToolPosture(cfg) }),
    ...(options.includeSandboxPosture === false
      ? {}
      : { sandboxPosture: scanPolicySandboxPosture(cfg) }),
    ...(options.includeSecrets === false ? {} : { secrets: scanPolicySecrets(cfg) }),
    ...(options.includeAuthProfiles === false ? {} : { authProfiles: scanPolicyAuthProfiles(cfg) }),
    ...(options.includeExecApprovals === false || options.execApprovalsRaw === undefined
      ? {}
      : {
          execApprovals:
            options.execApprovalsRaw === null
              ? []
              : scanPolicyExecApprovals(options.execApprovalsRaw),
        }),
    ...(options.routing === undefined ? {} : { routing: scanPolicyRouting(cfg, options.routing) }),
  };
  if (options.toolsRaw === undefined) {
    return evidence;
  }
  return scanPolicyTools(options.toolsRaw).then((tools) => ({ ...evidence, tools }));
}

export { createPolicyAttestation, policyDocumentHash } from "./policy-state-attestation.js";
export type {
  PolicyAgentWorkspaceEvidence,
  PolicyAuthProfileEvidence,
  PolicyDataHandlingEvidence,
  PolicyEvidence,
  PolicyExecApprovalEvidence,
  PolicyIngressEvidence,
  PolicySandboxPostureEvidence,
  PolicyToolPostureEvidence,
} from "./policy-state-types.js";
