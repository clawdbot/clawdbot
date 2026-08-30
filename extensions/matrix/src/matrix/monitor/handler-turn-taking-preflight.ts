import type { InboundEventKind } from "openclaw/plugin-sdk/channel-inbound";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  hasMatrixOpenClawPreviewMarker,
  parseMatrixOpenClawPreviewEvent,
} from "../preview-protocol.js";
import type { MatrixMonitorHandlerParams } from "./handler-types.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import {
  MATRIX_ACTIVE_PREVIEW_TTL_MS,
  MATRIX_TERMINAL_REPLAY_TTL_MS,
} from "./turn-taking-coordinator.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

export type MatrixTurnTakingPreflightResult =
  | { kind: "consume" }
  | {
      kind: "continue";
      event: MatrixRawEvent;
      inboundEventKind: InboundEventKind;
      turnTakingTransportSupported: boolean;
      previewObservationId?: string;
      previewObservationOnly: boolean;
      releaseIngress?: () => void;
    };

export function createMatrixTurnTakingPreflight(params: MatrixMonitorHandlerParams) {
  const {
    accountId,
    cfg,
    client,
    dropPreStartupMessages,
    getRoomInfo,
    logVerboseMessage,
    needsRoomAliasesForTurnTakingConfig,
    startupGraceMs,
    startupMs,
  } = params;
  const protocolQueue = new KeyedAsyncQueue();
  const wireEventTypeCache =
    params.turnTakingWireEventTypeCache ?? new Map<string, "m.room.message" | "m.room.encrypted">();

  const acquireProtocolPreflight = async (roomId: string): Promise<() => Promise<void>> => {
    let markAcquired!: () => void;
    let releaseHold!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const queued = protocolQueue.enqueue(roomId, async () => {
      markAcquired();
      await hold;
    });
    await acquired;
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      releaseHold();
      await queued;
    };
  };

  const isDisabledForRoom = async (roomId: string): Promise<boolean> => {
    const roomInfo = needsRoomAliasesForTurnTakingConfig
      ? await getRoomInfo(roomId, { includeAliases: true })
      : undefined;
    const aliases = roomInfo
      ? [roomInfo.canonicalAlias ?? "", ...roomInfo.altAliases].filter(Boolean)
      : [];
    return (
      resolveMatrixRoomConfig({
        rooms: params.turnTakingRoomsConfig,
        roomId,
        aliases,
      }).config?.turnTaking === false
    );
  };

  return async (
    roomId: string,
    incomingEvent: MatrixRawEvent,
  ): Promise<MatrixTurnTakingPreflightResult> => {
    let event = incomingEvent;
    let inboundEventKind: InboundEventKind = "user_request";
    let releaseIngress: (() => void) | undefined;
    let releaseProtocol: (() => Promise<void>) | undefined;
    let previewObservationId: string | undefined;
    let previewObservationOnly = false;
    const consume = async (): Promise<MatrixTurnTakingPreflightResult> => {
      await releaseProtocol?.();
      releaseProtocol = undefined;
      releaseIngress?.();
      releaseIngress = undefined;
      return { kind: "consume" };
    };
    try {
      if (event.type === EventType.RoomMessageEncrypted) {
        wireEventTypeCache.set(roomId, EventType.RoomMessageEncrypted);
        return await consume();
      }
      if (event.type === EventType.RoomEncryption) {
        wireEventTypeCache.set(roomId, EventType.RoomMessageEncrypted);
        return await consume();
      }
      if (event.unsigned?.redacted_because) {
        return await consume();
      }
      const turnTakingRequested = params.turnTaking?.enabled === true;
      const hasReservedPreviewMarker = hasMatrixOpenClawPreviewMarker(event);
      const registerIngress = (candidate: MatrixRawEvent) => {
        if (
          releaseIngress ||
          !turnTakingRequested ||
          !params.turnTakingCoordinator ||
          candidate.type !== EventType.RoomMessage
        ) {
          return;
        }
        const eventId = candidate.event_id?.trim();
        const senderId = candidate.sender?.trim();
        if (!eventId || !senderId) {
          return;
        }
        releaseIngress = params.turnTakingCoordinator.beginIngressObservation?.({
          roomId,
          eventId,
          senderId,
          accountId,
        });
      };
      // Ordinary room messages can enter the shared metadata barrier as soon as
      // their event type is known. Reserved preview frames register only after
      // interception promotes a trusted final.
      if (!hasReservedPreviewMarker) {
        registerIngress(event);
      }
      if (hasReservedPreviewMarker && (!turnTakingRequested || !params.turnTakingCoordinator)) {
        logVerboseMessage(
          `matrix: consume enhanced preview protocol while turn-taking is inactive room=${roomId}`,
        );
        return await consume();
      }
      if (
        turnTakingRequested &&
        params.turnTakingCoordinator &&
        (hasReservedPreviewMarker || event.type === EventType.RoomRedaction)
      ) {
        releaseProtocol = await acquireProtocolPreflight(roomId);
      }
      if (
        event.type === EventType.RoomRedaction &&
        turnTakingRequested &&
        params.turnTakingCoordinator
      ) {
        const contentRedacts =
          typeof event.content.redacts === "string" ? event.content.redacts.trim() : "";
        const targetEventId = event.redacts?.trim() || contentRedacts;
        if (targetEventId) {
          await params.turnTakingCoordinator.observePreviewRedaction({ roomId, targetEventId });
        }
        return await consume();
      }
      const disabledForRoom = turnTakingRequested ? await isDisabledForRoom(roomId) : false;
      if (hasReservedPreviewMarker && disabledForRoom) {
        logVerboseMessage(`matrix: consume enhanced preview protocol in opted-out room=${roomId}`);
        return await consume();
      }
      let transportSupported = false;
      if (turnTakingRequested && !disabledForRoom) {
        let wireEventType = wireEventTypeCache.get(roomId);
        if (!wireEventType) {
          wireEventType = await client.getMessageWireEventType(roomId).catch((error: unknown) => {
            logVerboseMessage(
              `matrix: unable to prove unencrypted room for enhanced turn-taking room=${roomId}: ${String(error)}`,
            );
            return undefined;
          });
          if (wireEventType) {
            wireEventTypeCache.set(roomId, wireEventType);
          }
        }
        transportSupported = wireEventType === EventType.RoomMessage;
      }
      const enabled = turnTakingRequested && !disabledForRoom && transportSupported;
      if (hasReservedPreviewMarker && !enabled) {
        logVerboseMessage(
          `matrix: consume enhanced preview protocol in unsupported encrypted room=${roomId}`,
        );
        return await consume();
      }
      if (enabled && params.turnTakingCoordinator && hasReservedPreviewMarker) {
        const senderId = event.sender?.trim();
        if (!senderId || senderId === (await client.getUserId())) {
          return await consume();
        }
        const parsedPreview = parseMatrixOpenClawPreviewEvent(event);
        const eventTs =
          parsedPreview.kind === "preview"
            ? parsedPreview.envelope.sourceEvent.origin_server_ts
            : event.origin_server_ts;
        const eventAge =
          parsedPreview.kind === "preview"
            ? (parsedPreview.envelope.sourceEvent.unsigned?.age ?? event.unsigned?.age)
            : event.unsigned?.age;
        const staleInProgressPreview =
          parsedPreview.kind === "preview" &&
          parsedPreview.envelope.marker.state === "in-progress" &&
          ((typeof eventTs === "number" && Date.now() - eventTs > MATRIX_ACTIVE_PREVIEW_TTL_MS) ||
            (typeof eventTs !== "number" &&
              typeof eventAge === "number" &&
              eventAge > MATRIX_ACTIVE_PREVIEW_TTL_MS));
        if (staleInProgressPreview) {
          logVerboseMessage(
            `matrix: drop stale in-progress sibling preview room=${roomId} id=${event.event_id ?? "unknown"}`,
          );
          return await consume();
        }
        const staleTerminalPreview =
          parsedPreview.kind === "preview" &&
          (parsedPreview.envelope.marker.state === "final" ||
            parsedPreview.envelope.marker.state === "abandoned") &&
          ((typeof eventTs === "number" && Date.now() - eventTs > MATRIX_TERMINAL_REPLAY_TTL_MS) ||
            (typeof eventTs !== "number" &&
              typeof eventAge === "number" &&
              eventAge > MATRIX_TERMINAL_REPLAY_TTL_MS));
        if (staleTerminalPreview) {
          logVerboseMessage(
            `matrix: drop stale sibling preview terminal room=${roomId} id=${event.event_id ?? "unknown"}`,
          );
          return await consume();
        }
        if (
          dropPreStartupMessages &&
          ((typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) ||
            (typeof eventTs !== "number" &&
              typeof eventAge === "number" &&
              eventAge > startupGraceMs))
        ) {
          return await consume();
        }
        const previewIngress = await params.turnTakingCoordinator.interceptPreviewEvent({
          cfg,
          roomId,
          accountId,
          event,
        });
        if (previewIngress.kind === "consume") {
          logVerboseMessage(
            `matrix: ${previewIngress.reason} room=${roomId} id=${event.event_id ?? "unknown"}`,
          );
          return await consume();
        }
        if (previewIngress.kind === "authorize") {
          event = previewIngress.event;
          previewObservationId = previewIngress.observationId;
          previewObservationOnly = true;
        } else if (previewIngress.kind === "promote") {
          event = previewIngress.event;
          previewObservationId = previewIngress.observationId;
          inboundEventKind = "room_event";
          registerIngress(event);
        } else {
          logVerboseMessage(
            `matrix: consume unpromoted enhanced preview protocol room=${roomId} id=${event.event_id ?? "unknown"}`,
          );
          return await consume();
        }
      }
      await releaseProtocol?.();
      releaseProtocol = undefined;
      return {
        kind: "continue",
        event,
        inboundEventKind,
        turnTakingTransportSupported: transportSupported,
        ...(previewObservationId ? { previewObservationId } : {}),
        previewObservationOnly,
        ...(releaseIngress ? { releaseIngress } : {}),
      };
    } catch (error) {
      await releaseProtocol?.();
      releaseIngress?.();
      throw error;
    }
  };
}
