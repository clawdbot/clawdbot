import type { LocationMessageEventContent } from "../sdk.js";
import { hasBundledMatrixReplacementRelation } from "./handler-helpers.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType, RelationType } from "./types.js";
import { isMatrixVerificationRoomMessage } from "./verification-utils.js";

type ReplayClaimHandle = import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle;

type MatrixIngressPrefixConfig = {
  client: { getUserId: () => Promise<string> };
  senderId: string;
  dropPreStartupMessages: boolean;
  eventTs?: number;
  eventAge?: number;
  startupMs: number;
  startupGraceMs: number;
  event: MatrixRawEvent;
  eventType: string;
  eventId: string;
  inboundDeduper?: Pick<MatrixInboundEventDeduper, "claim">;
  roomId: string;
  logVerboseMessage: (message: string) => void;
  directTracker: {
    isDirectMessage: (params: {
      roomId: string;
      senderId: string;
      selfUserId: string;
    }) => Promise<boolean>;
  };
  claimInboundReplay: (handle: ReplayClaimHandle) => void;
};

export async function readMatrixIngressPrefix(config: MatrixIngressPrefixConfig) {
  const {
    client,
    senderId,
    dropPreStartupMessages,
    eventTs,
    eventAge,
    startupMs,
    startupGraceMs,
    event,
    eventType,
    eventId,
    inboundDeduper,
    roomId,
    logVerboseMessage,
    directTracker,
    claimInboundReplay,
  } = config;
  const selfUserId = await client.getUserId();
  if (senderId === selfUserId) {
    return undefined;
  }
  if (dropPreStartupMessages) {
    if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {
      return undefined;
    }
    if (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > startupGraceMs) {
      return undefined;
    }
  }

  const content = event.content as RoomMessageEventContent;

  if (
    eventType === EventType.RoomMessage &&
    isMatrixVerificationRoomMessage({
      msgtype: (content as { msgtype?: unknown }).msgtype,
      body: content.body,
    })
  ) {
    logVerboseMessage(`matrix: skip verification/system room message room=${roomId}`);
    return undefined;
  }

  const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
    eventType,
    content: content as LocationMessageEventContent,
  });

  const relates = content["m.relates_to"];
  if (relates && "rel_type" in relates && relates.rel_type === RelationType.Replace) {
    return undefined;
  }
  if (hasBundledMatrixReplacementRelation(event)) {
    return undefined;
  }
  if (eventId && inboundDeduper) {
    const claim = await inboundDeduper.claim({ roomId, eventId });
    // Missing identifiers fail open; committed and in-flight events do not.
    if (claim.kind === "claimed") {
      claimInboundReplay(claim.handle);
    } else if (claim.kind !== "invalid") {
      logVerboseMessage(`matrix: skip duplicate inbound event room=${roomId} id=${eventId}`);
      return undefined;
    }
  }

  const isDirectMessage = await directTracker.isDirectMessage({
    roomId,
    senderId,
    selfUserId,
  });
  return { content, isDirectMessage, locationPayload, selfUserId };
}
