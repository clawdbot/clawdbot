import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { restoreChatApiAttachments } from "../chat/attachment-api.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

export function resolveDraftSessionPlacement(
  pending: Pick<PendingSessionPlacementRecoveryState, "sessionKey" | "target">,
  place: Pick<DraftPlaceState, "cloudProfileId" | "deviceId" | "machineClass">,
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
        : null;
  return { target };
}

export function projectDraftSessionPlacementRecovery(recovery: SessionPlacementRecovery) {
  const visibility: "normal" | "incognito" =
    recovery.createParams?.incognito === true ? "incognito" : "normal";
  const placement = {
    agentId: recovery.agentId,
    profileId: recovery.target.kind === "profile" ? recovery.target.profileId : "",
    ...(recovery.target.kind === "profile"
      ? { machineClass: recovery.target.machineClass }
      : { deviceId: recovery.target.deviceId }),
    cwd: recovery.createParams?.cwd,
  };
  return {
    placement,
    draft: {
      message: recovery.message,
      attachments: restoreChatApiAttachments(recovery.attachments),
      visibility,
    },
  };
}
