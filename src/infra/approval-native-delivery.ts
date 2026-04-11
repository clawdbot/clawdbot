import type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeSurface,
  ChannelApprovalNativeTarget,
} from "../channels/plugins/approval-native.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export type ChannelApprovalNativePlannedTarget = {
  surface: ChannelApprovalNativeSurface;
  target: ChannelApprovalNativeTarget;
  reason: "preferred" | "fallback";
};

export type ChannelApprovalNativeDeliveryPlan = {
  targets: ChannelApprovalNativePlannedTarget[];
  originTarget: ChannelApprovalNativeTarget | null;
  notifyOriginWhenDmOnly: boolean;
};

function dedupeTargets(
  targets: ChannelApprovalNativePlannedTarget[],
): ChannelApprovalNativePlannedTarget[] {
  const seen = new Set<string>();
  const deduped: ChannelApprovalNativePlannedTarget[] = [];
  for (const target of targets) {
    const key = buildChannelApprovalNativeTargetKey(target.target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

export async function resolveChannelNativeApprovalDeliveryPlan(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
}): Promise<ChannelApprovalNativeDeliveryPlan> {
  const adapter = params.adapter;
  if (!adapter) {
    return {
      targets: [],
      originTarget: null,
      notifyOriginWhenDmOnly: false,
    };
  }

  const capabilities = adapter.describeDeliveryCapabilities({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
  });
  if (!capabilities.enabled) {
    return {
      targets: [],
      originTarget: null,
      notifyOriginWhenDmOnly: false,
    };
  }

  const originTarget =
    capabilities.supportsOriginSurface && adapter.resolveOriginTarget
      ? ((await adapter.resolveOriginTarget({
          cfg: params.cfg,
          accountId: params.accountId,
          approvalKind: params.approvalKind,
          request: params.request,
        })) ?? null)
      : null;
  const approverDmTargets =
    capabilities.supportsApproverDmSurface && adapter.resolveApproverDmTargets
      ? await adapter.resolveApproverDmTargets({
          cfg: params.cfg,
          accountId: params.accountId,
          approvalKind: params.approvalKind,
          request: params.request,
        })
      : [];

  const plannedTargets: ChannelApprovalNativePlannedTarget[] = [];
  const preferOrigin =
    capabilities.preferredSurface === "origin" || capabilities.preferredSurface === "both";
  const preferApproverDm =
    capabilities.preferredSurface === "approver-dm" || capabilities.preferredSurface === "both";

  if (preferOrigin && originTarget) {
    plannedTargets.push({
      surface: "origin",
      target: originTarget,
      reason: "preferred",
    });
  }

  if (preferApproverDm) {
    for (const target of approverDmTargets) {
      plannedTargets.push({
        surface: "approver-dm",
        target,
        reason: "preferred",
      });
    }
  } else if (!originTarget) {
    for (const target of approverDmTargets) {
      plannedTargets.push({
        surface: "approver-dm",
        target,
        reason: "fallback",
      });
    }
  }

  return {
    targets: dedupeTargets(plannedTargets),
    originTarget,
    notifyOriginWhenDmOnly:
      capabilities.preferredSurface === "approver-dm" &&
      capabilities.notifyOriginWhenDmOnly === true &&
      originTarget !== null,
  };
}
