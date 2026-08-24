// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyDataAuthChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyDataHandlingTelemetryContentCapture,
      "Telemetry content capture remains disabled when policy denies it.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(
          ctx,
          findings,
          CHECK_IDS.policyDataHandlingTelemetryContentCapture,
        ),
    ],
    [
      CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
      "Session retention maintenance is enforced when policy requires it.",
    ],
    [
      CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
      "Session transcript memory indexing remains disabled when policy denies it.",
    ],
    [
      CHECK_IDS.policySecretsUnmanagedProvider,
      "OpenClaw config SecretRefs use configured secret providers when policy requires managed providers.",
    ],
    [
      CHECK_IDS.policySecretsDeniedProviderSource,
      "OpenClaw config secret providers and SecretRefs do not use sources denied by policy.",
    ],
    [
      CHECK_IDS.policySecretsInsecureProvider,
      "Configured secret providers do not opt into insecure posture unless policy allows it.",
    ],
    [
      CHECK_IDS.policyAuthProfileInvalidMetadata,
      "OpenClaw config auth profiles declare required provider and mode metadata.",
    ],
    [
      CHECK_IDS.policyAuthProfileUnapprovedMode,
      "OpenClaw config auth profile modes stay within the policy allowlist.",
    ],
  ]);
}
