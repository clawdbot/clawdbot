import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
/**
 * Tool policy audit logging helpers.
 * Emits bounded, sanitized logs when allow/deny policy filters remove tools or
 * block sandbox tool execution.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SandboxConfig } from "./sandbox/types.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import { normalizeToolList, normalizeToolPolicyName, type ToolPolicyLike } from "./tool-policy.js";

// Emits bounded audit logs when tool allow/deny policies remove or block tools.
// Sanitizing here keeps logs single-line and safe for arbitrary tool names.
const MAX_AUDIT_TOOL_NAMES = 50;
const MAX_AUDIT_FIELD_LENGTH = 160;
const toolPolicyAuditLogger = createSubsystemLogger("agents/tool-policy");

type ToolPolicyRuleKind = "allow" | "deny" | "allow+deny" | "unknown";

function toolPolicyRuleKind(policy: ToolPolicyLike): ToolPolicyRuleKind {
  const hasAllow = Array.isArray(policy.allow) && policy.allow.length > 0;
  const hasDeny = Array.isArray(policy.deny) && policy.deny.length > 0;
  if (hasAllow && hasDeny) {
    return "allow+deny";
  }
  if (hasDeny) {
    return "deny";
  }
  if (hasAllow) {
    return "allow";
  }
  return "unknown";
}

function normalizedToolNames(tools: readonly { name: string }[]): string[] {
  return normalizeToolList(tools.map((tool) => tool.name));
}

function removedToolNamesByRule(params: {
  policy: ToolPolicyLike;
  before: readonly { name: string }[];
  after: readonly { name: string }[];
}): Map<ToolPolicyRuleKind, string[]> {
  const remainingCounts = new Map<string, number>();
  for (const name of normalizedToolNames(params.after)) {
    remainingCounts.set(name, (remainingCounts.get(name) ?? 0) + 1);
  }

  let matchesDeny: ReturnType<typeof createToolPolicyMatcher> | undefined;
  const fallbackRuleKind =
    Array.isArray(params.policy.allow) && params.policy.allow.length > 0
      ? "allow"
      : toolPolicyRuleKind(params.policy);
  const removed = new Map<ToolPolicyRuleKind, Set<string>>();
  for (const name of normalizedToolNames(params.before)) {
    const remaining = remainingCounts.get(name) ?? 0;
    if (remaining > 0) {
      remainingCounts.set(name, remaining - 1);
      continue;
    }
    matchesDeny ??= createToolPolicyMatcher({
      deny: Array.isArray(params.policy.deny) ? params.policy.deny : undefined,
    });
    const ruleKind = matchesDeny(name) ? fallbackRuleKind : "deny";
    const names = removed.get(ruleKind) ?? new Set<string>();
    names.add(name);
    removed.set(ruleKind, names);
  }
  return new Map([...removed].map(([ruleKind, names]) => [ruleKind, [...names].toSorted()]));
}

function createMatchedPolicyRuleForTool(policy: ToolPolicyLike, ruleKind: ToolPolicyRuleKind) {
  const rules = ruleKind === "deny" && Array.isArray(policy.deny) ? policy.deny : [];
  const matchers: ReturnType<typeof createToolPolicyMatcher>[] = [];
  return (toolName: string) =>
    rules.find(
      (entry, index) => !(matchers[index] ??= createToolPolicyMatcher({ deny: [entry] }))(toolName),
    );
}

function labelForRuleKind(stepLabel: string, ruleKind: ToolPolicyRuleKind): string {
  if (ruleKind !== "deny") {
    return stepLabel;
  }
  if (stepLabel.includes(".allow")) {
    return stepLabel.replaceAll(".allow", ".deny");
  }
  if (/\ballow\b/u.test(stepLabel)) {
    return stepLabel.replace(/\ballow\b/u, "deny");
  }
  return `${stepLabel}.deny`;
}

function boundedToolNames(names: readonly string[]): {
  toolNames: string[];
  truncated: boolean;
} {
  const sanitizedNames = names.map(sanitizeAuditField);
  if (names.length <= MAX_AUDIT_TOOL_NAMES) {
    return { toolNames: sanitizedNames, truncated: false };
  }
  return {
    toolNames: sanitizedNames.slice(0, MAX_AUDIT_TOOL_NAMES),
    truncated: true,
  };
}

/** Escapes control characters as visible sequences for single-line audit/log output. */
export function escapeControlCharsVisible(value: string): string {
  return Array.from(value, (char) => {
    if (char === "\n") {
      return "\\n";
    }
    if (char === "\r") {
      return "\\r";
    }
    if (char === "\t") {
      return "\\t";
    }
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return `\\x${codePoint.toString(16).padStart(2, "0")}`;
    }
    return char;
  }).join("");
}

function sanitizeAuditField(value: string): string {
  const sanitized = escapeControlCharsVisible(value.trim());
  if (!sanitized) {
    return "(unknown)";
  }
  if (sanitized.length <= MAX_AUDIT_FIELD_LENGTH) {
    return sanitized;
  }
  return `${truncateUtf16Safe(sanitized, MAX_AUDIT_FIELD_LENGTH)}...`;
}

function matchedPolicyRules(params: {
  policy: ToolPolicyLike;
  ruleKind: ToolPolicyRuleKind;
  tools: readonly string[];
}): string[] {
  const rules = new Set<string>();
  const matchRule = createMatchedPolicyRuleForTool(params.policy, params.ruleKind);
  for (const toolName of params.tools) {
    const rule = matchRule(toolName);
    if (rule) {
      rules.add(sanitizeAuditField(rule));
    }
  }
  return [...rules].toSorted();
}

/** Log tools removed by an allow/deny policy filter step. */
export function auditToolPolicyFilter(params: {
  stepLabel: string;
  policy: ToolPolicyLike;
  before: readonly { name: string }[];
  after: readonly { name: string }[];
}): void {
  const removedByRule = removedToolNamesByRule({
    policy: params.policy,
    before: params.before,
    after: params.after,
  });
  for (const [ruleKind, removed] of removedByRule) {
    if (removed.length === 0) {
      continue;
    }
    const rule = sanitizeAuditField(labelForRuleKind(params.stepLabel, ruleKind));
    const { toolNames, truncated } = boundedToolNames(removed);
    const matchedRuleSourceTools = removed.slice(0, MAX_AUDIT_TOOL_NAMES);
    const matchedRules = matchedPolicyRules({
      policy: params.policy,
      ruleKind,
      tools: matchedRuleSourceTools,
    });
    const matchedRuleSuffix = matchedRules.length > 0 ? `; matched ${matchedRules.join(", ")}` : "";
    const message = `tool policy removed ${removed.length} tool(s) via ${rule}: ${toolNames.join(", ")}${matchedRuleSuffix}`;
    const metadata = {
      rule,
      ruleKind,
      ...(matchedRules.length > 0
        ? {
            matchedRules,
            ...(truncated ? { matchedRulesTruncated: true } : {}),
          }
        : {}),
      removedToolCount: removed.length,
      removedTools: toolNames,
      removedToolsTruncated: truncated,
    };
    // Routine policy filtering runs on every turn; per-turn removal detail is
    // diagnostic, not operator-facing, so it stays out of info-level logs.
    toolPolicyAuditLogger.debug(message, metadata);
  }
}

/** Log a sandbox tool blocked by policy before execution. */
export function auditSandboxToolPolicyBlock(params: {
  toolName: string;
  ruleType: "allow" | "deny";
  ruleSource: "agent" | "global" | "default";
  configKey: string;
  policy?: ToolPolicyLike;
  mode: SandboxConfig["mode"];
}): void {
  const normalizedToolName = normalizeToolPolicyName(params.toolName);
  if (!normalizedToolName) {
    return;
  }
  const toolName = sanitizeAuditField(normalizedToolName);
  const configKey = sanitizeAuditField(params.configKey);
  const matchedRule =
    params.policy && params.ruleType === "deny"
      ? createMatchedPolicyRuleForTool(params.policy, "deny")(normalizedToolName)
      : undefined;
  const sanitizedMatchedRule = matchedRule ? sanitizeAuditField(matchedRule) : undefined;
  const matchedRuleSuffix = sanitizedMatchedRule ? `; matched ${sanitizedMatchedRule}` : "";
  toolPolicyAuditLogger.info(
    `sandbox tool policy blocked ${toolName} via ${configKey}${matchedRuleSuffix}`,
    {
      tool: toolName,
      ruleKind: params.ruleType,
      ruleSource: params.ruleSource,
      configKey,
      ...(sanitizedMatchedRule ? { matchedRule: sanitizedMatchedRule } : {}),
      sandboxMode: params.mode,
    },
  );
}
