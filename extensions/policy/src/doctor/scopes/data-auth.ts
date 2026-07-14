// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyDataAuthChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyDataHandlingRedactionDisabledCheck: HealthCheck = {
    id: CHECK_IDS.policyDataHandlingRedactionDisabled,
    kind: "plugin",
    description: "Sensitive logging redaction remains enabled when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyDataHandlingRedactionDisabled,
      );
    },
    repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(
        ctx,
        findings,
        CHECK_IDS.policyDataHandlingRedactionDisabled,
      );
    },
  };
  const policyDataHandlingTelemetryContentCaptureCheck: HealthCheck = {
    id: CHECK_IDS.policyDataHandlingTelemetryContentCapture,
    kind: "plugin",
    description: "Telemetry content capture remains disabled when policy denies it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyDataHandlingTelemetryContentCapture,
      );
    },
    repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(
        ctx,
        findings,
        CHECK_IDS.policyDataHandlingTelemetryContentCapture,
      );
    },
  };
  const policyDataHandlingSessionRetentionNotEnforcedCheck: HealthCheck = {
    id: CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
    kind: "plugin",
    description: "Session retention maintenance is enforced when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
      );
    },
  };
  const policyDataHandlingSessionTranscriptMemoryCheck: HealthCheck = {
    id: CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
    kind: "plugin",
    description: "Session transcript memory indexing remains disabled when policy denies it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
      );
    },
  };
  const policySecretsUnmanagedProviderCheck: HealthCheck = {
    id: CHECK_IDS.policySecretsUnmanagedProvider,
    kind: "plugin",
    description:
      "OpenClaw config SecretRefs use configured secret providers when policy requires managed providers.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsUnmanagedProvider);
    },
  };
  const policySecretsDeniedProviderSourceCheck: HealthCheck = {
    id: CHECK_IDS.policySecretsDeniedProviderSource,
    kind: "plugin",
    description:
      "OpenClaw config secret providers and SecretRefs do not use sources denied by policy.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySecretsDeniedProviderSource,
      );
    },
  };
  const policySecretsInsecureProviderCheck: HealthCheck = {
    id: CHECK_IDS.policySecretsInsecureProvider,
    kind: "plugin",
    description:
      "Configured secret providers do not opt into insecure posture unless policy allows it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsInsecureProvider);
    },
  };
  const policyAuthProfileInvalidMetadataCheck: HealthCheck = {
    id: CHECK_IDS.policyAuthProfileInvalidMetadata,
    kind: "plugin",
    description: "OpenClaw config auth profiles declare required provider and mode metadata.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyAuthProfileInvalidMetadata,
      );
    },
  };
  const policyAuthProfileUnapprovedModeCheck: HealthCheck = {
    id: CHECK_IDS.policyAuthProfileUnapprovedMode,
    kind: "plugin",
    description: "OpenClaw config auth profile modes stay within the policy allowlist.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAuthProfileUnapprovedMode);
    },
  };

  return [
    policyDataHandlingRedactionDisabledCheck,
    policyDataHandlingTelemetryContentCaptureCheck,
    policyDataHandlingSessionRetentionNotEnforcedCheck,
    policyDataHandlingSessionTranscriptMemoryCheck,
    policySecretsUnmanagedProviderCheck,
    policySecretsDeniedProviderSourceCheck,
    policySecretsInsecureProviderCheck,
    policyAuthProfileInvalidMetadataCheck,
    policyAuthProfileUnapprovedModeCheck,
  ];
}
