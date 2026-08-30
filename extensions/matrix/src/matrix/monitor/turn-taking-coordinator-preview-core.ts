import { createHash } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  buildPromotedMatrixPreviewEvent,
  parseMatrixOpenClawPreviewEvent,
  type MatrixOpenClawPreviewEnvelope,
  type MatrixOpenClawPreviewMarker,
} from "../preview-protocol.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import type { MatrixTurnTakingState } from "./turn-taking-coordinator-state.js";
import type {
  ActivePreview,
  MatrixPreviewIngressResult,
  StandaloneFinalTombstone,
} from "./turn-taking-coordinator-types.js";
import {
  boundedMapSet,
  MATRIX_ACTIVE_PREVIEW_TTL_MS,
  MATRIX_TERMINAL_REPLAY_TTL_MS,
  MAX_ACTIVE_PREVIEWS,
  MAX_PREVIEW_TOMBSTONES,
  MAX_STANDALONE_FINAL_ASSEMBLIES,
  MAX_STANDALONE_FINAL_BODY_CHARS,
  MAX_STANDALONE_FINAL_PART_BODY_CHARS,
  MAX_STANDALONE_FINAL_TOMBSTONES,
  PREVIEW_TOMBSTONE_TTL_MS,
} from "./turn-taking-coordinator-types.js";

function normalizeFetchedPreviewEvent(value: unknown): MatrixRawEvent | undefined {
  const event = asOptionalRecord(value);
  const content = asOptionalRecord(event?.content);
  if (
    !event ||
    typeof event.event_id !== "string" ||
    typeof event.sender !== "string" ||
    typeof event.type !== "string" ||
    typeof event.origin_server_ts !== "number" ||
    !content ||
    (event.state_key !== undefined && typeof event.state_key !== "string") ||
    (event.redacts !== undefined && typeof event.redacts !== "string")
  ) {
    return undefined;
  }
  return {
    event_id: event.event_id,
    sender: event.sender,
    type: event.type,
    origin_server_ts: event.origin_server_ts,
    content,
    ...(typeof event.state_key === "string" ? { state_key: event.state_key } : {}),
    ...(typeof event.redacts === "string" ? { redacts: event.redacts } : {}),
  };
}

export function createMatrixPreviewCore(state: MatrixTurnTakingState) {
  const previewLineageMatches = (
    current: MatrixOpenClawPreviewMarker,
    next: MatrixOpenClawPreviewMarker,
  ): boolean =>
    current.responseId === next.responseId &&
    current.triggerEventId === next.triggerEventId &&
    current.threadId === next.threadId &&
    current.replyToId === next.replyToId &&
    current.partCount === next.partCount;
  const exactPreviewMarkerMatches = (
    current: MatrixOpenClawPreviewMarker,
    next: MatrixOpenClawPreviewMarker,
  ): boolean =>
    previewLineageMatches(current, next) &&
    current.state === next.state &&
    current.revision === next.revision &&
    current.kind === next.kind &&
    current.partIndex === next.partIndex;
  const rawPreviewBody = (envelope: MatrixOpenClawPreviewEnvelope): string =>
    typeof envelope.content.body === "string" ? envelope.content.body : "";
  const previewBody = (envelope: MatrixOpenClawPreviewEnvelope): string =>
    truncateUtf16Safe(rawPreviewBody(envelope).trim(), 4_000);
  const previewBodyHash = (envelope: MatrixOpenClawPreviewEnvelope): string =>
    createHash("sha256").update(rawPreviewBody(envelope), "utf8").digest("hex");
  const exactActivePreviewMatches = (input: {
    preview: ActivePreview;
    originalEventId: string;
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
  }): boolean =>
    input.preview.originalEventId === input.originalEventId &&
    input.preview.senderId === input.senderId &&
    input.preview.latestEventId === input.envelope.sourceEvent.event_id &&
    input.preview.sourceEventIds.has(input.envelope.sourceEvent.event_id) &&
    input.preview.bodyHash === previewBodyHash(input.envelope) &&
    exactPreviewMarkerMatches(input.preview.marker, input.envelope.marker);
  const previewAuthorizationExpiresAt = (input: {
    envelope: MatrixOpenClawPreviewEnvelope;
    incomingEvent: MatrixRawEvent;
    interceptedAt: number;
  }): number => {
    const windowMs =
      input.envelope.marker.state === "in-progress"
        ? MATRIX_ACTIVE_PREVIEW_TTL_MS
        : MATRIX_TERMINAL_REPLAY_TTL_MS;
    const localDeadline = input.interceptedAt + windowMs;
    const serverTimestamp = input.envelope.sourceEvent.origin_server_ts;
    if (typeof serverTimestamp === "number" && Number.isFinite(serverTimestamp)) {
      return Math.min(localDeadline, serverTimestamp + windowMs);
    }
    const sourceAge = input.envelope.sourceEvent.unsigned?.age ?? input.incomingEvent.unsigned?.age;
    if (typeof sourceAge === "number" && Number.isFinite(sourceAge) && sourceAge >= 0) {
      return Math.min(localDeadline, input.interceptedAt + Math.max(0, windowMs - sourceAge));
    }
    return localDeadline;
  };
  const rememberActivePreview = (input: {
    roomId: string;
    originalEventId: string;
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
  }): boolean => {
    const key = state.previewKey(input.roomId, input.originalEventId);
    const prior = state.activePreviews.get(key);
    if (
      prior &&
      (!previewLineageMatches(prior.marker, input.envelope.marker) ||
        input.envelope.marker.revision <= prior.marker.revision)
    ) {
      return false;
    }
    const sourceEventIds = new Set(prior?.sourceEventIds ?? []);
    sourceEventIds.add(input.originalEventId);
    sourceEventIds.add(input.envelope.sourceEvent.event_id);
    const lineageKey = state.previewLineageIndexKey(input.roomId, input.originalEventId);
    for (const sourceEventId of sourceEventIds) {
      state.indexPreviewSource({ roomId: input.roomId, sourceEventId, lineageKey });
    }
    boundedMapSet(
      state.activePreviews,
      key,
      {
        sequence: 0,
        roomId: input.roomId,
        ...(input.envelope.marker.threadId ? { threadId: input.envelope.marker.threadId } : {}),
        originalEventId: input.originalEventId,
        latestEventId: input.envelope.sourceEvent.event_id,
        senderId: input.senderId,
        marker: input.envelope.marker,
        body: previewBody(input.envelope),
        bodyHash: previewBodyHash(input.envelope),
        observedAt: state.now(),
        ...(Number.isFinite(input.envelope.sourceEvent.origin_server_ts)
          ? { serverTimestamp: input.envelope.sourceEvent.origin_server_ts }
          : {}),
        sourceEventIds,
      },
      MAX_ACTIVE_PREVIEWS,
    );
    return true;
  };
  const rememberAuthorizedActivePreview = (input: {
    roomId: string;
    originalEventId: string;
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
    expiresAt: number;
  }): boolean => {
    const key = state.previewKey(input.roomId, input.originalEventId);
    const transport = state.activePreviews.get(key);
    if (
      !transport ||
      !exactActivePreviewMatches({
        preview: transport,
        originalEventId: input.originalEventId,
        senderId: input.senderId,
        envelope: input.envelope,
      })
    ) {
      return false;
    }
    const prior = state.authorizedActivePreviews.get(key);
    // Multiple receivers authorize the same immutable Matrix event. Their
    // repeated observation is valid but must not invent newer room activity.
    if (prior && exactActivePreviewMatches({ preview: prior, ...input })) {
      return true;
    }
    if (
      prior &&
      (!previewLineageMatches(prior.marker, input.envelope.marker) ||
        input.envelope.marker.revision <= prior.marker.revision)
    ) {
      return false;
    }
    const sourceEventIds = new Set(prior?.sourceEventIds ?? []);
    sourceEventIds.add(input.originalEventId);
    sourceEventIds.add(input.envelope.sourceEvent.event_id);
    boundedMapSet(
      state.authorizedActivePreviews,
      key,
      {
        sequence: state.bumpJournalSequence(),
        roomId: input.roomId,
        ...(input.envelope.marker.threadId ? { threadId: input.envelope.marker.threadId } : {}),
        originalEventId: input.originalEventId,
        latestEventId: input.envelope.sourceEvent.event_id,
        senderId: input.senderId,
        marker: input.envelope.marker,
        body: previewBody(input.envelope),
        bodyHash: previewBodyHash(input.envelope),
        observedAt: input.expiresAt - MATRIX_ACTIVE_PREVIEW_TTL_MS,
        expiresAt: input.expiresAt,
        ...(Number.isFinite(input.envelope.sourceEvent.origin_server_ts)
          ? { serverTimestamp: input.envelope.sourceEvent.origin_server_ts }
          : {}),
        sourceEventIds,
      },
      MAX_ACTIVE_PREVIEWS,
    );
    return true;
  };
  const buildPreviewAccessEvent = (input: {
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
  }): MatrixRawEvent => ({
    event_id: input.envelope.sourceEvent.event_id,
    sender: input.senderId,
    type: "m.room.message",
    origin_server_ts: input.envelope.sourceEvent.origin_server_ts,
    content: {
      msgtype: input.envelope.content.msgtype === "m.notice" ? "m.notice" : "m.text",
      body: typeof input.envelope.content.body === "string" ? input.envelope.content.body : "",
    },
    __openclawTrustedEnhancedFinal: true,
  });
  const tombstonePreview = (input: {
    roomId: string;
    originalEventId: string;
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
  }): void => {
    const key = state.previewKey(input.roomId, input.originalEventId);
    const active = state.activePreviews.get(key);
    const hadAuthorizedVisibility =
      state.previewTombstones.get(key)?.hadAuthorizedVisibility === true ||
      state.authorizedActivePreviews.has(key);
    const sourceEventIds = new Set(active?.sourceEventIds ?? []);
    sourceEventIds.add(input.originalEventId);
    sourceEventIds.add(input.envelope.sourceEvent.event_id);
    const lineageKey = state.previewLineageIndexKey(input.roomId, input.originalEventId);
    for (const sourceEventId of sourceEventIds) {
      state.indexPreviewSource({ roomId: input.roomId, sourceEventId, lineageKey });
    }
    state.activePreviews.delete(key);
    boundedMapSet(
      state.previewTombstones,
      key,
      {
        expiresAt: state.now() + PREVIEW_TOMBSTONE_TTL_MS,
        senderId: input.senderId,
        marker: input.envelope.marker,
        sourceEventId: input.envelope.sourceEvent.event_id,
        sourceEventIds,
        body: previewBody(input.envelope),
        hadAuthorizedVisibility,
        redacted: false,
      },
      MAX_PREVIEW_TOMBSTONES,
    );
  };
  const resolveOriginalPreview = async (input: {
    client: MatrixClient;
    roomId: string;
    originalEventId: string;
    senderId: string;
  }): Promise<ActivePreview | undefined> => {
    const key = state.previewKey(input.roomId, input.originalEventId);
    const existing = state.activePreviews.get(key);
    if (existing) {
      return existing;
    }
    try {
      const fetched = normalizeFetchedPreviewEvent(
        await input.client.getEvent(input.roomId, input.originalEventId),
      );
      if (!fetched) {
        return undefined;
      }
      const parsed = parseMatrixOpenClawPreviewEvent(fetched);
      if (
        parsed.kind !== "preview" ||
        parsed.envelope.originalEventId ||
        fetched.sender !== input.senderId
      ) {
        return undefined;
      }
      rememberActivePreview({
        roomId: input.roomId,
        originalEventId: input.originalEventId,
        senderId: input.senderId,
        envelope: parsed.envelope,
      });
      return state.activePreviews.get(key);
    } catch {
      return undefined;
    }
  };
  const processStandaloneFinalPart = (input: {
    roomId: string;
    senderId: string;
    envelope: MatrixOpenClawPreviewEnvelope;
    receiverAccountId?: string;
  }): MatrixPreviewIngressResult => {
    const { marker, sourceEvent } = input.envelope;
    const { partIndex, partCount } = marker;
    const body = typeof input.envelope.content.body === "string" ? input.envelope.content.body : "";
    if (
      marker.state !== "final" ||
      marker.revision !== 0 ||
      partIndex === undefined ||
      partCount === undefined ||
      !body.trim()
    ) {
      return { kind: "consume", reason: "invalid standalone final part" };
    }
    const key = state.standaloneKey(input.roomId, input.senderId, marker.responseId);
    const terminal = state.standaloneFinalTombstones.get(key);
    if (terminal) {
      terminal.expiresAt = state.now() + PREVIEW_TOMBSTONE_TTL_MS;
      if (
        terminal.redacted ||
        terminal.senderId !== input.senderId ||
        !previewLineageMatches(terminal.marker, marker)
      ) {
        return { kind: "consume", reason: "standalone final lineage already closed" };
      }
      const expectedEventId = terminal.partEventIds.get(partIndex);
      if (expectedEventId && expectedEventId !== sourceEvent.event_id) {
        return { kind: "consume", reason: "conflicting standalone final replay" };
      }
      if (input.receiverAccountId && terminal.promotedAccounts.has(input.receiverAccountId)) {
        return { kind: "consume", reason: "standalone final already promoted" };
      }
    }
    let assembly = state.standaloneFinals.get(key);
    if (!assembly) {
      assembly = {
        roomId: input.roomId,
        senderId: input.senderId,
        responseId: marker.responseId,
        observedAt: state.now(),
        marker,
        parts: new Map(),
        sourceEventIds: new Set(),
        promotedAccounts: new Set(terminal?.promotedAccounts),
        redacted: false,
        bodyChars: 0,
      };
      boundedMapSet(state.standaloneFinals, key, assembly, MAX_STANDALONE_FINAL_ASSEMBLIES);
    }
    assembly.observedAt = state.now();
    if (
      assembly.redacted ||
      assembly.senderId !== input.senderId ||
      !previewLineageMatches(assembly.marker, marker)
    ) {
      assembly.redacted = true;
      return { kind: "consume", reason: "invalid standalone final lineage" };
    }
    if (
      body.length > MAX_STANDALONE_FINAL_PART_BODY_CHARS ||
      (!assembly.parts.has(partIndex) &&
        assembly.bodyChars + body.length > MAX_STANDALONE_FINAL_BODY_CHARS)
    ) {
      assembly.redacted = true;
      return { kind: "consume", reason: "standalone final exceeds bounded body budget" };
    }
    const existing = assembly.parts.get(partIndex);
    if (
      existing &&
      (existing.eventId !== sourceEvent.event_id ||
        existing.body !== body ||
        !exactPreviewMarkerMatches(existing.envelope.marker, marker))
    ) {
      assembly.redacted = true;
      return { kind: "consume", reason: "conflicting standalone final part" };
    }
    if (!existing) {
      assembly.parts.set(partIndex, {
        eventId: sourceEvent.event_id,
        envelope: input.envelope,
        body,
      });
      assembly.bodyChars += body.length;
      assembly.sourceEventIds.add(sourceEvent.event_id);
      state.indexPreviewSource({
        roomId: input.roomId,
        sourceEventId: sourceEvent.event_id,
        lineageKey: key,
      });
    }
    if (!assembly.promotedEvent && assembly.parts.size === partCount) {
      const ordered = Array.from({ length: partCount }, (_, index) => assembly!.parts.get(index));
      if (ordered.some((part) => !part)) {
        return { kind: "consume", reason: "standalone final awaiting parts" };
      }
      const first = ordered[0]!;
      const promoted = buildPromotedMatrixPreviewEvent({
        envelope: {
          ...first.envelope,
          content: {
            msgtype: first.envelope.content.msgtype,
            body: ordered.map((part) => part!.body).join("\n"),
          },
        },
        originalEventId: first.eventId,
        senderId: input.senderId,
      });
      if (!promoted) {
        assembly.redacted = true;
        return { kind: "consume", reason: "invalid standalone final content" };
      }
      assembly.promotedEvent = promoted;
      const completed: StandaloneFinalTombstone = {
        expiresAt: state.now() + PREVIEW_TOMBSTONE_TTL_MS,
        roomId: input.roomId,
        senderId: input.senderId,
        responseId: marker.responseId,
        marker: first.envelope.marker,
        rootEventId: first.eventId,
        sourceEventIds: new Set(assembly.sourceEventIds),
        partEventIds: new Map(ordered.map((part, index) => [index, part!.eventId] as const)),
        promotedAccounts: assembly.promotedAccounts,
        hadAuthorizedVisibility: terminal?.hadAuthorizedVisibility === true,
        redacted: false,
      };
      boundedMapSet(
        state.standaloneFinalTombstones,
        key,
        completed,
        MAX_STANDALONE_FINAL_TOMBSTONES,
      );
    }
    if (!assembly.promotedEvent) {
      return { kind: "consume", reason: "standalone final awaiting parts" };
    }
    if (!input.receiverAccountId) {
      return {
        kind: "promote",
        event: assembly.promotedEvent,
        observationId: sourceEvent.event_id,
      };
    }
    if (assembly.promotedAccounts.has(input.receiverAccountId)) {
      return { kind: "consume", reason: "standalone final already promoted" };
    }
    assembly.promotedAccounts.add(input.receiverAccountId);
    state.standaloneFinalTombstones.get(key)?.promotedAccounts.add(input.receiverAccountId);
    return { kind: "promote", event: assembly.promotedEvent, observationId: sourceEvent.event_id };
  };
  return {
    previewLineageMatches,
    exactPreviewMarkerMatches,
    previewBody,
    exactActivePreviewMatches,
    previewAuthorizationExpiresAt,
    rememberActivePreview,
    rememberAuthorizedActivePreview,
    buildPreviewAccessEvent,
    tombstonePreview,
    resolveOriginalPreview,
    processStandaloneFinalPart,
  };
}

export type MatrixPreviewCore = ReturnType<typeof createMatrixPreviewCore>;
