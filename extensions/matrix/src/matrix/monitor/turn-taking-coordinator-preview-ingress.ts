import type { CoreConfig } from "../../types.js";
import {
  buildPromotedMatrixPreviewEvent,
  parseMatrixOpenClawPreviewEvent,
} from "../preview-protocol.js";
import type { MatrixOpenClawPreviewEnvelope } from "../preview-protocol.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import type { MatrixTurnTakingFreshness } from "./turn-taking-coordinator-freshness.js";
import type { MatrixTurnTakingParticipation } from "./turn-taking-coordinator-participation.js";
import type { MatrixPreviewCore } from "./turn-taking-coordinator-preview-core.js";
import type { MatrixTurnTakingState } from "./turn-taking-coordinator-state.js";
import type {
  MatrixPreviewAuthorization,
  MatrixPreviewIngressResult,
  PreparedPreviewIngress,
} from "./turn-taking-coordinator-types.js";
import {
  boundedMapSet,
  MAX_PREVIEW_INGRESS_RESULTS,
  normalizeUserId,
  PREVIEW_INGRESS_CACHE_MS,
} from "./turn-taking-coordinator-types.js";

export function createMatrixPreviewIngress(input: {
  state: MatrixTurnTakingState;
  core: MatrixPreviewCore;
  freshness: MatrixTurnTakingFreshness;
  participation: MatrixTurnTakingParticipation;
}) {
  const { state, core, freshness, participation } = input;
  const processTrustedPreview = async (params: {
    roomId: string;
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
    authorizationExpiresAt: number;
    client: MatrixClient;
    receiverAccountId: string;
  }): Promise<PreparedPreviewIngress> => {
    const { envelope } = params;
    const consumed = (reason: string): PreparedPreviewIngress => ({
      result: { kind: "consume", reason },
    });
    const withAuthorization = (
      result: MatrixPreviewIngressResult,
      originalEventId: string,
      promotedEvent?: MatrixRawEvent,
    ): PreparedPreviewIngress => ({
      result,
      authorization: {
        roomId: params.roomId,
        senderId: params.senderId,
        originalEventId,
        envelope,
        expiresAt: params.authorizationExpiresAt,
        ...(promotedEvent ? { promotedEvent } : {}),
      },
    });
    if (
      state.wasPreviewSourceRedacted(
        params.roomId,
        [envelope.sourceEvent.event_id, envelope.originalEventId].filter((value): value is string =>
          Boolean(value),
        ),
      )
    ) {
      return consumed("preview source was already redacted");
    }
    if (!envelope.originalEventId) {
      if (envelope.marker.state === "ancillary") {
        return consumed("enhanced final ancillary event");
      }
      if (envelope.marker.state === "final") {
        const result = core.processStandaloneFinalPart(params);
        return result.kind === "promote"
          ? withAuthorization(result, result.event.event_id, result.event)
          : { result };
      }
      const key = state.previewKey(params.roomId, envelope.sourceEvent.event_id);
      if (state.previewTombstones.has(key)) {
        return consumed("preview lineage already closed");
      }
      const senderObservation = state.activePreviews.get(key);
      if (
        senderObservation
          ? !core.exactActivePreviewMatches({
              preview: senderObservation,
              originalEventId: envelope.sourceEvent.event_id,
              senderId: params.senderId,
              envelope,
            })
          : !core.rememberActivePreview({
              roomId: params.roomId,
              originalEventId: envelope.sourceEvent.event_id,
              senderId: params.senderId,
              envelope,
            })
      ) {
        return consumed("invalid or stale preview lineage");
      }
      return withAuthorization(
        {
          kind: "authorize",
          reason: "preview started",
          event: core.buildPreviewAccessEvent(params),
          observationId: envelope.sourceEvent.event_id,
        },
        envelope.sourceEvent.event_id,
      );
    }
    const key = state.previewKey(params.roomId, envelope.originalEventId);
    const tombstone = state.previewTombstones.get(key);
    if (tombstone) {
      if (
        !tombstone.redacted &&
        tombstone.senderId === params.senderId &&
        tombstone.sourceEventId === envelope.sourceEvent.event_id &&
        tombstone.body === core.previewBody(envelope) &&
        core.exactPreviewMarkerMatches(tombstone.marker, envelope.marker)
      ) {
        if (envelope.marker.state === "abandoned") {
          return withAuthorization(
            {
              kind: "authorize",
              reason: "preview abandoned",
              event: core.buildPreviewAccessEvent(params),
              observationId: envelope.sourceEvent.event_id,
            },
            envelope.originalEventId,
          );
        }
        if (envelope.marker.state !== "final") {
          return consumed("preview lineage already closed");
        }
        const promoted = buildPromotedMatrixPreviewEvent({
          envelope,
          originalEventId: envelope.originalEventId,
          senderId: params.senderId,
        });
        return promoted
          ? withAuthorization(
              { kind: "promote", event: promoted, observationId: envelope.sourceEvent.event_id },
              envelope.originalEventId,
              promoted,
            )
          : consumed("invalid final preview content");
      }
      return consumed("preview lineage already closed");
    }
    const original = await core.resolveOriginalPreview({
      client: params.client,
      roomId: params.roomId,
      originalEventId: envelope.originalEventId,
      senderId: params.senderId,
    });
    if (
      original &&
      envelope.marker.state === "in-progress" &&
      core.exactActivePreviewMatches({
        preview: original,
        originalEventId: envelope.originalEventId,
        senderId: params.senderId,
        envelope,
      })
    ) {
      return withAuthorization(
        {
          kind: "authorize",
          reason: "preview updated",
          event: core.buildPreviewAccessEvent(params),
          observationId: envelope.sourceEvent.event_id,
        },
        envelope.originalEventId,
      );
    }
    if (
      !original ||
      original.senderId !== params.senderId ||
      !core.previewLineageMatches(original.marker, envelope.marker) ||
      envelope.marker.revision <= original.marker.revision
    ) {
      return consumed("invalid or stale preview lineage");
    }
    if (envelope.marker.state === "in-progress") {
      core.rememberActivePreview({
        roomId: params.roomId,
        originalEventId: envelope.originalEventId,
        senderId: params.senderId,
        envelope,
      });
      return withAuthorization(
        {
          kind: "authorize",
          reason: "preview updated",
          event: core.buildPreviewAccessEvent(params),
          observationId: envelope.sourceEvent.event_id,
        },
        envelope.originalEventId,
      );
    }
    core.tombstonePreview({
      roomId: params.roomId,
      originalEventId: envelope.originalEventId,
      senderId: params.senderId,
      envelope,
    });
    if (envelope.marker.state === "abandoned") {
      return withAuthorization(
        {
          kind: "authorize",
          reason: "preview abandoned",
          event: core.buildPreviewAccessEvent(params),
          observationId: envelope.sourceEvent.event_id,
        },
        envelope.originalEventId,
      );
    }
    const promoted = buildPromotedMatrixPreviewEvent({
      envelope,
      originalEventId: envelope.originalEventId,
      senderId: params.senderId,
    });
    return promoted
      ? withAuthorization(
          { kind: "promote", event: promoted, observationId: envelope.sourceEvent.event_id },
          envelope.originalEventId,
          promoted,
        )
      : consumed("invalid final preview content");
  };

  const authorizePreparedPreview = (authorization: MatrixPreviewAuthorization): boolean => {
    const { envelope } = authorization;
    const { marker } = envelope;
    if (marker.state === "in-progress") {
      return core.rememberAuthorizedActivePreview({
        roomId: authorization.roomId,
        originalEventId: authorization.originalEventId,
        senderId: authorization.senderId,
        envelope,
        expiresAt: authorization.expiresAt,
      });
    }
    if (marker.state === "final") {
      const promoted = authorization.promotedEvent;
      if (!promoted) {
        return false;
      }
      if (marker.partIndex !== undefined && marker.partCount !== undefined) {
        const terminal = state.standaloneFinalTombstones.get(
          state.standaloneKey(authorization.roomId, authorization.senderId, marker.responseId),
        );
        if (
          !terminal ||
          terminal.redacted ||
          !core.previewLineageMatches(terminal.marker, marker) ||
          !terminal.sourceEventIds.has(envelope.sourceEvent.event_id)
        ) {
          return false;
        }
        terminal.hadAuthorizedVisibility = true;
      } else {
        const key = state.previewKey(authorization.roomId, authorization.originalEventId);
        const terminal = state.previewTombstones.get(key);
        if (
          !terminal ||
          terminal.redacted ||
          terminal.senderId !== authorization.senderId ||
          terminal.sourceEventId !== envelope.sourceEvent.event_id ||
          !core.exactPreviewMarkerMatches(terminal.marker, marker)
        ) {
          return false;
        }
        terminal.hadAuthorizedVisibility = true;
        state.authorizedActivePreviews.delete(key);
      }
      return (
        freshness.observeMessage({
          roomId: authorization.roomId,
          eventId: promoted.event_id,
          senderId: authorization.senderId,
          body: typeof promoted.content.body === "string" ? promoted.content.body : "",
          timestamp: promoted.origin_server_ts,
          threadId: marker.threadId,
          triggerEventId: marker.triggerEventId,
        }) !== undefined
      );
    }
    if (marker.state === "abandoned") {
      const key = state.previewKey(authorization.roomId, authorization.originalEventId);
      const terminal = state.previewTombstones.get(key);
      if (
        !terminal ||
        terminal.redacted ||
        terminal.senderId !== authorization.senderId ||
        terminal.sourceEventId !== envelope.sourceEvent.event_id ||
        !core.exactPreviewMarkerMatches(terminal.marker, marker)
      ) {
        return false;
      }
      terminal.hadAuthorizedVisibility = true;
      state.authorizedActivePreviews.delete(key);
      freshness.observePreviewTerminal({
        roomId: authorization.roomId,
        originalEventId: authorization.originalEventId,
        senderId: authorization.senderId,
        marker,
        state: "abandoned",
      });
      return true;
    }
    return false;
  };

  const interceptPreviewEvent = async (params: {
    cfg: CoreConfig;
    roomId: string;
    accountId: string;
    event: MatrixRawEvent;
  }): Promise<MatrixPreviewIngressResult> => {
    state.prune();
    const interceptedAt = state.now();
    const senderId = params.event.sender?.trim();
    if (!senderId) {
      return { kind: "ordinary" };
    }
    const result = await participation.resolveRoster({
      cfg: params.cfg,
      roomId: params.roomId,
      accountId: params.accountId,
      senderId,
      eventTs: params.event.origin_server_ts,
    });
    const trusted = result.members.some(
      (candidate) => normalizeUserId(candidate.userId) === normalizeUserId(senderId),
    );
    if (result.members.length < 2) {
      return { kind: "consume", reason: "enhanced preview room is no longer eligible" };
    }
    if (!trusted) {
      return { kind: "consume", reason: "untrusted enhanced preview sender" };
    }
    const parsed = parseMatrixOpenClawPreviewEvent(params.event);
    if (parsed.kind === "none") {
      return { kind: "ordinary" };
    }
    if (parsed.kind === "malformed") {
      result.executionMonitor?.log(
        `matrix: suppressed malformed trusted preview room=${params.roomId} id=${params.event.event_id} reason=${parsed.reason}`,
      );
      return { kind: "consume", reason: "malformed trusted preview" };
    }
    const authorizationExpiresAt = core.previewAuthorizationExpiresAt({
      envelope: parsed.envelope,
      incomingEvent: params.event,
      interceptedAt,
    });
    const cacheKey = state.previewIngressKey(
      params.accountId,
      params.roomId,
      parsed.envelope.sourceEvent.event_id,
    );
    let cached = state.previewIngress.get(cacheKey);
    if (!cached) {
      const pending = state.previewLineageQueue.enqueue(
        state.roomScope(params.roomId),
        async () =>
          await processTrustedPreview({
            roomId: params.roomId,
            senderId,
            envelope: parsed.envelope,
            authorizationExpiresAt,
            client: state.monitors.get(params.accountId)?.client ?? result.executionMonitor!.client,
            receiverAccountId: params.accountId,
          }),
      );
      cached = { expiresAt: state.now() + PREVIEW_INGRESS_CACHE_MS, pending };
      boundedMapSet(state.previewIngress, cacheKey, cached, MAX_PREVIEW_INGRESS_RESULTS);
    }
    return (await cached.pending).result;
  };

  const authorizePreviewObservation = async (params: {
    roomId: string;
    accountId: string;
    observationId: string;
  }): Promise<boolean> => {
    const cacheKey = state.previewIngressKey(params.accountId, params.roomId, params.observationId);
    const cached = state.previewIngress.get(cacheKey);
    if (!cached) {
      return false;
    }
    const prepared = await cached.pending;
    if (!prepared.authorization) {
      return false;
    }
    return await state.previewLineageQueue.enqueue(state.roomScope(params.roomId), async () => {
      const authorization = prepared.authorization!;
      const timestamp = state.now();
      const expired = cached.expiresAt <= timestamp || timestamp >= authorization.expiresAt;
      state.prune();
      const redacted = state.wasPreviewSourceRedacted(authorization.roomId, [
        authorization.originalEventId,
        authorization.envelope.sourceEvent.event_id,
      ]);
      if (expired || redacted) {
        if (state.previewIngress.get(cacheKey) === cached) {
          state.previewIngress.delete(cacheKey);
        }
        state.invalidatePreviewIngress(authorization.roomId, [
          authorization.originalEventId,
          authorization.envelope.sourceEvent.event_id,
        ]);
        return false;
      }
      const authorized = authorizePreparedPreview(authorization);
      if (!authorized && state.previewIngress.get(cacheKey) === cached) {
        state.previewIngress.delete(cacheKey);
      }
      return authorized;
    });
  };
  return { interceptPreviewEvent, authorizePreviewObservation };
}
