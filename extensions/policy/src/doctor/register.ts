import {
  getHealthCheck,
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
} from "openclaw/plugin-sdk/health";
import { createPolicyDoctorChecks } from "./checks.js";
import { evaluatePolicy, findingsForCheck } from "./evaluation.js";
import {
  channelIdsFromFindings,
  disableChannels,
  workspaceRepairsDisabledResult,
  workspaceRepairsEnabled,
} from "./policy-runtime.js";

let policyDoctorChecks: readonly HealthCheck[] | undefined;
const registeredPolicyDoctorRegistrars = new WeakSet<(check: HealthCheck) => void>();

type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

export function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void {
  if (host !== undefined && registeredPolicyDoctorRegistrars.has(host.registerHealthCheck)) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  policyDoctorChecks ??= createPolicyDoctorChecks({
    channelIdsFromFindings,
    disableChannels,
    evaluatePolicy,
    findingsForCheck,
    workspaceRepairsDisabledResult,
    workspaceRepairsEnabled,
  });
  for (const check of policyDoctorChecks) {
    if (host === undefined && getHealthCheck(check.id) === check) {
      continue;
    }
    registerHealthCheck(check);
  }
  registeredPolicyDoctorRegistrars.add(registerHealthCheck);
}

export { evaluatePolicy };
export { policyContainerShapeFindings } from "./policy-shape.js";
export { POLICY_CHECK_IDS } from "./check-ids.js";
export {
  POLICY_RULE_METADATA,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./metadata.js";
export { isPolicyValueAtLeastAsStrict } from "./strictness.js";
