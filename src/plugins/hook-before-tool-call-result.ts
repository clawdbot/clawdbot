import type { ApprovalScope } from "../infra/approval-scope.js";
import type { PluginExternalResolution } from "./external-verification-approval-types.js";

export const PluginApprovalResolutions = {
  ALLOW_ONCE: "allow-once",
  ALLOW_ALWAYS: "allow-always",
  DENY: "deny",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
} as const;

export type PluginApprovalResolution =
  (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];

type PluginHookApprovalRequest = {
  title: string;
  description: string;
  scope?: ApprovalScope;
  severity?: "info" | "warning" | "critical";
  timeoutMs?: number;
  /**
   * @deprecated Unresolved approvals always deny; retained for plugin API
   * compatibility. The field will be removed after one deprecation release train.
   */
  timeoutBehavior?: "allow" | "deny";
  /** Override timeout text and return the timeout as a blocked tool result. */
  timeoutReason?: string;
  allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
  /**
   * @deprecated Ignored. The host stamps the live plugin owner and will remove
   * this field after one deprecation release train.
   */
  pluginId?: string;
  /** Plugin-owned allow path. Core still owns denial and the final approval ledger. */
  externalResolution?: PluginExternalResolution;
  onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
};

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: PluginHookApprovalRequest;
};

/** Internal merger result with an owner stamped from the live registration. */
export type PluginHostBeforeToolCallResult = Omit<
  PluginHookBeforeToolCallResult,
  "requireApproval"
> & {
  requireApproval?: PluginHookApprovalRequest & { pluginId?: string };
};
