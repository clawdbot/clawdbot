import type { ApplicationContext } from "../app/context.ts";
import { isUpdateActionable } from "../app/update-overlay-helpers.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  isUpdateAttentionForced,
  resolveUpdateAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import type { SidebarAttentionDismissal } from "./sidebar-attention-entries.ts";

type SidebarUpdateContext = Pick<ApplicationContext, "gateway" | "overlays">;

export type SidebarUpdateAttentionState = {
  actionable: boolean;
  busy: boolean;
  canUpdate: boolean;
  dismissal: SidebarAttentionDismissal | null;
  forced: boolean;
  present: boolean;
};

export function resolveSidebarUpdateAttention(
  context: SidebarUpdateContext,
): SidebarUpdateAttentionState {
  const snapshot = context.overlays.snapshot;
  const campaign = snapshot.updateSchedule?.campaign;
  const busy =
    snapshot.updateRunning ||
    snapshot.updateReconciliationPending ||
    campaign?.state === "applying";
  const canUpdate = canCallGatewayMethod(context.gateway.snapshot, "update.run", "operator.admin");
  const canHydrateCampaign = canCallGatewayMethod(
    context.gateway.snapshot,
    "update.status",
    "operator.admin",
  );
  const campaignPendingHydration =
    campaign && !snapshot.updateCampaignStatusHydrated && canHydrateCampaign;
  const present = snapshot.updateReconciliationPending
    ? true
    : campaignPendingHydration
      ? Boolean(snapshot.updateRunning || snapshot.updateStatusBanner)
      : Boolean(
          snapshot.updateRunning ||
          snapshot.updateStatusBanner ||
          snapshot.updateAvailable ||
          campaign,
        );
  const dismissal = resolveUpdateAttentionDismissal({
    gatewayBootId: context.gateway.snapshot.hello?.server?.bootId,
    updateAvailable: snapshot.updateAvailable,
    updateSchedule: snapshot.updateSchedule,
  });
  const forced =
    snapshot.updateRunning ||
    snapshot.updateReconciliationPending ||
    campaign?.state === "applying" ||
    isUpdateAttentionForced(snapshot.updateStatusBanner?.tone);
  return {
    actionable: isUpdateActionable(snapshot.updateAvailable, snapshot.updateSchedule, busy),
    busy,
    canUpdate,
    dismissal,
    forced,
    present,
  };
}
