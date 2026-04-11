import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../../infra/plugin-approvals.js";

export type ChannelApprovalNativeSurface = "origin" | "approver-dm";

export type ChannelApprovalNativeTarget = {
  to: string;
  threadId?: string | number | null;
};

export type ChannelApprovalNativeDeliveryPreference = ChannelApprovalNativeSurface | "both";

export type ChannelApprovalNativeRequest = ExecApprovalRequest | PluginApprovalRequest;

export type ChannelApprovalNativeDeliveryCapabilities = {
  enabled: boolean;
  preferredSurface: ChannelApprovalNativeDeliveryPreference;
  supportsOriginSurface: boolean;
  supportsApproverDmSurface: boolean;
  notifyOriginWhenDmOnly?: boolean;
};

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
