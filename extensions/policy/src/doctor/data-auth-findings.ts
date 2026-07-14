import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyDataHandlingEvidence, PolicyEvidence } from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import {
  authProfileAllowModesShapeFindings,
  dataHandlingEntries,
  dataHandlingFinding,
  dataHandlingLabel,
  dataHandlingPolicyShapeFindings,
  secretPolicyShapeFindings,
} from "./data-auth-shapes.js";
import { authProfileHasMetadata, requiredAuthProfileMetadata } from "./policy-runtime.js";
import {
  agentScopedPolicyTargets,
  dataHandlingPolicyHasRules,
  scopedAgentIdMatches,
} from "./policy-scope.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function secretAuthProvenanceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const secretShapeFindings = secretPolicyShapeFindings(policy, policyPath, policyDocName);
  const authShapeFindings = authProfileAllowModesShapeFindings(policy, policyPath, policyDocName);
  return [
    ...(secretShapeFindings.length > 0
      ? secretShapeFindings
      : [
          ...secretManagedProviderFindings(policy, policyDocName, evidence),
          ...secretDeniedSourceFindings(policy, policyDocName, evidence),
          ...secretInsecureProviderFindings(policy, policyDocName, evidence),
        ]),
    ...(authShapeFindings.length > 0
      ? authShapeFindings
      : [
          ...authProfileMetadataFindings(policy, policyDocName, evidence),
          ...authProfileModeFindings(policy, policyDocName, evidence),
        ]),
  ];
}

export function dataHandlingFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const shapeFindings = dataHandlingPolicyShapeFindings(policy, policyPath, policyDocName);
  if (shapeFindings.length > 0) {
    return shapeFindings;
  }
  const findings: HealthFinding[] = [];
  findings.push(
    ...dataHandlingFindingsForRule(policy, policyDocName, "dataHandling", evidence, () => true),
  );
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!dataHandlingPolicyHasRules(target.overlay.dataHandling)) {
      continue;
    }
    findings.push(
      ...dataHandlingFindingsForRule(
        target.overlay,
        policyDocName,
        `scopes/${ocPathSegment(target.scopeName)}/dataHandling`,
        evidence,
        (entry) =>
          entry.kind !== "memorySessionTranscriptIndexing" ||
          scopedDataHandlingAgentMatches(entry, target.agentId, evidence.dataHandling ?? []),
      ),
    );
  }
  return findings;
}

function scopedDataHandlingAgentMatches(
  entry: PolicyDataHandlingEvidence,
  policyAgentId: string,
  entries: readonly PolicyDataHandlingEvidence[],
): boolean {
  if (entry.id === "memory-qmd-session-transcripts") {
    return true;
  }
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return (
    entry.id === "agents-defaults-memory-session-transcripts" &&
    !entries.some(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === entry.kind &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    )
  );
}

function dataHandlingFindingsForRule(
  policy: unknown,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyDataHandlingEvidence) => boolean,
): readonly HealthFinding[] {
  const dataHandling = isRecord(policy) ? policy.dataHandling : undefined;
  if (!isRecord(dataHandling)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  if (readPolicyBoolean(dataHandling, ["sensitiveLogging", "requireRedaction"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "sensitiveLoggingRedaction")
        .filter(evidenceFilter)
        .filter((entry) => entry.value !== true)
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingRedactionDisabled,
            message: "Sensitive logging redaction is disabled.",
            requirement: `oc://${policyDocName}/${requirementBase}/sensitiveLogging/requireRedaction`,
            fixHint: "Set logging.redactSensitive to tools or update policy after review.",
          }),
        ),
    );
  }
  if (readPolicyBoolean(dataHandling, ["telemetry", "denyContentCapture"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "telemetryContentCapture")
        .filter(evidenceFilter)
        .filter((entry) => entry.value === true)
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingTelemetryContentCapture,
            message: "Telemetry content capture is enabled.",
            requirement: `oc://${policyDocName}/${requirementBase}/telemetry/denyContentCapture`,
            fixHint: "Disable diagnostics.otel.captureContent or update policy after review.",
          }),
        ),
    );
  }
  if (readPolicyBoolean(dataHandling, ["retention", "requireSessionMaintenance"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "sessionRetentionMode")
        .filter(evidenceFilter)
        .filter((entry) => entry.value !== "enforce")
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
            message: `Session retention maintenance mode is '${entry.value ?? "unknown"}'.`,
            requirement: `oc://${policyDocName}/${requirementBase}/retention/requireSessionMaintenance`,
            fixHint: "Set session.maintenance.mode to enforce or update policy after review.",
          }),
        ),
    );
  }
  if (readPolicyBoolean(dataHandling, ["memory", "denySessionTranscriptIndexing"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "memorySessionTranscriptIndexing")
        .filter(evidenceFilter)
        .filter((entry) => entry.value === true)
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
            message: `${dataHandlingLabel(entry)} enables session transcript memory indexing.`,
            requirement: `oc://${policyDocName}/${requirementBase}/memory/denySessionTranscriptIndexing`,
            fixHint:
              "Disable session transcript memory indexing for the matching config surface or update policy after review.",
          }),
        ),
    );
  }
  return findings;
}

function secretManagedProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["secrets", "requireManagedProviders"]) !== true) {
    return [];
  }
  const secrets = evidence.secrets ?? [];
  const providerKeys = new Set(
    secrets
      .filter((secret) => secret.kind === "provider" && secret.providerSource !== undefined)
      .map((secret) => `${secret.providerSource}:${secret.id}`),
  );
  return secrets
    .filter(
      (secret) =>
        secret.kind === "input" &&
        secret.provenance === "secretRef" &&
        (secret.refProvider === undefined ||
          secret.refSource === undefined ||
          !providerKeys.has(`${secret.refSource}:${secret.refProvider}`)),
    )
    .map((secret): HealthFinding => {
      return {
        checkId: CHECK_IDS.policySecretsUnmanagedProvider,
        severity: "error",
        message: `SecretRef uses unmanaged provider '${secret.refProvider ?? "default"}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: secret.source,
        target: secret.source,
        requirement: `oc://${policyDocName}/secrets/requireManagedProviders`,
        fixHint:
          "Declare the referenced provider under secrets.providers or update policy after review.",
      };
    });
}

function secretDeniedSourceFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const deniedSources = new Set(readStringList(policy, ["secrets", "denySources"]));
  if (deniedSources.size === 0) {
    return [];
  }
  return (evidence.secrets ?? [])
    .filter((secret) => {
      const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
      return source !== undefined && deniedSources.has(source);
    })
    .map((secret): HealthFinding => {
      const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
      return {
        checkId: CHECK_IDS.policySecretsDeniedProviderSource,
        severity: "error",
        message: `Secret ${secret.kind} '${secret.id}' uses denied source '${source}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: secret.source,
        target: secret.source,
        requirement: `oc://${policyDocName}/secrets/denySources`,
        fixHint: "Move this secret to an approved source or update policy after review.",
      };
    });
}

function secretInsecureProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["secrets", "allowInsecureProviders"]) !== false) {
    return [];
  }
  return (evidence.secrets ?? [])
    .filter((secret) => secret.kind === "provider" && (secret.insecure?.length ?? 0) > 0)
    .map((secret): HealthFinding => {
      return {
        checkId: CHECK_IDS.policySecretsInsecureProvider,
        severity: "error",
        message: `Secret provider '${secret.id}' enables insecure posture: ${(secret.insecure ?? []).join(", ")}.`,
        source: "policy",
        path: "openclaw config",
        ocPath: secret.source,
        target: secret.source,
        requirement: `oc://${policyDocName}/secrets/allowInsecureProviders`,
        fixHint: "Remove insecure provider overrides or update policy after review.",
      };
    });
}

function authProfileMetadataFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const requiredMetadata = requiredAuthProfileMetadata(policy);
  if (requiredMetadata.size === 0) {
    return [];
  }
  return (evidence.authProfiles ?? []).flatMap((profile): HealthFinding[] => {
    const missing = [...requiredMetadata].filter(
      (metadata) => !authProfileHasMetadata(profile, metadata),
    );
    if (missing.length === 0) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyAuthProfileInvalidMetadata,
        severity: "error",
        message: `Auth profile '${profile.id}' is missing required metadata: ${missing.join(", ")}.`,
        source: "policy",
        path: "openclaw config",
        ocPath: profile.source,
        target: profile.source,
        requirement: `oc://${policyDocName}/auth/profiles/requireMetadata`,
        fixHint: "Set auth.profiles.<id>.provider and a supported auth profile mode.",
      },
    ];
  });
}

function authProfileModeFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const allowedModes = new Set(readStringList(policy, ["auth", "profiles", "allowModes"]));
  if (allowedModes.size === 0) {
    return [];
  }
  return (evidence.authProfiles ?? [])
    .filter((profile) => profile.mode !== undefined && !allowedModes.has(profile.mode))
    .map((profile): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyAuthProfileUnapprovedMode,
        severity: "error",
        message: `Auth profile '${profile.id}' uses mode '${profile.mode}' outside the policy allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: profile.source,
        target: profile.source,
        requirement: `oc://${policyDocName}/auth/profiles/allowModes`,
        fixHint: "Change the auth profile mode or update policy after review.",
      };
    });
}
