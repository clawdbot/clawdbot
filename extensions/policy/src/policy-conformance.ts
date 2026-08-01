// Policy plugin module implements policy conformance behavior.
import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isPolicyValueAtLeastAsStrict,
  policyContainerShapeFindings,
  POLICY_RULE_METADATA as RAW_POLICY_RULE_METADATA,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./doctor/register.js";
import { getPolicyPath, scopedPolicyValue } from "./policy-value.js";

const POLICY_CONFORMANCE_CHECK_IDS = {
  missing: "policy/policy-conformance-missing",
  weaker: "policy/policy-conformance-weaker",
  invalid: "policy/policy-conformance-invalid",
} as const;

type PolicyConformanceFinding = {
  readonly checkId: (typeof POLICY_CONFORMANCE_CHECK_IDS)[keyof typeof POLICY_CONFORMANCE_CHECK_IDS];
  readonly severity: "error";
  readonly message: string;
  readonly source: "policy";
  readonly path: string;
  readonly target: string;
  readonly requirement: string;
  readonly fixHint: string;
};

export type PolicyConformanceReport = {
  readonly ok: boolean;
  readonly baselinePath: string;
  readonly policyPath: string;
  readonly rulesChecked: number;
  readonly findings: readonly PolicyConformanceFinding[];
};

type PolicyDocument = {
  readonly displayName: string;
  readonly value: unknown;
};

type PolicyDocumentReadResult =
  | { readonly ok: true; readonly displayName: string; readonly document: PolicyDocument }
  | {
      readonly ok: false;
      readonly displayName: string;
      readonly message: string;
      readonly target: string;
    };

type PolicyRuleClaim = {
  readonly key: string;
  readonly metadata: PolicyRuleMetadata;
  readonly value: unknown;
  readonly target: string;
  readonly propertyPath: string;
  readonly selector?: {
    readonly kind: PolicyScopeSelectorKind;
    readonly value: string;
  };
};

const POLICY_RULE_METADATA: readonly PolicyRuleMetadata[] = RAW_POLICY_RULE_METADATA;

export async function buildPolicyConformanceReport(params: {
  readonly baselinePath: string;
  readonly policyPath: string;
  readonly cwd?: string;
}): Promise<PolicyConformanceReport> {
  const baselinePath = resolvePolicyPath(params.baselinePath, params.cwd);
  const policyPath = resolvePolicyPath(params.policyPath, params.cwd);
  const baselineResult = await readPolicyDocument(baselinePath);
  const policyResult = await readPolicyDocument(policyPath);
  if (!baselineResult.ok || !policyResult.ok) {
    const invalidFindings = [baselineResult, policyResult]
      .filter((result): result is Extract<PolicyDocumentReadResult, { readonly ok: false }> => {
        return !result.ok;
      })
      .map((result) => invalidParseConformanceFinding(result));
    return {
      ok: false,
      baselinePath: baselineResult.displayName,
      policyPath: policyResult.displayName,
      rulesChecked: 0,
      findings: invalidFindings,
    };
  }
  const baseline = baselineResult.document;
  const policy = policyResult.document;
  const baselineClaims = collectPolicyRuleClaims(baseline);
  const candidateClaims = collectPolicyRuleClaims(policy);
  const invalidFindings = uniqueConformanceFindings([
    ...policyContainerShapeFindings(baseline.value, baseline.displayName, baseline.displayName).map(
      (finding) => invalidShapeConformanceFinding(finding, baseline.displayName),
    ),
    ...policyContainerShapeFindings(policy.value, policy.displayName, policy.displayName).map(
      (finding) => invalidShapeConformanceFinding(finding, policy.displayName),
    ),
    ...collectInvalidScopedPolicyFindings(baseline),
    ...collectInvalidScopedPolicyFindings(policy),
    ...baselineClaims
      .filter((claim) => !policyRuleValueIsValid(claim.metadata, claim.value))
      .map((claim) => invalidConformanceFinding(claim, baseline.displayName)),
    ...candidateClaims
      .filter((claim) => !policyRuleValueIsValid(claim.metadata, claim.value))
      .map((claim) => invalidConformanceFinding(claim, policy.displayName)),
  ]);
  const validBaselineClaims = baselineClaims.filter((claim) =>
    policyRuleValueIsValid(claim.metadata, claim.value),
  );
  const validCandidateClaims = candidateClaims.filter((claim) =>
    policyRuleValueIsValid(claim.metadata, claim.value),
  );
  if (invalidFindings.length > 0) {
    return {
      ok: false,
      baselinePath: baseline.displayName,
      policyPath: policy.displayName,
      rulesChecked: 0,
      findings: invalidFindings,
    };
  }
  const findings = validBaselineClaims
    .map((claim) => conformanceFinding(claim, validCandidateClaims, policy.displayName))
    .filter((finding): finding is PolicyConformanceFinding => finding !== undefined);
  return {
    ok: invalidFindings.length === 0 && findings.length === 0,
    baselinePath: baseline.displayName,
    policyPath: policy.displayName,
    rulesChecked: validBaselineClaims.length,
    findings: [...invalidFindings, ...findings],
  };
}

function uniqueConformanceFindings(
  findings: readonly PolicyConformanceFinding[],
): readonly PolicyConformanceFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.checkId}\n${finding.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function invalidParseConformanceFinding(
  result: Extract<PolicyDocumentReadResult, { readonly ok: false }>,
): PolicyConformanceFinding {
  return {
    checkId: POLICY_CONFORMANCE_CHECK_IDS.invalid,
    severity: "error",
    message: result.message,
    source: "policy",
    path: result.displayName,
    target: result.target,
    requirement: result.target,
    fixHint: `Fix ${result.displayName} so it contains valid policy JSONC.`,
  };
}

function invalidShapeConformanceFinding(
  finding: HealthFinding,
  displayName: string,
): PolicyConformanceFinding {
  const target = finding.target ?? `oc://${displayName}`;
  return {
    checkId: POLICY_CONFORMANCE_CHECK_IDS.invalid,
    severity: "error",
    message: finding.message,
    source: "policy",
    path: displayName,
    target,
    requirement: target,
    fixHint: finding.fixHint ?? `Fix ${displayName} so it uses the documented policy syntax.`,
  };
}

function collectInvalidScopedPolicyFindings(
  document: PolicyDocument,
): readonly PolicyConformanceFinding[] {
  if (!isRecord(document.value) || document.value.scopes === undefined) {
    return [];
  }
  if (!isRecord(document.value.scopes)) {
    return [
      invalidConformancePathFinding({
        displayName: document.displayName,
        message: `${document.displayName} scopes must be an object.`,
        propertyPath: "scopes",
        target: `oc://${document.displayName}/scopes`,
      }),
    ];
  }
  const findings: PolicyConformanceFinding[] = [];
  for (const [scopeName, overlay] of Object.entries(document.value.scopes)) {
    const scopePath = `scopes.${scopeName}`;
    const scopeTarget = `oc://${document.displayName}/scopes/${ocPathSegment(scopeName)}`;
    if (!isRecord(overlay)) {
      findings.push(
        invalidConformancePathFinding({
          displayName: document.displayName,
          message: `${document.displayName} ${scopePath} must be an object.`,
          propertyPath: scopePath,
          target: scopeTarget,
        }),
      );
      continue;
    }
    for (const metadata of POLICY_RULE_METADATA) {
      const value = scopedPolicyValue(overlay, metadata.policyPath);
      if (value === undefined) {
        continue;
      }
      const selectorMatches = (metadata.scopeSelectors ?? []).some(
        (selector) => normalizeSelectorValues(overlay[selector], selector).length > 0,
      );
      if (selectorMatches) {
        continue;
      }
      const propertyPath = `${scopePath}.${metadata.policyPath.join(".")}`;
      findings.push(
        invalidConformancePathFinding({
          displayName: document.displayName,
          message: `${document.displayName} ${propertyPath} needs a valid selector for policy conformance.`,
          propertyPath,
          target: `${scopeTarget}/${metadata.policyPath.map(ocPathSegment).join("/")}`,
        }),
      );
    }
  }
  return findings;
}

function invalidConformanceFinding(
  claim: PolicyRuleClaim,
  displayName: string,
): PolicyConformanceFinding {
  return invalidConformancePathFinding({
    displayName,
    message: `${displayName} ${claim.propertyPath} is not valid policy conformance syntax.`,
    propertyPath: claim.propertyPath,
    target: claim.target,
  });
}

function invalidConformancePathFinding(params: {
  readonly displayName: string;
  readonly message: string;
  readonly propertyPath: string;
  readonly target: string;
}): PolicyConformanceFinding {
  return {
    checkId: POLICY_CONFORMANCE_CHECK_IDS.invalid,
    severity: "error",
    message: params.message,
    source: "policy",
    path: params.displayName,
    target: params.target,
    requirement: params.target,
    fixHint: `Fix ${params.propertyPath} so it uses the documented policy syntax.`,
  };
}

function conformanceFinding(
  baseline: PolicyRuleClaim,
  candidateClaims: readonly PolicyRuleClaim[],
  policyDisplayName: string,
): PolicyConformanceFinding | undefined {
  if (baselineRuleIsNoOp(baseline.metadata, baseline.value)) {
    return undefined;
  }
  if (baseline.selector === undefined) {
    const globalCandidates = candidateClaims.filter((candidate) => candidate.key === baseline.key);
    if (globalCandidates.length === 0) {
      return missingConformanceFinding(baseline, policyDisplayName);
    }
    const weakerGlobal = globalCandidates.find(
      (candidate) =>
        !isPolicyValueAtLeastAsStrict(baseline.metadata, candidate.value, baseline.value),
    );
    if (weakerGlobal !== undefined) {
      return weakerConformanceFinding(baseline, policyDisplayName, weakerGlobal);
    }
    const weakerScopedOverride = candidateClaims.find(
      (candidate) =>
        candidate.selector !== undefined &&
        candidate.metadata.policyPath.join(".") === baseline.metadata.policyPath.join(".") &&
        !isPolicyValueAtLeastAsStrict(baseline.metadata, candidate.value, baseline.value),
    );
    if (weakerScopedOverride !== undefined) {
      return weakerConformanceFinding(baseline, policyDisplayName, weakerScopedOverride);
    }
    return undefined;
  }

  const exactCandidates = candidateClaims.filter((candidate) => candidate.key === baseline.key);
  const candidates =
    exactCandidates.length > 0
      ? exactCandidates
      : candidateClaims.filter((candidate) => globallySatisfiesScopedClaim(candidate, baseline));
  const weakerCandidate = candidates.find(
    (candidate) =>
      !isPolicyValueAtLeastAsStrict(baseline.metadata, candidate.value, baseline.value),
  );
  const matching = candidates.some((candidate) =>
    isPolicyValueAtLeastAsStrict(baseline.metadata, candidate.value, baseline.value),
  );
  if (matching && (exactCandidates.length === 0 || weakerCandidate === undefined)) {
    return undefined;
  }
  if (candidates.length === 0) {
    return missingConformanceFinding(baseline, policyDisplayName);
  }
  return weakerConformanceFinding(baseline, policyDisplayName, weakerCandidate ?? candidates[0]);
}

function baselineRuleIsNoOp(metadata: PolicyRuleMetadata, baseline: unknown): boolean {
  switch (metadata.strictness) {
    case "allowlist-subset":
      return metadata.emptyList === "disabled" && policyRuleListIsEmpty(baseline, metadata);
    case "denylist-superset":
      return policyRuleListIsEmpty(baseline, metadata);
    case "requires-true":
      return baseline !== true;
    case "requires-false":
      return baseline !== false;
    case "exact-list":
    case "ordered-string":
      return false;
    case "routing-probes":
      return policyRuleListIsEmpty(baseline, metadata);
  }
  return false;
}

function policyRuleValueIsValid(metadata: PolicyRuleMetadata, value: unknown): boolean {
  switch (metadata.valueType) {
    case "boolean":
      return typeof value === "boolean";
    case "channel-provider-deny-rules":
      return (
        Array.isArray(value) &&
        value.every((entry) => {
          if (!isRecord(entry)) {
            return false;
          }
          const when = entry.when;
          return isRecord(when) && typeof when.provider === "string" && when.provider.trim() !== "";
        })
      );
    case "string":
      return typeof value === "string" && policyStringIsAllowed(metadata, value);
    case "string-list":
      if (!Array.isArray(value)) {
        return false;
      }
      if (isExecApprovalAllowlistExpectedRule(metadata)) {
        return value.every(isExecApprovalAllowlistRequirement);
      }
      return value.every(
        (entry) =>
          typeof entry === "string" &&
          entry.trim() !== "" &&
          policyStringIsAllowed(metadata, entry),
      );
    case "routing-probes":
      return Array.isArray(value);
  }
  return false;
}

function isExecApprovalAllowlistExpectedRule(metadata: PolicyRuleMetadata): boolean {
  return metadata.policyPath.join(".") === "execApprovals.agents.allowlist.expected";
}

function unsupportedPolicyKey(
  value: Record<string, unknown>,
  supported: readonly string[],
): string | undefined {
  return Object.keys(value).find((key) => !supported.includes(key));
}

function isExecApprovalAllowlistRequirement(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (!isRecord(value)) {
    return false;
  }
  if (unsupportedPolicyKey(value, ["argPattern", "pattern"]) !== undefined) {
    return false;
  }
  if (typeof value.pattern !== "string" || value.pattern.trim() === "") {
    return false;
  }
  return value.argPattern === undefined || typeof value.argPattern === "string";
}

function policyStringIsAllowed(metadata: PolicyRuleMetadata, value: string): boolean {
  const normalized = metadata.caseSensitive === true ? value.trim() : value.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }
  if (metadata.allowedValues !== undefined) {
    const allowed = metadata.allowedValues.map((entry) =>
      metadata.caseSensitive === true ? entry : entry.toLowerCase(),
    );
    return allowed.includes(normalized);
  }
  if (metadata.orderedValues === undefined) {
    return true;
  }
  const allowed = metadata.orderedValues.map((entry) =>
    metadata.caseSensitive === true ? entry : entry.toLowerCase(),
  );
  return allowed.includes(normalized);
}

function policyRuleListIsEmpty(value: unknown, metadata: PolicyRuleMetadata): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  if (metadata.valueType === "channel-provider-deny-rules") {
    return value.length === 0;
  }
  if (metadata.valueType === "routing-probes") {
    return value.length === 0;
  }
  return value.length === 0;
}

function missingConformanceFinding(
  baseline: PolicyRuleClaim,
  policyDisplayName: string,
): PolicyConformanceFinding {
  return {
    checkId: POLICY_CONFORMANCE_CHECK_IDS.missing,
    severity: "error",
    message: `${policyDisplayName} is missing ${baseline.propertyPath}.`,
    source: "policy",
    path: policyDisplayName,
    target: `oc://${policyDisplayName}/${baseline.propertyPath.replaceAll(".", "/")}`,
    requirement: baseline.target,
    fixHint: `Add an equally or more restrictive ${baseline.propertyPath} rule, or update the baseline policy after review.`,
  };
}

function weakerConformanceFinding(
  baseline: PolicyRuleClaim,
  policyDisplayName: string,
  candidate: PolicyRuleClaim | undefined,
): PolicyConformanceFinding {
  return {
    checkId: POLICY_CONFORMANCE_CHECK_IDS.weaker,
    severity: "error",
    message: `${policyDisplayName} ${baseline.propertyPath} is weaker than the baseline policy.`,
    source: "policy",
    path: policyDisplayName,
    target: candidate?.target ?? `oc://${policyDisplayName}`,
    requirement: baseline.target,
    fixHint: `Use an equally or more restrictive ${baseline.propertyPath} value, or update the baseline policy after review.`,
  };
}

function globallySatisfiesScopedClaim(
  candidate: PolicyRuleClaim,
  baseline: PolicyRuleClaim,
): boolean {
  return (
    baseline.selector !== undefined &&
    candidate.selector === undefined &&
    candidate.metadata.policyPath.join(".") === baseline.metadata.policyPath.join(".")
  );
}

function collectPolicyRuleClaims(document: PolicyDocument): readonly PolicyRuleClaim[] {
  return [...collectTopLevelPolicyRuleClaims(document), ...collectScopedPolicyRuleClaims(document)];
}

function collectTopLevelPolicyRuleClaims(document: PolicyDocument): readonly PolicyRuleClaim[] {
  const claims: PolicyRuleClaim[] = [];
  for (const metadata of POLICY_RULE_METADATA) {
    const value = getPolicyPath(document.value, metadata.policyPath);
    if (value === undefined) {
      continue;
    }
    const propertyPath = metadata.policyPath.join(".");
    claims.push({
      key: `global:${propertyPath}`,
      metadata,
      value,
      target: `oc://${document.displayName}/${metadata.policyPath.map(ocPathSegment).join("/")}`,
      propertyPath,
    });
  }
  return claims;
}

function collectScopedPolicyRuleClaims(document: PolicyDocument): readonly PolicyRuleClaim[] {
  if (!isRecord(document.value) || !isRecord(document.value.scopes)) {
    return [];
  }
  const claims: PolicyRuleClaim[] = [];
  for (const [scopeName, overlay] of Object.entries(document.value.scopes)) {
    if (!isRecord(overlay)) {
      continue;
    }
    for (const selector of ["agentIds", "channelIds"] as const) {
      const selectorValues = normalizeSelectorValues(overlay[selector], selector);
      if (selectorValues.length === 0) {
        continue;
      }
      const rules = POLICY_RULE_METADATA.filter(
        (metadata) => metadata.scopeSelectors?.includes(selector) === true,
      );
      for (const metadata of rules) {
        const value = scopedPolicyValue(overlay, metadata.policyPath);
        if (value === undefined) {
          continue;
        }
        const propertyPath = metadata.policyPath.join(".");
        const targetPath = [
          "scopes",
          ocPathSegment(scopeName),
          ...metadata.policyPath.map(ocPathSegment),
        ].join("/");
        for (const selectorValue of selectorValues) {
          claims.push({
            key: `${selector}:${selectorValue}:${propertyPath}`,
            metadata,
            value,
            target: `oc://${document.displayName}/${targetPath}`,
            propertyPath: `scopes.${scopeName}.${propertyPath}`,
            selector: { kind: selector, value: selectorValue },
          });
        }
      }
    }
  }
  return coalesceScopedPolicyRuleClaims(claims);
}

function coalesceScopedPolicyRuleClaims(
  claims: readonly PolicyRuleClaim[],
): readonly PolicyRuleClaim[] {
  const byKey = new Map<string, PolicyRuleClaim>();
  for (const claim of claims) {
    const previous = byKey.get(claim.key);
    if (
      previous !== undefined &&
      isPolicyValueAtLeastAsStrict(previous.metadata, claim.value, previous.value)
    ) {
      byKey.set(claim.key, claim);
      continue;
    }
    byKey.set(claim.key, previous ?? claim);
  }
  return [...byKey.values()];
}

function normalizeSelectorValues(
  value: unknown,
  selector: PolicyScopeSelectorKind,
): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) =>
      selector === "agentIds" ? normalizeAgentId(entry) : entry.trim().toLowerCase(),
    );
}

async function readPolicyDocument(path: string): Promise<PolicyDocumentReadResult> {
  const displayName = basename(path);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      displayName,
      message: `${displayName} could not be read: ${message}`,
      target: `oc://${displayName}`,
    };
  }
  try {
    return { ok: true, displayName, document: { displayName, value: JSON5.parse(raw) } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      displayName,
      message: `${displayName} could not be parsed: ${message}`,
      target: `oc://${displayName}`,
    };
  }
}

function resolvePolicyPath(path: string, cwd: string | undefined): string {
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
