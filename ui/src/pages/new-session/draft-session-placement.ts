import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { restoreChatApiAttachments } from "../chat/attachment-api.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

export type PendingPlacementPlace = {
  agentId: string;
  profileId: string;
  deviceId?: string;
  autoDevice?: boolean;
  machineClass?: string;
  cwd?: string;
};

export function resolveDraftSessionPlacement(
  pending: Pick<PendingSessionPlacementRecoveryState, "sessionKey" | "target">,
  place: { autoDevice: boolean; cloudProfileId: string; deviceId: string; machineClass: string },
) {
  const target = pending.sessionKey
    ? pending.target
    : place.cloudProfileId
      ? {
          kind: "profile" as const,
          profileId: place.cloudProfileId,
          ...(place.machineClass ? { machineClass: place.machineClass } : {}),
        }
      : place.deviceId
        ? { kind: "device" as const, deviceId: place.deviceId }
        : place.autoDevice
          ? { kind: "auto-device" as const }
          : null;
  return { target };
}

export function projectDraftSessionPlacementRecovery(recovery: SessionPlacementRecovery) {
  const visibility: NewSessionVisibility = recovery.createParams?.incognito
    ? "incognito"
    : recovery.createParams?.visibility === "draft"
      ? "draft"
      : "normal";
  const placement: PendingPlacementPlace = {
    agentId: recovery.agentId,
    profileId: recovery.target.kind === "profile" ? recovery.target.profileId : "",
    ...(recovery.target.kind === "profile"
      ? { machineClass: recovery.target.machineClass }
      : recovery.target.kind === "device"
        ? { deviceId: recovery.target.deviceId }
        : { autoDevice: true }),
    cwd: recovery.createParams?.cwd,
  };
  return {
    placement,
    draft: {
      message: recovery.message,
      attachments: restoreChatApiAttachments(recovery.attachments),
      visibility,
      toolOverrides: recovery.createParams?.toolOverrides ?? null,
    },
  };
}
