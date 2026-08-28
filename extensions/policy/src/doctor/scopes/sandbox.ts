// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicySandboxChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [CHECK_IDS.policySandboxModeUnapproved, "Sandbox mode config satisfies policy requirements."],
    [
      CHECK_IDS.policySandboxBackendUnapproved,
      "Sandbox backend config satisfies policy requirements.",
    ],
    [
      CHECK_IDS.policySandboxContainerPostureUnobservable,
      "Sandbox container posture policy only targets observable container backends.",
    ],
    [
      CHECK_IDS.policySandboxContainerHostNetworkDenied,
      "Sandbox container config avoids host network mode.",
    ],
    [
      CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
      "Sandbox container config avoids joining another container network namespace.",
    ],
    [
      CHECK_IDS.policySandboxContainerMountModeRequired,
      "Sandbox container mounts are read-only when policy requires it.",
    ],
    [
      CHECK_IDS.policySandboxContainerRuntimeSocketMount,
      "Sandbox container mounts avoid host container runtime sockets.",
    ],
    [
      CHECK_IDS.policySandboxContainerUnconfinedProfile,
      "Sandbox container profile config avoids unconfined profiles.",
    ],
    [
      CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
      "Sandbox browser CDP config includes a source range when policy requires it.",
    ],
  ]);
}
