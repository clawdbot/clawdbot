import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { restoreChatApiAttachments } from "../chat/attachment-api.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

export function resolveDraftSessionPlacement(
  pending: Pick<PendingSessionPlacementRecoveryState, "sessionKey" | "target">,
  place: Pick<DraftPlaceState, "cloudProfileId" | "machineClass">,
) {
  const target = pending.sessionKey
    ? pending.target
    : place.cloudProfileId
      ? {
          kind: "profile" as const,
          profileId: place.cloudProfileId,
          ...(place.machineClass ? { machineClass: place.machineClass } : {}),
        }
      : null;
  return { target, cloudProfileId: target?.kind === "profile" ? target.profileId : "" };
}

export function projectDraftSessionPlacementRecovery(recovery: SessionPlacementRecovery) {
  const visibility: "normal" | "incognito" =
    recovery.createParams?.incognito === true ? "incognito" : "normal";
  const cloudPlace =
    recovery.target.kind === "profile"
      ? {
          agentId: recovery.agentId,
          profileId: recovery.target.profileId,
          machineClass: recovery.target.machineClass,
          cwd: recovery.createParams?.cwd,
        }
      : undefined;
  return {
    cloudPlace,
    draft: {
      message: recovery.message,
      attachments: restoreChatApiAttachments(recovery.attachments),
      visibility,
    },
  };
}
