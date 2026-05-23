import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SandboxConfig } from "./sandbox/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { normalizeToolName, type ToolPolicyLike } from "./tool-policy.js";

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
  return tools.map((tool) => normalizeToolName(tool.name)).filter((name) => name.length > 0);
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

  const removed = new Map<ToolPolicyRuleKind, Set<string>>();
  for (const name of normalizedToolNames(params.before)) {
    const remaining = remainingCounts.get(name) ?? 0;
    if (remaining > 0) {
      remainingCounts.set(name, remaining - 1);
      continue;
    }
    const ruleKind = removedToolRuleKind(name, params.policy);
    const names = removed.get(ruleKind) ?? new Set<string>();
    names.add(name);
    removed.set(ruleKind, names);
  }
  return new Map([...removed].map(([ruleKind, names]) => [ruleKind, [...names].toSorted()]));
}

function removedToolRuleKind(toolName: string, policy: ToolPolicyLike): ToolPolicyRuleKind {
  if (
    Array.isArray(policy.deny) &&
    policy.deny.length > 0 &&
    !isToolAllowedByPolicyName(toolName, { deny: policy.deny })
  ) {
    return "deny";
  }
  if (Array.isArray(policy.allow) && policy.allow.length > 0) {
    return "allow";
  }
  return toolPolicyRuleKind(policy);
}

function matchedPolicyRuleForTool(params: {
  toolName: string;
  policy: ToolPolicyLike;
  ruleKind: ToolPolicyRuleKind;
}): string | undefined {
  if (params.ruleKind === "deny" && Array.isArray(params.policy.deny)) {
    return params.policy.deny.find(
      (entry) => !isToolAllowedByPolicyName(params.toolName, { deny: [entry] }),
    );
  }
  return undefined;
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

function sanitizeAuditField(value: string): string {
  const sanitized = Array.from(value.trim(), (char) => {
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
  if (!sanitized) {
    return "(unknown)";
  }
  if (sanitized.length <= MAX_AUDIT_FIELD_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_AUDIT_FIELD_LENGTH)}...`;
}

function matchedPolicyRules(params: {
  policy: ToolPolicyLike;
  ruleKind: ToolPolicyRuleKind;
  tools: readonly string[];
}): string[] {
  const rules = new Set<string>();
  for (const toolName of params.tools) {
    const rule = matchedPolicyRuleForTool({
      toolName,
      policy: params.policy,
      ruleKind: params.ruleKind,
    });
    if (rule) {
      rules.add(sanitizeAuditField(rule));
    }
  }
  return [...rules].toSorted();
}

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
    toolPolicyAuditLogger.info(
      `tool policy removed ${removed.length} tool(s) via ${rule}: ${toolNames.join(", ")}${matchedRuleSuffix}`,
      {
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
      },
    );
  }
}

export function auditSandboxToolPolicyBlock(params: {
  toolName: string;
  ruleType: "allow" | "deny";
  ruleSource: "agent" | "global" | "default";
  configKey: string;
  policy?: ToolPolicyLike;
  mode: SandboxConfig["mode"];
}): void {
  const normalizedToolName = normalizeToolName(params.toolName);
  if (!normalizedToolName) {
    return;
  }
  const toolName = sanitizeAuditField(normalizedToolName);
  const configKey = sanitizeAuditField(params.configKey);
  const matchedRule =
    params.policy && params.ruleType === "deny"
      ? matchedPolicyRuleForTool({
          toolName: normalizedToolName,
          policy: params.policy,
          ruleKind: "deny",
        })
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
