import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import {
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
  type PolicyEvidence,
} from "../policy-state.js";

const CHECK_IDS = {
  policyAttestationMismatch: "policy/attestation-hash-mismatch",
  policyDeniedChannelProvider: "policy/channels-denied-provider",
  policyHashMismatch: "policy/policy-hash-mismatch",
  policyInvalidFile: "policy/policy-jsonc-invalid",
  policyMissingFile: "policy/policy-jsonc-missing",
  policyMissingToolOwner: "policy/tools-missing-owner",
  policyMissingToolRisk: "policy/tools-missing-risk-level",
  policyMissingToolSensitivity: "policy/tools-missing-sensitivity-token",
  policyUnknownToolRisk: "policy/tools-unknown-risk-level",
  policyUnknownToolSensitivity: "policy/tools-unknown-sensitivity-token",
} as const;

export const POLICY_CHECK_IDS = [
  CHECK_IDS.policyMissingFile,
  CHECK_IDS.policyInvalidFile,
  CHECK_IDS.policyHashMismatch,
  CHECK_IDS.policyAttestationMismatch,
  CHECK_IDS.policyDeniedChannelProvider,
  CHECK_IDS.policyMissingToolRisk,
  CHECK_IDS.policyUnknownToolRisk,
  CHECK_IDS.policyMissingToolSensitivity,
  CHECK_IDS.policyMissingToolOwner,
  CHECK_IDS.policyUnknownToolSensitivity,
] as const;

const KNOWN_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
const KNOWN_SENSITIVITY_LEVELS = ["public", "internal", "confidential", "restricted"] as const;
const SUPPORTED_TOOL_METADATA = ["risk", "sensitivity", "owner"] as const;

let registered = false;
const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

export type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

export type PolicyEvaluation = {
  readonly policyPath: string;
  readonly policy?: {
    readonly value: unknown;
    readonly hash: string;
  };
  readonly evidence: PolicyEvidence;
  readonly expectedAttestationHash?: string;
  readonly findings: readonly HealthFinding[];
  readonly attestedFindings: readonly HealthFinding[];
};

export function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void {
  if (registered) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  registerHealthCheck(policyMissingFileCheck);
  registerHealthCheck(policyInvalidFileCheck);
  registerHealthCheck(policyHashMismatchCheck);
  registerHealthCheck(policyAttestationMismatchCheck);
  registerHealthCheck(policyChannelsDeniedProviderCheck);
  registerHealthCheck(policyToolsMissingRiskCheck);
  registerHealthCheck(policyToolsUnknownRiskCheck);
  registerHealthCheck(policyToolsMissingSensitivityCheck);
  registerHealthCheck(policyToolsMissingOwnerCheck);
  registerHealthCheck(policyToolsUnknownSensitivityCheck);
  registered = true;
}

export function resetPolicyDoctorChecksForTest(): void {
  registered = false;
}

export function evaluatePolicy(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const cached = policyEvaluationCache.get(ctx);
  if (cached !== undefined) {
    return cached;
  }
  const next = evaluatePolicyUncached(ctx);
  policyEvaluationCache.set(ctx, next);
  return next;
}

const policyMissingFileCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingFile,
  kind: "plugin",
  description: "The enabled Policy plugin has a policy file to verify.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingFile);
  },
};

const policyHashMismatchCheck: HealthCheck = {
  id: CHECK_IDS.policyHashMismatch,
  kind: "plugin",
  description: "The policy file matches the configured expected hash.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyHashMismatch);
  },
};

const policyAttestationMismatchCheck: HealthCheck = {
  id: CHECK_IDS.policyAttestationMismatch,
  kind: "plugin",
  description: "The current policy check matches the accepted attestation.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAttestationMismatch);
  },
};

const policyInvalidFileCheck: HealthCheck = {
  id: CHECK_IDS.policyInvalidFile,
  kind: "plugin",
  description: "The enabled policy file parses before policy checks run.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyInvalidFile);
  },
};

const policyChannelsDeniedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedChannelProvider,
  kind: "plugin",
  description: "Configured channels satisfy policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
  },
  async repair(ctx, findings) {
    if (!workspaceRepairsEnabled(ctx)) {
      return workspaceRepairsDisabledResult("channel config");
    }
    const channelIds = channelIdsFromFindings(findings);
    if (channelIds.length === 0) {
      return {
        status: "skipped",
        reason: "no channel findings matched a configurable channel",
        changes: [],
      };
    }
    const next = disableChannels(ctx.cfg, channelIds);
    if (next.changed.length === 0) {
      return {
        status: "skipped",
        reason: "matching channels were already disabled or missing",
        changes: [],
      };
    }
    return {
      config: next.config,
      changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`),
    };
  },
};

const policyToolsMissingRiskCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingToolRisk,
  kind: "plugin",
  description: "TOOLS.md policy entries declare explicit risk levels.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolRisk);
  },
};

const policyToolsUnknownRiskCheck: HealthCheck = {
  id: CHECK_IDS.policyUnknownToolRisk,
  kind: "plugin",
  description: "TOOLS.md policy entries use known risk levels.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolRisk);
  },
};

const policyToolsMissingSensitivityCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingToolSensitivity,
  kind: "plugin",
  description: "TOOLS.md policy entries declare default artifact sensitivity.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolSensitivity);
  },
};

const policyToolsUnknownSensitivityCheck: HealthCheck = {
  id: CHECK_IDS.policyUnknownToolSensitivity,
  kind: "plugin",
  description: "TOOLS.md policy entries use known sensitivity levels.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolSensitivity);
  },
};

const policyToolsMissingOwnerCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingToolOwner,
  kind: "plugin",
  description: "TOOLS.md policy entries declare an accountable owner.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolOwner);
  },
};

async function evaluatePolicyUncached(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const settings = policySettings(ctx);
  const policyPath = policyDisplayName(ctx);
  let evidence: PolicyEvidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>);
  const findings: HealthFinding[] = [];

  if (!policyChecksEnabled(ctx, settings)) {
    return {
      policyPath,
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const policyFile = await readPolicyFile(ctx);
  if (policyFile === null) {
    findings.push({
      checkId: CHECK_IDS.policyMissingFile,
      severity: "warning",
      message: `${policyPath} is missing for the enabled Policy plugin.`,
      source: "policy",
      path: policyPath,
      fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`,
    });
    return {
      policyPath,
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const parsedPolicy = parsePolicyFile(policyFile.raw);
  if (!parsedPolicy.ok) {
    findings.push(policyParseFinding(policyFile.displayName, policyFile.ocDocName, parsedPolicy));
    return {
      policyPath,
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const policy = parsedPolicy.value;
  const policyHash = policyDocumentHash(policy);
  const expectedHash = settings.expectedHash;
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    policyHash !== expectedHash.trim()
  ) {
    findings.push({
      checkId: CHECK_IDS.policyHashMismatch,
      severity: "error",
      message: `${policyFile.displayName} does not match the configured policy hash.`,
      source: "policy",
      path: policyFile.displayName,
      target: `oc://${policyFile.ocDocName}`,
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
      fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`,
    });
    return {
      policyPath,
      policy: { value: policy, hash: policyHash },
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const metadataRequirementFindings = toolMetadataRequirementFindings(
    policy,
    policyFile.displayName,
    policyFile.ocDocName,
  );
  const requiredMetadata =
    metadataRequirementFindings.length === 0 ? requiredToolMetadata(policy) : new Set<string>();
  if (requiredMetadata.size > 0) {
    const toolsFile = await readWorkspaceFile(ctx, "TOOLS.md");
    evidence = await collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
      toolsRaw: toolsFile?.raw ?? "",
    });
  }
  const policyFindings: HealthFinding[] = [
    ...policyContainerShapeFindings(policy, policyFile.displayName, policyFile.ocDocName),
    ...channelFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...metadataRequirementFindings,
  ];
  if (requiredMetadata.has("risk")) {
    policyFindings.push(...toolRiskFindings(policyFile.ocDocName, evidence));
    policyFindings.push(...toolUnknownRiskFindings(policyFile.ocDocName, evidence));
  }
  if (requiredMetadata.has("sensitivity")) {
    policyFindings.push(...toolSensitivityFindings(policyFile.ocDocName, evidence));
  }
  if (requiredMetadata.has("owner")) {
    policyFindings.push(...toolOwnerFindings(policyFile.ocDocName, evidence));
  }
  const attestationFindings = policyAttestationFindings(
    policyFile.displayName,
    policyHash,
    evidence,
    policyFindings,
    settings,
  );
  if (hasPolicyValidationFinding(policyFindings)) {
    findings.push(...policyFindings);
  } else if (attestationFindings.length > 0) {
    findings.push(...attestationFindings);
  } else {
    findings.push(...policyFindings);
  }

  return {
    policyPath,
    policy: { value: policy, hash: policyHash },
    evidence,
    expectedAttestationHash: settings.expectedAttestationHash,
    findings,
    attestedFindings: policyFindings,
  };
}

function policyParseFinding(
  policyPath: string,
  policyDocName: string,
  parseError: { readonly message: string },
): HealthFinding {
  return {
    checkId: CHECK_IDS.policyInvalidFile,
    severity: "error",
    message: `${policyPath} could not be parsed: ${parseError.message}`,
    source: "policy",
    path: policyPath,
    target: `oc://${policyDocName}`,
    fixHint: `Fix ${policyPath} so policy conformance checks can run.`,
  };
}

function findingsForCheck(
  evaluation: PolicyEvaluation,
  checkId: (typeof POLICY_CHECK_IDS)[number],
): readonly HealthFinding[] {
  return evaluation.findings.filter((finding) => finding.checkId === checkId);
}

function hasPolicyValidationFinding(findings: readonly HealthFinding[]): boolean {
  return findings.some((finding) => finding.checkId === CHECK_IDS.policyInvalidFile);
}

function channelFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const invalidRules = invalidChannelDenyRuleFindings(policy, policyPath, policyDocName);
  if (invalidRules.length > 0) {
    return invalidRules;
  }
  const denyRules = readChannelDenyRules(policy, policyDocName);
  if (denyRules.length === 0) {
    return [];
  }
  return evidence.channels.flatMap((channel): HealthFinding[] => {
    if (channel.enabled === false) {
      return [];
    }
    const rule = denyRules.find((candidate) => candidate.when?.provider === channel.provider);
    if (rule === undefined) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyDeniedChannelProvider,
        severity: "error",
        message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: channel.source,
        target: channel.source,
        requirement: rule.requirement,
        fixHint:
          rule.reason ??
          "Disable this channel, remove it from config, or update the policy deny rule.",
      },
    ];
  });
}

function policyAttestationFindings(
  policyPath: string,
  policyHash: string,
  evidence: PolicyEvidence,
  findings: readonly HealthFinding[],
  settings: PolicySettings,
): readonly HealthFinding[] {
  const expected = settings.expectedAttestationHash?.trim();
  if (!expected) {
    return [];
  }
  const current = createPolicyAttestation({
    ok: findings.length === 0,
    checkedAt: new Date(0).toISOString(),
    policyPath,
    policyHash,
    evidence,
    findings: findings.map(toAttestedFinding),
  });
  if (current.attestationHash === expected) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyAttestationMismatch,
      severity: "error",
      message: "The current policy check no longer matches the accepted policy attestation.",
      source: "policy",
      path: "policy attestation",
      target: "oc://policy/attestation/current",
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedAttestationHash",
      fixHint: `Run policy check, review attestation ${current.attestationHash}, then update plugins.entries.policy.config.expectedAttestationHash and the supervisor/gateway accepted attestation.`,
    },
  ];
}

function toAttestedFinding(finding: HealthFinding): Record<string, unknown> {
  return {
    checkId: finding.checkId,
    severity: finding.severity,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.column !== undefined ? { column: finding.column } : {}),
    ...(finding.ocPath !== undefined ? { ocPath: finding.ocPath } : {}),
    ...(finding.target !== undefined ? { target: finding.target } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
  };
}

function toolMetadataRequirementFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.tools) || policy.tools.requireMetadata === undefined) {
    return [];
  }
  if (!Array.isArray(policy.tools.requireMetadata)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} tools.requireMetadata must be an array of metadata keys.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use supported metadata keys: ${SUPPORTED_TOOL_METADATA.join(", ")}.`,
      },
    ];
  }
  const invalidIndex = policy.tools.requireMetadata.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_TOOL_METADATA.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_TOOL_METADATA)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} tools.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/tools/requireMetadata/#${invalidIndex}`,
      fixHint: `Use supported metadata keys: ${SUPPORTED_TOOL_METADATA.join(", ")}.`,
    },
  ];
}

function policyContainerShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}`,
        `${policyPath} must contain a policy object.`,
        `Fix ${policyPath} so the top-level policy is an object.`,
      ),
    ];
  }
  if (policy.tools !== undefined && !isRecord(policy.tools)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/tools`,
        `${policyPath} tools must be an object.`,
        `Fix ${policyPath} so tools is an object.`,
      ),
    ];
  }
  if (isRecord(policy.tools)) {
    if (policy.tools.settings !== undefined && !isRecord(policy.tools.settings)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/tools/settings`,
          `${policyPath} tools.settings must be an object.`,
          `Fix ${policyPath} so tools.settings is an object.`,
        ),
      ];
    }
    if (policy.tools.entries !== undefined && !Array.isArray(policy.tools.entries)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/tools/entries`,
          `${policyPath} tools.entries must be an array.`,
          `Fix ${policyPath} so tools.entries is an array.`,
        ),
      ];
    }
  }
  if (policy.channels !== undefined && !isRecord(policy.channels)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/channels`,
        `${policyPath} channels must be an object.`,
        `Fix ${policyPath} so channels is an object.`,
      ),
    ];
  }
  return [];
}

function policyShapeFinding(
  policyPath: string,
  target: string,
  message: string,
  fixHint: string,
): HealthFinding {
  return {
    checkId: CHECK_IDS.policyInvalidFile,
    severity: "error",
    message,
    source: "policy",
    path: policyPath,
    target,
    fixHint,
  };
}

function invalidChannelDenyRuleFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.channels) || policy.channels.denyRules === undefined) {
    return [];
  }
  if (!Array.isArray(policy.channels.denyRules)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} channels.denyRules must be an array.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/channels/denyRules`,
        fixHint: `Fix ${policyPath} so channel deny rules are an array.`,
      },
    ];
  }
  const invalid = policy.channels.denyRules.findIndex((rule) => !isChannelDenyRule(rule));
  if (invalid < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} channels.denyRules[${invalid}] must define when.provider as a string.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/channels/denyRules/#${invalid}`,
      fixHint: `Fix ${policyPath} so each channel deny rule has a provider match.`,
    },
  ];
}

function toolRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.risk === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no explicit risk classification.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint:
          "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias.",
      };
    });
}

function toolUnknownRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter(
      (tool) =>
        tool.risk !== undefined &&
        !KNOWN_RISK_LEVELS.includes(tool.risk as (typeof KNOWN_RISK_LEVELS)[number]),
    )
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyUnknownToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown risk '${tool.risk}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use one of: ${KNOWN_RISK_LEVELS.join(", ")}.`,
      };
    });
}

function toolSensitivityFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? []).flatMap((tool): HealthFinding[] => {
    if (tool.sensitivity === undefined) {
      return [
        {
          checkId: CHECK_IDS.policyMissingToolSensitivity,
          severity: "error",
          message: `TOOLS.md tool '${tool.id}' has no declared artifact sensitivity.`,
          source: "policy",
          path: "TOOLS.md",
          line: tool.line,
          ocPath: tool.source,
          target: tool.source,
          requirement: `oc://${policyDocName}/tools/requireMetadata`,
          fixHint: `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
        },
      ];
    }
    if (
      KNOWN_SENSITIVITY_LEVELS.includes(
        tool.sensitivity as (typeof KNOWN_SENSITIVITY_LEVELS)[number],
      )
    ) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyUnknownToolSensitivity,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
      },
    ];
  });
}

function toolOwnerFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.owner === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolOwner,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no declared owner.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: "Declare owner:<team-or-person> for this tool.",
      };
    });
}

async function readPolicyFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const displayName = policyDisplayName(ctx);
  const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
  try {
    const fs = await import("node:fs/promises");
    return {
      raw: await fs.readFile(path, "utf-8"),
      path,
      displayName,
      ocDocName: basename(displayName),
    };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function readWorkspaceFile(
  ctx: HealthCheckContext,
  fileName: string,
): Promise<{ raw: string; path: string } | null> {
  const path = resolveWorkspacePath(ctx, fileName);
  try {
    const fs = await import("node:fs/promises");
    return { raw: await fs.readFile(path, "utf-8"), path };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

function resolveWorkspacePath(ctx: HealthCheckContext, fileName: string): string {
  if (isAbsolute(fileName)) {
    return fileName;
  }
  return resolve(ctx.cwd ?? process.cwd(), fileName);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function parsePolicyFile(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON5.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function workspaceRepairsEnabled(ctx: HealthCheckContext): boolean {
  return policySettings(ctx).workspaceRepairs === true;
}

function workspaceRepairsDisabledResult(fileName: string): {
  readonly status: "skipped";
  readonly reason: string;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
} {
  const reason = "workspace repairs are disabled";
  return {
    status: "skipped",
    reason,
    changes: [],
    warnings: [
      `Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`,
    ],
  };
}

function readChannelDenyRules(
  policy: unknown,
  policyDocName: string,
): readonly {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
  readonly requirement: string;
}[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.channels) ||
    !Array.isArray(policy.channels.denyRules)
  ) {
    return [];
  }
  return policy.channels.denyRules
    .map((rule, index) => ({ rule, index }))
    .filter(
      (
        entry,
      ): entry is {
        readonly index: number;
        readonly rule: {
          readonly id?: string;
          readonly when?: { readonly provider?: string };
          readonly reason?: string;
        };
      } => isChannelDenyRule(entry.rule),
    )
    .map(({ rule, index }) => {
      const next: {
        id?: string;
        when?: { readonly provider?: string };
        reason?: string;
        requirement: string;
      } = {
        when: rule.when,
        requirement: `oc://${policyDocName}/channels/denyRules/#${index}`,
      };
      if (rule.id !== undefined) {
        next.id = rule.id;
      }
      if (rule.reason !== undefined) {
        next.reason = rule.reason;
      }
      return next;
    });
}

function isChannelDenyRule(value: unknown): value is {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
} {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    isRecord(value.when) &&
    typeof value.when.provider === "string"
  );
}

function channelIdsFromFindings(findings: readonly HealthFinding[]): readonly string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider)
        .map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1])
        .filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

function disableChannels(
  cfg: HealthCheckContext["cfg"],
  channelIds: readonly string[],
): { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] } {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changed: [] };
  }
  const channels: Record<string, unknown> = { ...cfg.channels };
  const changed: string[] = [];
  for (const id of channelIds) {
    const current = channels[id];
    if (!isRecord(current) || current.enabled === false) {
      continue;
    }
    channels[id] = { ...current, enabled: false };
    changed.push(id);
  }
  if (changed.length === 0) {
    return { config: cfg, changed };
  }
  return { config: { ...cfg, channels }, changed };
}

type PolicySettings = {
  readonly enabled?: boolean;
  readonly workspaceRepairs?: boolean;
  readonly expectedHash?: string;
  readonly expectedAttestationHash?: string;
  readonly path?: string;
};

function policySettings(ctx: HealthCheckContext): PolicySettings {
  const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
  if (!isRecord(pluginConfig)) {
    return {};
  }
  return pluginConfig;
}

function policyChecksEnabled(ctx: HealthCheckContext, settings: PolicySettings): boolean {
  const entry = ctx.cfg.plugins?.entries?.["policy"];
  if (!isRecord(entry) || entry.enabled === false) {
    return false;
  }
  return settings.enabled !== false;
}

function requiredToolMetadata(policy: unknown): ReadonlySet<string> {
  return new Set(readPolicyStringArray(policy, ["tools", "requireMetadata"]) ?? []);
}

function readPolicyStringArray(
  policy: unknown,
  path: readonly string[],
): readonly string[] | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return current.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
function policyPathSetting(ctx: HealthCheckContext): string {
  const configured = policySettings(ctx).path;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : "policy.jsonc";
}

function policyDisplayName(ctx: HealthCheckContext): string {
  const configured = policyPathSetting(ctx);
  return isAbsolute(configured) ? basename(configured) : configured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
