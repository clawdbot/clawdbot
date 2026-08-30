import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  ActivePreview,
  CachedDecision,
  JournalEntry,
  PendingIngressEvent,
  PreparedPreviewIngress,
  PreviewTombstone,
  RegisteredMonitor,
  RoomMembership,
  StandaloneFinalAssembly,
  StandaloneFinalTombstone,
  MatrixReceiverAccessInput,
  MatrixReceiverView,
} from "./turn-taking-coordinator-types.js";
import {
  boundedMapSet,
  JOURNAL_TTL_MS,
  MATRIX_ACTIVE_PREVIEW_TTL_MS,
  MAX_EARLY_PREVIEW_REDACTIONS,
  MAX_OBSERVED_INGRESS_EVENTS,
  MAX_PREVIEW_TOMBSTONES,
  PREVIEW_TOMBSTONE_TTL_MS,
} from "./turn-taking-coordinator-types.js";

export function createMatrixTurnTakingState(options?: {
  now?: () => number;
  maxEarlyPreviewRedactions?: number;
}) {
  const now = options?.now ?? Date.now;
  const maxEarlyPreviewRedactions = Math.max(
    1,
    Math.trunc(options?.maxEarlyPreviewRedactions ?? MAX_EARLY_PREVIEW_REDACTIONS),
  );
  const monitors = new Map<string, RegisteredMonitor>();
  const prepareReceiverView = async (
    accountId: string,
    input: MatrixReceiverAccessInput,
  ): Promise<MatrixReceiverView | undefined> => {
    const monitor = monitors.get(accountId);
    const prepareAccess = monitor?.prepareAccess;
    if (!monitor || !prepareAccess) {
      return undefined;
    }
    const isCurrent = () =>
      monitors.get(accountId) === monitor && monitor.prepareAccess === prepareAccess;
    try {
      const access = await prepareAccess(input);
      if (!isCurrent()) {
        return undefined;
      }
      return {
        ...access,
        isCurrent,
        includesContext: (senderId) => isCurrent() && access.includesContext(senderId),
      };
    } catch (error) {
      monitor.log(
        `matrix turn-taking receiver access unavailable account=${accountId} room=${input.roomId}: ${String(error)}`,
      );
      return undefined;
    }
  };
  const roomMembership = new Map<string, RoomMembership>();
  const decisions = new Map<string, CachedDecision>();
  const roomJournal = new Map<string, JournalEntry[]>();
  const activePreviews = new Map<string, ActivePreview>();
  const authorizedActivePreviews = new Map<string, ActivePreview>();
  const previewTombstones = new Map<string, PreviewTombstone>();
  const standaloneFinals = new Map<string, StandaloneFinalAssembly>();
  const standaloneFinalTombstones = new Map<string, StandaloneFinalTombstone>();
  const previewSourceIndex = new Map<string, string>();
  const earlyPreviewRedactions = new Map<string, { roomId: string; expiresAt: number }>();
  const earlyPreviewRedactionOverflowRooms = new Map<string, number>();
  const previewIngress = new Map<
    string,
    { expiresAt: number; pending: Promise<PreparedPreviewIngress> }
  >();
  const pendingIngressEvents = new Map<string, PendingIngressEvent>();
  const observedIngressEvents = new Map<string, number>();
  const previewLineageQueue = new KeyedAsyncQueue();
  const ingressOrderingQueue = new KeyedAsyncQueue();
  let journalSequence = 0;
  let earlyPreviewRedactionCapacityOverflowUntil = 0;

  const roomScope = (roomId: string) => roomId;
  const journalScope = (roomId: string, threadId?: string) =>
    `${roomScope(roomId)}\u0000${threadId?.trim() || "main"}`;
  const previewKey = (roomId: string, originalEventId: string) =>
    `${roomScope(roomId)}\u0000${originalEventId}`;
  const standaloneKey = (roomId: string, senderId: string, responseId: string) =>
    `standalone\u0000${roomScope(roomId)}\u0000${senderId.trim()}\u0000${responseId}`;
  const previewLineageIndexKey = (roomId: string, originalEventId: string) =>
    `preview\u0000${previewKey(roomId, originalEventId)}`;
  const sourceIndexKey = (roomId: string, sourceEventId: string) =>
    `${roomScope(roomId)}\u0000${sourceEventId}`;
  const previewIngressKey = (accountId: string, roomId: string, sourceEventId: string) =>
    `${accountId}\u0000${roomScope(roomId)}\u0000${sourceEventId}`;
  const pendingIngressKey = (roomId: string, eventId: string) =>
    `${roomScope(roomId)}\u0000${eventId}`;

  const rememberEarlyPreviewRedaction = (roomId: string, targetEventId: string): void => {
    const key = sourceIndexKey(roomId, targetEventId);
    if (
      !earlyPreviewRedactions.has(key) &&
      earlyPreviewRedactions.size >= maxEarlyPreviewRedactions
    ) {
      const oldest = earlyPreviewRedactions.keys().next().value;
      if (oldest !== undefined) {
        const evicted = earlyPreviewRedactions.get(oldest);
        earlyPreviewRedactions.delete(oldest);
        if (evicted) {
          if (
            !earlyPreviewRedactionOverflowRooms.has(evicted.roomId) &&
            earlyPreviewRedactionOverflowRooms.size >= maxEarlyPreviewRedactions
          ) {
            earlyPreviewRedactionCapacityOverflowUntil = Math.max(
              earlyPreviewRedactionCapacityOverflowUntil,
              now() + PREVIEW_TOMBSTONE_TTL_MS,
            );
          }
          boundedMapSet(
            earlyPreviewRedactionOverflowRooms,
            evicted.roomId,
            Math.max(
              earlyPreviewRedactionOverflowRooms.get(evicted.roomId) ?? 0,
              now() + PREVIEW_TOMBSTONE_TTL_MS,
            ),
            maxEarlyPreviewRedactions,
          );
        }
      }
    }
    boundedMapSet(
      earlyPreviewRedactions,
      key,
      { roomId, expiresAt: now() + PREVIEW_TOMBSTONE_TTL_MS },
      maxEarlyPreviewRedactions,
    );
  };

  const wasPreviewSourceRedacted = (roomId: string, sourceEventIds: Iterable<string>): boolean => {
    const timestamp = now();
    if (earlyPreviewRedactionCapacityOverflowUntil > timestamp) {
      return true;
    }
    const overflowUntil = earlyPreviewRedactionOverflowRooms.get(roomId);
    if (overflowUntil !== undefined && overflowUntil > timestamp) {
      return true;
    }
    if (overflowUntil !== undefined) {
      earlyPreviewRedactionOverflowRooms.delete(roomId);
    }
    for (const sourceEventId of sourceEventIds) {
      const key = sourceIndexKey(roomId, sourceEventId);
      const redaction = earlyPreviewRedactions.get(key);
      if (!redaction) {
        continue;
      }
      if (redaction.expiresAt > timestamp) {
        return true;
      }
      earlyPreviewRedactions.delete(key);
    }
    return false;
  };

  const settlePendingIngress = (entry: PendingIngressEvent) => {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    if (pendingIngressEvents.get(entry.key) === entry) {
      pendingIngressEvents.delete(entry.key);
    }
    entry.resolve();
  };
  const settlePendingIngressForEvent = (roomId: string, eventId: string) => {
    const entry = pendingIngressEvents.get(pendingIngressKey(roomId, eventId));
    if (entry) {
      settlePendingIngress(entry);
    }
  };
  const expirePendingIngress = (entries: readonly PendingIngressEvent[]) => {
    for (const entry of entries) {
      settlePendingIngress(entry);
    }
  };
  const rememberObservedIngress = (roomId: string, eventId: string) => {
    boundedMapSet(
      observedIngressEvents,
      pendingIngressKey(roomId, eventId),
      now() + JOURNAL_TTL_MS,
      MAX_OBSERVED_INGRESS_EVENTS,
    );
  };
  const indexPreviewSource = (input: {
    roomId: string;
    sourceEventId: string;
    lineageKey: string;
  }) => {
    boundedMapSet(
      previewSourceIndex,
      sourceIndexKey(input.roomId, input.sourceEventId),
      input.lineageKey,
      MAX_PREVIEW_TOMBSTONES * 4,
    );
  };
  const dropIndexedLineage = (lineageKey: string) => {
    for (const [key, indexed] of previewSourceIndex) {
      if (indexed === lineageKey) {
        previewSourceIndex.delete(key);
      }
    }
  };
  const invalidatePreviewIngress = (roomId: string, sourceEventIds: Iterable<string>) => {
    const suffixes = new Set(
      [...sourceEventIds].map((eventId) => `\u0000${roomId}\u0000${eventId}`),
    );
    for (const key of previewIngress.keys()) {
      if ([...suffixes].some((suffix) => key.endsWith(suffix))) {
        previewIngress.delete(key);
      }
    }
  };
  const bumpJournalSequence = (): number => {
    journalSequence += 1;
    return journalSequence;
  };

  const prune = () => {
    const timestamp = now();
    for (const [key, value] of decisions) {
      if (value.expiresAt <= timestamp) {
        decisions.delete(key);
      }
    }
    for (const [scope, entries] of roomJournal) {
      const retained = entries.filter((entry) => timestamp - entry.observedAt <= JOURNAL_TTL_MS);
      if (retained.length === 0) {
        roomJournal.delete(scope);
      } else if (retained.length !== entries.length) {
        roomJournal.set(scope, retained);
      }
    }
    for (const [key, value] of activePreviews) {
      if (timestamp - value.observedAt > MATRIX_ACTIVE_PREVIEW_TTL_MS) {
        activePreviews.delete(key);
        authorizedActivePreviews.delete(key);
        dropIndexedLineage(previewLineageIndexKey(value.roomId, value.originalEventId));
      }
    }
    for (const [key, value] of authorizedActivePreviews) {
      if (
        (value.expiresAt !== undefined && value.expiresAt <= timestamp) ||
        (value.expiresAt === undefined &&
          timestamp - value.observedAt > MATRIX_ACTIVE_PREVIEW_TTL_MS)
      ) {
        authorizedActivePreviews.delete(key);
      }
    }
    for (const [key, value] of previewTombstones) {
      if (value.expiresAt <= timestamp) {
        previewTombstones.delete(key);
        dropIndexedLineage(`preview\u0000${key}`);
      }
    }
    for (const [key, value] of standaloneFinals) {
      if (timestamp - value.observedAt > PREVIEW_TOMBSTONE_TTL_MS) {
        standaloneFinals.delete(key);
        if (!standaloneFinalTombstones.has(key)) {
          dropIndexedLineage(key);
        }
      }
    }
    for (const [key, value] of standaloneFinalTombstones) {
      if (value.expiresAt <= timestamp) {
        standaloneFinalTombstones.delete(key);
        if (!standaloneFinals.has(key)) {
          dropIndexedLineage(key);
        }
      }
    }
    for (const [key, value] of previewIngress) {
      if (value.expiresAt <= timestamp) {
        previewIngress.delete(key);
      }
    }
    for (const [key, expiresAt] of observedIngressEvents) {
      if (expiresAt <= timestamp) {
        observedIngressEvents.delete(key);
      }
    }
    for (const [key, redaction] of earlyPreviewRedactions) {
      if (redaction.expiresAt <= timestamp) {
        earlyPreviewRedactions.delete(key);
      }
    }
    for (const [roomId, expiresAt] of earlyPreviewRedactionOverflowRooms) {
      if (expiresAt <= timestamp) {
        earlyPreviewRedactionOverflowRooms.delete(roomId);
      }
    }
    if (earlyPreviewRedactionCapacityOverflowUntil <= timestamp) {
      earlyPreviewRedactionCapacityOverflowUntil = 0;
    }
  };

  const clear = () => {
    roomMembership.clear();
    decisions.clear();
    roomJournal.clear();
    activePreviews.clear();
    authorizedActivePreviews.clear();
    previewTombstones.clear();
    standaloneFinals.clear();
    standaloneFinalTombstones.clear();
    previewSourceIndex.clear();
    earlyPreviewRedactions.clear();
    earlyPreviewRedactionOverflowRooms.clear();
    earlyPreviewRedactionCapacityOverflowUntil = 0;
    previewIngress.clear();
    expirePendingIngress([...pendingIngressEvents.values()]);
    observedIngressEvents.clear();
  };

  return {
    now,
    monitors,
    prepareReceiverView,
    roomMembership,
    decisions,
    roomJournal,
    activePreviews,
    authorizedActivePreviews,
    previewTombstones,
    standaloneFinals,
    standaloneFinalTombstones,
    previewSourceIndex,
    previewIngress,
    pendingIngressEvents,
    observedIngressEvents,
    previewLineageQueue,
    ingressOrderingQueue,
    roomScope,
    journalScope,
    previewKey,
    standaloneKey,
    previewLineageIndexKey,
    sourceIndexKey,
    previewIngressKey,
    pendingIngressKey,
    rememberEarlyPreviewRedaction,
    wasPreviewSourceRedacted,
    settlePendingIngress,
    expirePendingIngress,
    rememberObservedIngress,
    settlePendingIngressForEvent,
    indexPreviewSource,
    dropIndexedLineage,
    invalidatePreviewIngress,
    bumpJournalSequence,
    currentSequence: () => journalSequence,
    prune,
    clear,
  };
}

export type MatrixTurnTakingState = ReturnType<typeof createMatrixTurnTakingState>;
