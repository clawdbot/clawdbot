import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyEvidence, PolicySandboxPostureEvidence } from "../policy-state.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { SANDBOX_CONTAINER_POLICY_RULES } from "./metadata.js";
import { agentScopedPolicyTargets, scopedAgentIdMatches } from "./policy-scope.js";
import { sandboxPolicyShapeFinding } from "./sandbox-gateway-shapes.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function sandboxPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const sandboxPolicy = policy.sandbox;
  if (
    isRecord(sandboxPolicy) &&
    sandboxPolicyShapeFinding(sandboxPolicy, { policyDocName, policyPath }) === undefined
  ) {
    findings.push(
      ...sandboxPostureFindingsForRule(
        sandboxPolicy,
        policyDocName,
        "sandbox",
        evidence,
        () => true,
      ),
    );
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  for (const target of agentScopedPolicyTargets(policy)) {
    const scopedSandboxPolicy = target.overlay.sandbox;
    if (
      sandboxPolicyShapeFinding(scopedSandboxPolicy, {
        policyDocName,
        policyPath,
        targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/sandbox`,
        propertyPrefix: `scopes.${target.scopeName}.sandbox`,
      }) !== undefined ||
      !isRecord(scopedSandboxPolicy)
    ) {
      continue;
    }
    findings.push(
      ...sandboxPostureFindingsForRule(
        scopedSandboxPolicy,
        policyDocName,
        `scopes/${ocPathSegment(target.scopeName)}/sandbox`,
        evidence,
        (entry) => scopedSandboxAgentMatches(entry, target.agentId, evidence.sandboxPosture ?? []),
      ),
    );
  }
  return findings;
}

function sandboxPostureFindingsForRule(
  sandboxPolicy: Record<string, unknown> | undefined,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (!isRecord(sandboxPolicy)) {
    return [];
  }
  return [
    ...sandboxModeFindings(sandboxPolicy, policyDocName, requirementBase, evidence, evidenceFilter),
    ...sandboxBackendFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerPostureUnobservableFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerHostNetworkFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerNamespaceJoinFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerMountModeFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerRuntimeSocketMountFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerUnconfinedProfileFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxBrowserCdpSourceRangeFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function scopedSandboxAgentMatches(
  entry: PolicySandboxPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicySandboxPostureEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return (
    entry.scope === "defaults" &&
    !scopedSandboxDefaultDisabledForAgent(entry, policyAgentId, entries) &&
    !entries.some(
      (candidate) =>
        candidate.scope === "agent" &&
        sandboxPostureEntriesDescribeSameField(candidate, entry) &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    )
  );
}

function scopedSandboxDefaultDisabledForAgent(
  entry: PolicySandboxPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicySandboxPostureEvidence[],
): boolean {
  if (sandboxEntryRequiresContainerBackend(entry)) {
    const backend = entries.find(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === "backend" &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    );
    if (typeof backend?.value === "string" && backend.value.toLowerCase() !== "docker") {
      return true;
    }
  }

  if (sandboxEntryRequiresBrowser(entry)) {
    const browser = entries.find(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === "browserCdpSourceRange" &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    );
    if (browser?.value === false) {
      return true;
    }
  }

  return false;
}

function sandboxEntryRequiresContainerBackend(entry: PolicySandboxPostureEvidence): boolean {
  return (
    (entry.kind === "containerNetwork" && entry.networkSurface === "docker") ||
    entry.kind === "containerSecurityProfile" ||
    (entry.kind === "containerMount" && entry.bindSurface === "docker")
  );
}

function sandboxEntryRequiresBrowser(entry: PolicySandboxPostureEvidence): boolean {
  return (
    entry.kind === "browserCdpSourceRange" ||
    (entry.kind === "containerNetwork" && entry.networkSurface === "browser") ||
    (entry.kind === "containerMount" && entry.bindSurface === "browser")
  );
}

function sandboxPostureEntriesDescribeSameField(
  candidate: PolicySandboxPostureEvidence,
  baseline: PolicySandboxPostureEvidence,
): boolean {
  return (
    candidate.kind === baseline.kind &&
    candidate.bindSurface === baseline.bindSurface &&
    candidate.networkSurface === baseline.networkSurface &&
    candidate.profile === baseline.profile
  );
}

function sandboxModeFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(sandboxPolicy, ["requireMode"]));
  if (allowed.size === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "mode")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxModeUnapproved,
        message: `${sandboxPostureLabel(entry)} uses unapproved sandbox mode '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/requireMode`,
        fixHint:
          "Set agents.defaults.sandbox.mode or agents.list[].sandbox.mode to an approved value.",
      }),
    );
}

function sandboxBackendFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(sandboxPolicy, ["allowBackends"]));
  if (allowed.size === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "backend")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxBackendUnapproved,
        message: `${sandboxPostureLabel(entry)} uses unapproved sandbox backend '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/allowBackends`,
        fixHint: "Use an approved sandbox backend or update policy after review.",
      }),
    );
}

function sandboxContainerPostureUnobservableFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const enabledRules = SANDBOX_CONTAINER_POLICY_RULES.filter(
    (rule) => readPolicyBoolean(sandboxPolicy, ["containers", rule.key]) === true,
  );
  if (enabledRules.length === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "backend")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && entry.value.toLowerCase() !== "docker")
    .flatMap((entry) =>
      enabledRules.map((rule) =>
        sandboxPostureFinding(entry, {
          checkId: CHECK_IDS.policySandboxContainerPostureUnobservable,
          message: `${sandboxPostureLabel(entry)} uses sandbox backend '${entry.value ?? ""}', which cannot observe ${rule.label}.`,
          requirement: `oc://${policyDocName}/${requirementBase}/containers/${rule.key}`,
          fixHint:
            "Use an observable container backend for this sandbox or remove the container posture rule.",
        }),
      ),
    );
}

function sandboxContainerHostNetworkFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "denyHostNetwork"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerNetwork")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && entry.value.toLowerCase() === "host")
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerHostNetworkDenied,
        message: `${sandboxPostureLabel(entry)} uses host container network mode.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyHostNetwork`,
        fixHint: "Change the container network mode or update policy after review.",
      }),
    );
}

function sandboxContainerNamespaceJoinFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "denyContainerNamespaceJoin"]) !== true) {
    return [];
  }
  const containerNamespacePrefix = "container:";
  return sandboxPostureEntries(evidence, "containerNetwork")
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        typeof entry.value === "string" &&
        entry.value.toLowerCase().startsWith(containerNamespacePrefix),
    )
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
        message: `${sandboxPostureLabel(entry)} joins another container network namespace '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyContainerNamespaceJoin`,
        fixHint: "Change the container network mode or update policy after review.",
      }),
    );
}

function sandboxContainerMountModeFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "requireReadOnlyMounts"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerMount")
    .filter(evidenceFilter)
    .filter((entry) => entry.bindMode !== "ro")
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerMountModeRequired,
        message: `${sandboxPostureLabel(entry)} has container mount '${entry.bind ?? ""}' with mode '${entry.bindMode ?? "unknown"}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/requireReadOnlyMounts`,
        fixHint: "Set the mount mode to read-only or update policy after review.",
      }),
    );
}

function sandboxContainerRuntimeSocketMountFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (
    readPolicyBoolean(sandboxPolicy, ["containers", "denyContainerRuntimeSocketMounts"]) !== true
  ) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerMount")
    .filter(evidenceFilter)
    .filter((entry) => bindHostLooksLikeContainerRuntimeSocket(entry.bindHost))
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerRuntimeSocketMount,
        message: `${sandboxPostureLabel(entry)} binds host container runtime socket '${entry.bindHost ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyContainerRuntimeSocketMounts`,
        fixHint: "Remove the container runtime socket bind or update policy after review.",
      }),
    );
}

function sandboxContainerUnconfinedProfileFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "denyUnconfinedProfiles"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerSecurityProfile")
    .filter(evidenceFilter)
    .filter(
      (entry) => typeof entry.value === "string" && entry.value.toLowerCase() === "unconfined",
    )
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerUnconfinedProfile,
        message: `${sandboxPostureLabel(entry)} sets container ${entry.profile ?? "security"} profile to unconfined.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyUnconfinedProfiles`,
        fixHint: "Remove the unconfined container profile or update policy after review.",
      }),
    );
}

function sandboxBrowserCdpSourceRangeFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["browser", "requireCdpSourceRange"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "browserCdpSourceRange")
    .filter(evidenceFilter)
    .filter((entry) => entry.value === undefined)
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
        message: `${sandboxPostureLabel(entry)} enables sandbox browser without cdpSourceRange.`,
        requirement: `oc://${policyDocName}/${requirementBase}/browser/requireCdpSourceRange`,
        fixHint: "Set agents.*.sandbox.browser.cdpSourceRange or update policy after review.",
      }),
    );
}

function sandboxPostureEntries(
  evidence: PolicyEvidence,
  kind: PolicySandboxPostureEvidence["kind"],
): readonly PolicySandboxPostureEvidence[] {
  return (evidence.sandboxPosture ?? []).filter((entry) => entry.kind === kind);
}

function sandboxPostureFinding(
  entry: PolicySandboxPostureEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function sandboxPostureLabel(entry: PolicySandboxPostureEvidence): string {
  return entry.agentId === undefined ? "default sandbox config" : `agent '${entry.agentId}'`;
}

const CONTAINER_RUNTIME_SOCKET_BASENAMES = new Set([
  "containerd.sock",
  "docker.sock",
  "podman.sock",
]);

const CONTAINER_RUNTIME_SOCKET_PATHS = new Set([
  "/run/containerd/containerd.sock",
  "/run/docker.sock",
  "/run/podman/podman.sock",
  "/var/run/docker.sock",
  "/var/run/podman/podman.sock",
]);

function bindHostLooksLikeContainerRuntimeSocket(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const basenameLocal = normalized.split("/").at(-1) ?? "";
  return (
    CONTAINER_RUNTIME_SOCKET_PATHS.has(normalized) ||
    CONTAINER_RUNTIME_SOCKET_BASENAMES.has(basenameLocal)
  );
}
