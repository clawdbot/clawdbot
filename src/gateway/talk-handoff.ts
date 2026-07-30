// Gateway Talk handoff registry.
// Manages short-lived browser Talk rooms, tokens, events, and turn ownership.
import { randomBytes, randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { recordTalkObservabilityEvent } from "../talk/observability.js";
import {
  createTalkSessionController,
  type TalkBrain,
  type TalkEvent,
  type TalkEventInput,
  type TalkMode,
  type TalkSessionController,
  type TalkTransport,
} from "../talk/talk-session-controller.js";

const DEFAULT_TALK_HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_TALK_HANDOFF_TTL_MS = 60 * 60 * 1000;

/** Inputs captured when a gateway caller creates a managed Talk room. */
type TalkHandoffCreateParams = {
  sessionKey: string;
  sessionId?: string;
  channel?: string;
  target?: string;
  provider?: string;
  model?: string;
  voice?: string;
  mode?: TalkMode;
  transport?: TalkTransport;
  brain?: TalkBrain;
  ttlMs?: number;
};

/** Private handoff state, including the hashed room token and event controller. */
type TalkHandoffRecord = {
  id: string;
  roomId: string;
  roomUrl: string;
  tokenHash: string;
  sessionKey: string;
  sessionId?: string;
  channel?: string;
  target?: string;
  provider?: string;
  model?: string;
  voice?: string;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  createdAt: number;
  expiresAt: number;
  room: TalkHandoffRoomState;
};

/** Public handoff shape returned to clients; never includes token material. */
type TalkHandoffPublicRecord = Omit<TalkHandoffRecord, "tokenHash" | "room"> & {
  room: {
    activeClientId?: string;
    activeTurnId?: string;
    recentTalkEvents: TalkEvent[];
  };
};

type TalkHandoffCreateResult = TalkHandoffPublicRecord & {
  token: string;
};

type TalkHandoffJoinResult =
  | {
      ok: true;
      record: TalkHandoffPublicRecord;
      events: TalkEvent[];
      replacedClientId?: string;
      replacementEvents: TalkEvent[];
      activeClientEvents: TalkEvent[];
    }
  | { ok: false; reason: "not_found" | "expired" | "invalid_token" };

type TalkHandoffRevokeResult = {
  revoked: boolean;
  roomId?: string;
  activeClientId?: string;
  events: TalkEvent[];
};

export type TalkHandoffTurnResult =
  | {
      ok: true;
      record: TalkHandoffPublicRecord;
      turnId: string;
      events: TalkEvent[];
    }
  | {
      ok: false;
      reason: "not_found" | "expired" | "invalid_token" | "no_active_turn" | "stale_turn";
    };

type TalkHandoffRoomState = {
  activeClientId?: string;
  talk: TalkSessionController;
};

const handoffs = new Map<string, TalkHandoffRecord>();

/** Creates a short-lived Talk room and returns the only plaintext join token. */
export function createTalkHandoff(params: TalkHandoffCreateParams): TalkHandoffCreateResult {
  pruneExpiredTalkHandoffs();
  const rawCreatedAt = Date.now();
  const createdAt = resolveDateTimestampMs(rawCreatedAt);
  const ttlMs = normalizeTtlMs(params.ttlMs);
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawCreatedAt }) ?? 0;
  const id = randomUUID();
  const roomId = `talk_${id}`;
  const token = randomBytes(32).toString("base64url");
  const room = createTalkHandoffRoom({
    roomId,
    mode: params.mode ?? "stt-tts",
    transport: params.transport ?? "managed-room",
    brain: params.brain ?? "agent-consult",
    provider: params.provider,
  });
  const record: TalkHandoffRecord = {
    id,
    roomId,
    roomUrl: `/talk/rooms/${roomId}`,
    tokenHash: hashTalkHandoffToken(token),
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    channel: params.channel,
    target: params.target,
    provider: params.provider,
    model: params.model,
    voice: params.voice,
    mode: params.mode ?? "stt-tts",
    transport: params.transport ?? "managed-room",
    brain: params.brain ?? "agent-consult",
    createdAt,
    expiresAt,
    room,
  };
  appendTalkHandoffRoomEvent(record, {
    type: "session.started",
    payload: { handoffId: id, roomId },
  });
  handoffs.set(id, record);
  return { ...toPublicTalkHandoffRecord(record), token };
}

/** Returns a non-expired handoff record for gateway-internal callers. */
export function getTalkHandoff(id: string): TalkHandoffRecord | undefined {
  pruneExpiredTalkHandoffs();
  return handoffs.get(id);
}

/** Joins a managed room, replacing any previous active client for that room. */
export function joinTalkHandoff(
  id: string,
  token: string,
  opts: { clientId?: string } = {},
): TalkHandoffJoinResult {
  const access = resolveTalkHandoffAccess(id, token);
  if (!access.ok) {
    return access;
  }
  const record = access.record;
  const previousClientId = record.room.activeClientId;
  const events = joinTalkHandoffRoom(record, opts.clientId);
  const replacedClientId =
    previousClientId && previousClientId !== opts.clientId ? previousClientId : undefined;
  const replacementEvents = replacedClientId
    ? events.filter((event) => event.type === "session.replaced")
    : [];
  const activeClientEvents = replacedClientId
    ? events.filter((event) => event.type !== "session.replaced")
    : events;
  return {
    ok: true,
    record: toPublicTalkHandoffRecord(record),
    events,
    replacedClientId,
    replacementEvents,
    activeClientEvents,
  };
}

/** Starts a client turn in a joined managed room. */
export function startTalkHandoffTurn(
  id: string,
  token: string,
  opts: { turnId?: string; clientId?: string } = {},
): TalkHandoffTurnResult {
  const access = resolveTalkHandoffAccess(id, token);
  if (!access.ok) {
    return access;
  }
  const record = access.record;
  if (opts.clientId) {
    record.room.activeClientId = opts.clientId;
  }
  const turnId = normalizeOptionalString(opts.turnId) ?? randomUUID();
  const turn = record.room.talk.startTurn({
    turnId,
    payload: { handoffId: id, roomId: record.roomId, clientId: record.room.activeClientId },
  });
  return {
    ok: true,
    record: toPublicTalkHandoffRecord(record),
    turnId,
    events: turn.event ? [turn.event] : [],
  };
}

/** Ends the active managed-room turn and returns the emitted Talk event. */
export function endTalkHandoffTurn(
  id: string,
  token: string,
  opts: { turnId?: string } = {},
): TalkHandoffTurnResult {
  const access = resolveTalkHandoffAccess(id, token);
  if (!access.ok) {
    return access;
  }
  const record = access.record;
  const result = record.room.talk.endTurn({
    turnId: normalizeOptionalString(opts.turnId),
    payload: { handoffId: id, roomId: record.roomId },
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    record: toPublicTalkHandoffRecord(record),
    turnId: result.turnId,
    events: [result.event],
  };
}

/** Cancels the active managed-room turn with a client-visible reason. */
export function cancelTalkHandoffTurn(
  id: string,
  token: string,
  opts: { reason?: string; turnId?: string } = {},
): TalkHandoffTurnResult {
  const access = resolveTalkHandoffAccess(id, token);
  if (!access.ok) {
    return access;
  }
  const record = access.record;
  const result = record.room.talk.cancelTurn({
    turnId: normalizeOptionalString(opts.turnId),
    payload: { handoffId: id, roomId: record.roomId, reason: opts.reason ?? "client-cancelled" },
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    record: toPublicTalkHandoffRecord(record),
    turnId: result.turnId,
    events: [result.event],
  };
}

/** Revokes a handoff and emits the final room-close event if it existed. */
export function revokeTalkHandoff(id: string): TalkHandoffRevokeResult {
  pruneExpiredTalkHandoffs();
  const record = handoffs.get(id);
  if (!record) {
    return { revoked: false, events: [] };
  }
  const event = appendTalkHandoffRoomEvent(record, {
    type: "session.closed",
    payload: { reason: "revoked", handoffId: id, roomId: record.roomId },
    final: true,
  });
  handoffs.delete(id);
  return {
    revoked: true,
    roomId: record.roomId,
    activeClientId: record.room.activeClientId,
    events: [event],
  };
}

/** Verifies the caller token without exposing the stored token hash. */
function verifyTalkHandoffToken(record: TalkHandoffRecord, token: string): boolean {
  return record.tokenHash === hashTalkHandoffToken(token);
}

function normalizeTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_TALK_HANDOFF_TTL_MS;
  }
  return Math.min(Math.max(Math.trunc(value), 1000), MAX_TALK_HANDOFF_TTL_MS);
}

function pruneExpiredTalkHandoffs(now = Date.now()): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    return;
  }
  for (const [id, record] of handoffs) {
    if (!isFutureDateTimestampMs(record.expiresAt, { nowMs: validNow })) {
      appendTalkHandoffRoomEvent(record, {
        type: "session.closed",
        payload: { reason: "expired", handoffId: id, roomId: record.roomId },
        final: true,
      });
      handoffs.delete(id);
    }
  }
}

function hashTalkHandoffToken(token: string): string {
  return sha256Base64Url(token);
}

function toPublicTalkHandoffRecord(record: TalkHandoffRecord): TalkHandoffPublicRecord {
  const { tokenHash: _tokenHash, room: _room, ...publicRecord } = record;
  return {
    ...publicRecord,
    room: {
      activeClientId: record.room.activeClientId,
      activeTurnId: record.room.talk.activeTurnId,
      recentTalkEvents: [...record.room.talk.recentEvents],
    },
  };
}

function createTalkHandoffRoom(params: {
  roomId: string;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
}): TalkHandoffRoomState {
  return {
    talk: createTalkSessionController(
      {
        sessionId: params.roomId,
        mode: params.mode,
        transport: params.transport,
        brain: params.brain,
        provider: params.provider,
      },
      { onEvent: recordTalkObservabilityEvent },
    ),
  };
}

function resolveTalkHandoffAccess(
  id: string,
  token: string,
):
  | { ok: true; record: TalkHandoffRecord }
  | { ok: false; reason: "not_found" | "expired" | "invalid_token" } {
  const record = handoffs.get(id);
  if (!record) {
    return { ok: false, reason: "not_found" };
  }
  if (!isFutureDateTimestampMs(record.expiresAt)) {
    // Expiry emits the same close event as explicit revocation so room clients
    // can reconcile state without knowing which cleanup path won the race.
    appendTalkHandoffRoomEvent(record, {
      type: "session.closed",
      payload: { reason: "expired", handoffId: id, roomId: record.roomId },
      final: true,
    });
    handoffs.delete(id);
    return { ok: false, reason: "expired" };
  }
  if (!verifyTalkHandoffToken(record, token)) {
    return { ok: false, reason: "invalid_token" };
  }
  return { ok: true, record };
}

function appendTalkHandoffRoomEvent(record: TalkHandoffRecord, input: TalkEventInput): TalkEvent {
  return record.room.talk.emit(input);
}

function joinTalkHandoffRoom(record: TalkHandoffRecord, clientId: string | undefined): TalkEvent[] {
  const events: TalkEvent[] = [];
  if (record.room.activeClientId && record.room.activeClientId !== clientId) {
    events.push(
      appendTalkHandoffRoomEvent(record, {
        type: "session.replaced",
        payload: {
          handoffId: record.id,
          roomId: record.roomId,
          previousClientId: record.room.activeClientId,
          nextClientId: clientId,
        },
      }),
    );
  }
  record.room.activeClientId = clientId;
  events.push(
    appendTalkHandoffRoomEvent(record, {
      type: "session.ready",
      payload: { handoffId: record.id, roomId: record.roomId, clientId },
    }),
  );
  return events;
}
