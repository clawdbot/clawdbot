/**
 * Native channel approval delivery types.
 *
 * Describes approval request targets, surfaces, capabilities, and plugin adapters.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../../infra/plugin-approvals.js";

/**
 * Native channel surface that can receive approval prompts.
 */
export type ChannelApprovalNativeSurface = "origin" | "approver-dm";

/**
 * Native channel destination for an approval prompt.
 */
export type ChannelApprovalNativeTarget = {
  to: string;
  threadId?: string | number | null;
};

/**
 * Preferred native delivery surface for approval prompts.
 */
type ChannelApprovalNativeDeliveryPreference = ChannelApprovalNativeSurface | "both";

/**
 * Approval request shapes supported by native channel approval delivery.
 */
type ChannelApprovalNativeRequest = ExecApprovalRequest | PluginApprovalRequest;

/**
 * Capabilities returned by native channel approval delivery inspection.
 */
type ChannelApprovalNativeDeliveryCapabilities = {
  enabled: boolean;
  preferredSurface: ChannelApprovalNativeDeliveryPreference;
  supportsOriginSurface: boolean;
  supportsApproverDmSurface: boolean;
  notifyOriginWhenDmOnly?: boolean;
};

/**
 * Adapter implemented by channel plugins that support native approval delivery.
 */
export type ChannelApprovalNativeAdapter = {
  describeDeliveryCapabilities: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ChannelApprovalNativeRequest;
  }) => ChannelApprovalNativeDeliveryCapabilities;
  resolveOriginTarget?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ChannelApprovalNativeRequest;
  }) => ChannelApprovalNativeTarget | null | Promise<ChannelApprovalNativeTarget | null>;
  resolveApproverDmTargets?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ChannelApprovalNativeRequest;
  }) => ChannelApprovalNativeTarget[] | Promise<ChannelApprovalNativeTarget[]>;
};
