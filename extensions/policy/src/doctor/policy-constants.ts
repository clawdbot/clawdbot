import { POLICY_RULE_METADATA, type PolicyRuleMetadata } from "./metadata.js";

export const POLICY_RULES: readonly PolicyRuleMetadata[] = POLICY_RULE_METADATA;

export const KNOWN_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export const KNOWN_SENSITIVITY_LEVELS = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

export const SUPPORTED_TOOL_METADATA = ["risk", "sensitivity", "owner"] as const;

export const SUPPORTED_AUTH_PROFILE_METADATA = ["provider", "mode"] as const;

export const SUPPORTED_AUTH_PROFILE_MODES = ["api_key", "aws-sdk", "oauth", "token"] as const;

export const SUPPORTED_POLICY_SECTIONS = [
  "auth",
  "agents",
  "channels",
  "dataHandling",
  "execApprovals",
  "gateway",
  "ingress",
  "mcp",
  "models",
  "network",
  "sandbox",
  "scopes",
  "secrets",
  "tools",
] as const;

export const SUPPORTED_GATEWAY_POLICY_SECTIONS = [
  "auth",
  "controlUi",
  "exposure",
  "http",
  "nodes",
  "remote",
] as const;

export const SUPPORTED_GATEWAY_HTTP_ENDPOINTS = ["chatCompletions", "responses"] as const;

export const SUPPORTED_DM_POLICIES = ["pairing", "allowlist", "open", "disabled"] as const;

export const SUPPORTED_DM_SCOPES = [
  "main",
  "per-peer",
  "per-channel-peer",
  "per-account-channel-peer",
] as const;

export const SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS = [
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
] as const;

export const SUPPORTED_TOOL_PROFILES = ["minimal", "coding", "messaging", "full"] as const;

export const SUPPORTED_TOOL_EXEC_SECURITY = ["deny", "allowlist", "full"] as const;

export const SUPPORTED_TOOL_EXEC_ASK = ["off", "on-miss", "always"] as const;

export const SUPPORTED_TOOL_EXEC_HOST = ["auto", "sandbox", "gateway", "node"] as const;

export const SUPPORTED_EXEC_APPROVAL_SECURITY = ["deny", "allowlist", "full"] as const;

export const SUPPORTED_SANDBOX_MODES = ["off", "non-main", "all"] as const;
