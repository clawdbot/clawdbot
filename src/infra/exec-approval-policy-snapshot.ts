// Canonicalizes the portable policy snapshot carried with delayed exec approvals.
type ExecApprovalPolicyRule = {
  pattern: string;
  argPattern?: string;
  source?: "allow-always";
};

export type ExecApprovalPolicySnapshot = {
  security: "deny" | "allowlist" | "full";
  ask: "off" | "on-miss" | "always";
  askFallback: "deny" | "allowlist" | "full";
  autoAllowSkills: boolean;
  allowlistRules: readonly ExecApprovalPolicyRule[];
};

const utf8Encoder = new TextEncoder();

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function compareOptionalUtf8(left: string | undefined, right: string | undefined): number {
  if (left === undefined) {
    return right === undefined ? 0 : -1;
  }
  if (right === undefined) {
    return 1;
  }
  return compareUtf8(left, right);
}

/** Cross-runtime order: tuple fields, absent before present, UTF-8 byte lexicographic. */
function compareExecApprovalPolicyRules(
  left: ExecApprovalPolicyRule,
  right: ExecApprovalPolicyRule,
): number {
  return (
    compareUtf8(left.pattern, right.pattern) ||
    compareOptionalUtf8(left.argPattern, right.argPattern) ||
    compareOptionalUtf8(left.source, right.source)
  );
}

function buildExecApprovalPolicyRuleKey(rule: ExecApprovalPolicyRule): string {
  return JSON.stringify([rule.pattern, rule.argPattern ?? null, rule.source ?? null]);
}

export function canonicalizeExecApprovalPolicyRules(
  rules: readonly ExecApprovalPolicyRule[],
): ExecApprovalPolicyRule[] {
  const rulesByKey = new Map(rules.map((rule) => [buildExecApprovalPolicyRuleKey(rule), rule]));
  return [...rulesByKey.values()].toSorted(compareExecApprovalPolicyRules);
}

export function normalizeExecApprovalPolicySnapshot(
  value: unknown,
): ExecApprovalPolicySnapshot | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const security = candidate.security;
  const ask = candidate.ask;
  const askFallback = candidate.askFallback;
  const autoAllowSkills = candidate.autoAllowSkills;
  const allowlistRules = candidate.allowlistRules;
  if (
    (security !== "deny" && security !== "allowlist" && security !== "full") ||
    (ask !== "off" && ask !== "on-miss" && ask !== "always") ||
    (askFallback !== "deny" && askFallback !== "allowlist" && askFallback !== "full") ||
    typeof autoAllowSkills !== "boolean" ||
    !Array.isArray(allowlistRules)
  ) {
    return null;
  }
  const normalizedRules: ExecApprovalPolicyRule[] = [];
  for (const rawRule of allowlistRules) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      return null;
    }
    const rule = rawRule as Record<string, unknown>;
    if (
      typeof rule.pattern !== "string" ||
      (rule.argPattern !== undefined && typeof rule.argPattern !== "string") ||
      (rule.source !== undefined && rule.source !== "allow-always")
    ) {
      return null;
    }
    normalizedRules.push({
      pattern: rule.pattern,
      ...(typeof rule.argPattern === "string" ? { argPattern: rule.argPattern } : {}),
      ...(rule.source === "allow-always" ? { source: rule.source } : {}),
    });
  }
  return {
    security,
    ask,
    askFallback,
    autoAllowSkills,
    allowlistRules: canonicalizeExecApprovalPolicyRules(normalizedRules),
  };
}
