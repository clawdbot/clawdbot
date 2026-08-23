// Policy doctor health-check catalog.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { createPolicyChannelProviderChecks, createPolicyIngressChecks } from "./scopes/channels.js";
import { createPolicyCoreChecks } from "./scopes/core.js";
import { createPolicyDataAuthChecks } from "./scopes/data-auth.js";
import { createPolicyExecApprovalChecks } from "./scopes/exec-approvals.js";
import { createPolicyGatewayChecks } from "./scopes/gateway.js";
import { createPolicyModelNetworkChecks } from "./scopes/model-network.js";
import { createPolicyRoutingChecks } from "./scopes/routing.js";
import { createPolicySandboxChecks } from "./scopes/sandbox.js";
import { createPolicyAgentToolChecks, createPolicyToolMetadataChecks } from "./scopes/tools.js";
import type { PolicyDoctorCheckDeps } from "./types.js";

export function createPolicyDoctorChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return [
    ...createPolicyCoreChecks(deps),
    ...createPolicyChannelProviderChecks(deps),
    ...createPolicyModelNetworkChecks(deps),
    ...createPolicyIngressChecks(deps),
    ...createPolicyRoutingChecks(deps),
    ...createPolicyGatewayChecks(deps),
    ...createPolicyAgentToolChecks(deps),
    ...createPolicySandboxChecks(deps),
    ...createPolicyDataAuthChecks(deps),
    ...createPolicyExecApprovalChecks(deps),
    ...createPolicyToolMetadataChecks(deps),
  ];
}
