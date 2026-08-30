import type {
  MatrixOpenClawPreviewEnvelope,
  MatrixOpenClawPreviewMarker,
} from "../preview-protocol.js";
import type { MatrixTurnTakingFreshness } from "./turn-taking-coordinator-freshness.js";
import type { MatrixPreviewCore } from "./turn-taking-coordinator-preview-core.js";
import type { MatrixTurnTakingState } from "./turn-taking-coordinator-state.js";
import { PREVIEW_TOMBSTONE_TTL_MS } from "./turn-taking-coordinator-types.js";

export function createMatrixPreviewOutbound(input: {
  state: MatrixTurnTakingState;
  core: MatrixPreviewCore;
  freshness: MatrixTurnTakingFreshness;
}) {
  const { state, core, freshness } = input;
  const observeOutboundPreview = async (params: {
    roomId: string;
    originalEventId: string;
    sourceEventId: string;
    senderId: string;
    marker: MatrixOpenClawPreviewMarker;
    body: string;
    timestamp?: number;
  }): Promise<void> => {
    await state.previewLineageQueue.enqueue(state.roomScope(params.roomId), async () => {
      if (
        state.wasPreviewSourceRedacted(params.roomId, [
          params.originalEventId,
          params.sourceEventId,
        ])
      ) {
        return;
      }
      const envelope: MatrixOpenClawPreviewEnvelope = {
        marker: params.marker,
        sourceEvent: {
          event_id: params.sourceEventId,
          sender: params.senderId,
          type: "m.room.message",
          origin_server_ts: params.timestamp ?? state.now(),
          content: { msgtype: "m.text", body: params.body },
        },
        content: { msgtype: "m.text", body: params.body },
        ...(params.marker.revision > 0 ? { originalEventId: params.originalEventId } : {}),
        bundled: false,
      };
      if (params.marker.state === "in-progress") {
        const key = state.previewKey(params.roomId, params.originalEventId);
        const current = state.activePreviews.get(key);
        if (
          !current ||
          (core.previewLineageMatches(current.marker, params.marker) &&
            params.marker.revision > current.marker.revision)
        ) {
          core.rememberActivePreview({
            roomId: params.roomId,
            originalEventId: params.originalEventId,
            senderId: params.senderId,
            envelope,
          });
        }
        return;
      }
      const current = state.activePreviews.get(
        state.previewKey(params.roomId, params.originalEventId),
      );
      if (
        !current ||
        !core.previewLineageMatches(current.marker, params.marker) ||
        params.marker.revision <= current.marker.revision
      ) {
        return;
      }
      core.tombstonePreview({
        roomId: params.roomId,
        originalEventId: params.originalEventId,
        senderId: params.senderId,
        envelope,
      });
    });
  };
  const observeOutboundStandaloneFinalPart = async (params: {
    roomId: string;
    sourceEventId: string;
    senderId: string;
    marker: MatrixOpenClawPreviewMarker;
    body: string;
    timestamp?: number;
  }): Promise<void> => {
    await state.previewLineageQueue.enqueue(state.roomScope(params.roomId), async () => {
      if (state.wasPreviewSourceRedacted(params.roomId, [params.sourceEventId])) {
        return;
      }
      const result = core.processStandaloneFinalPart({
        roomId: params.roomId,
        senderId: params.senderId,
        envelope: {
          marker: params.marker,
          sourceEvent: {
            event_id: params.sourceEventId,
            sender: params.senderId,
            type: "m.room.message",
            origin_server_ts: params.timestamp ?? state.now(),
            content: { msgtype: "m.text", body: params.body },
          },
          content: { msgtype: "m.text", body: params.body },
          bundled: false,
        },
      });
      void result;
    });
  };
  const abandonOutboundStandaloneFinal = async (params: {
    roomId: string;
    senderId: string;
    responseId: string;
    sourceEventIds: readonly string[];
  }): Promise<void> => {
    await state.previewLineageQueue.enqueue(state.roomScope(params.roomId), async () => {
      const key = state.standaloneKey(params.roomId, params.senderId, params.responseId);
      const assembly = state.standaloneFinals.get(key);
      const terminal = state.standaloneFinalTombstones.get(key);
      if (!assembly && !terminal) {
        return;
      }
      for (const sourceEventId of params.sourceEventIds) {
        assembly?.sourceEventIds.add(sourceEventId);
        terminal?.sourceEventIds.add(sourceEventId);
        state.indexPreviewSource({ roomId: params.roomId, sourceEventId, lineageKey: key });
      }
      if (assembly) {
        assembly.redacted = true;
        assembly.observedAt = state.now();
      }
      if (terminal) {
        terminal.redacted = true;
        terminal.expiresAt = state.now() + PREVIEW_TOMBSTONE_TTL_MS;
      }
      const sourceEventIds = terminal?.sourceEventIds ?? assembly!.sourceEventIds;
      state.invalidatePreviewIngress(params.roomId, sourceEventIds);
      freshness.removeJournalEvents(params.roomId, sourceEventIds);
      if (terminal?.hadAuthorizedVisibility === true) {
        freshness.observePreviewTerminal({
          roomId: params.roomId,
          originalEventId: terminal.rootEventId,
          senderId: params.senderId,
          marker: terminal.marker,
          state: "abandoned",
        });
      }
    });
  };
  const observePreviewRedaction = async (params: {
    roomId: string;
    targetEventId: string;
  }): Promise<boolean> => {
    state.prune();
    return await state.previewLineageQueue.enqueue(state.roomScope(params.roomId), async () => {
      state.rememberEarlyPreviewRedaction(params.roomId, params.targetEventId);
      const indexedLineage = state.previewSourceIndex.get(
        state.sourceIndexKey(params.roomId, params.targetEventId),
      );
      if (!indexedLineage) {
        return false;
      }
      if (indexedLineage.startsWith("preview\u0000")) {
        const key = indexedLineage.slice("preview\u0000".length);
        const preview = state.activePreviews.get(key);
        const terminal = state.previewTombstones.get(key);
        if (terminal) {
          state.authorizedActivePreviews.delete(key);
          const wasAuthorized = terminal.hadAuthorizedVisibility;
          terminal.redacted = true;
          terminal.expiresAt = state.now() + PREVIEW_TOMBSTONE_TTL_MS;
          state.invalidatePreviewIngress(params.roomId, terminal.sourceEventIds);
          freshness.removeJournalEvents(params.roomId, terminal.sourceEventIds);
          if (wasAuthorized) {
            freshness.observePreviewTerminal({
              roomId: params.roomId,
              originalEventId: key.slice(`${params.roomId}\u0000`.length),
              senderId: terminal.senderId,
              marker: terminal.marker,
              state: "redacted",
            });
          }
          return true;
        }
        if (!preview) {
          return false;
        }
        const abandonedMarker: MatrixOpenClawPreviewMarker = {
          ...preview.marker,
          state: "abandoned",
          revision: preview.marker.revision + 1,
        };
        core.tombstonePreview({
          roomId: params.roomId,
          originalEventId: preview.originalEventId,
          senderId: preview.senderId,
          envelope: {
            marker: abandonedMarker,
            sourceEvent: {
              event_id: params.targetEventId,
              sender: preview.senderId,
              type: "m.room.message",
              origin_server_ts: state.now(),
              content: { msgtype: "m.text", body: preview.body },
            },
            content: { msgtype: "m.text", body: preview.body },
            originalEventId: preview.originalEventId,
            bundled: false,
          },
        });
        state.authorizedActivePreviews.delete(key);
        const closed = state.previewTombstones.get(key);
        if (closed) {
          const wasAuthorized = closed.hadAuthorizedVisibility;
          closed.redacted = true;
          state.invalidatePreviewIngress(params.roomId, closed.sourceEventIds);
          freshness.removeJournalEvents(params.roomId, closed.sourceEventIds);
          if (wasAuthorized) {
            freshness.observePreviewTerminal({
              roomId: params.roomId,
              originalEventId: preview.originalEventId,
              senderId: preview.senderId,
              marker: abandonedMarker,
              state: "redacted",
            });
          }
        }
        return true;
      }
      const standalone = state.standaloneFinals.get(indexedLineage);
      const standaloneTerminal = state.standaloneFinalTombstones.get(indexedLineage);
      if (!standalone && !standaloneTerminal) {
        return false;
      }
      const wasAuthorized = standaloneTerminal?.hadAuthorizedVisibility === true;
      if (standalone) {
        standalone.redacted = true;
        standalone.observedAt = state.now();
      }
      if (standaloneTerminal) {
        standaloneTerminal.redacted = true;
        standaloneTerminal.expiresAt = state.now() + PREVIEW_TOMBSTONE_TTL_MS;
      }
      const sourceEventIds = standaloneTerminal?.sourceEventIds ?? standalone!.sourceEventIds;
      state.invalidatePreviewIngress(params.roomId, sourceEventIds);
      freshness.removeJournalEvents(params.roomId, sourceEventIds);
      if (wasAuthorized && standaloneTerminal) {
        freshness.observePreviewTerminal({
          roomId: params.roomId,
          originalEventId: standaloneTerminal.rootEventId,
          senderId: standaloneTerminal.senderId,
          marker: standaloneTerminal.marker,
          state: "redacted",
        });
      }
      return true;
    });
  };
  return {
    observeOutboundPreview,
    observeOutboundStandaloneFinalPart,
    abandonOutboundStandaloneFinal,
    observePreviewRedaction,
  };
}
