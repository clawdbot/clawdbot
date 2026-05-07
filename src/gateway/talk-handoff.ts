import { createHash, randomBytes, randomUUID } from "node:crypto";
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

export type TalkHandoffCreateParams = {
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

export type TalkHandoffRecord = {
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

export type TalkHandoffPublicRecord = Omit<TalkHandoffRecord, "tokenHash" | "room"> & {
  room: {
    activeClientId?: string;
    activeTurnId?: string;
    recentTalkEvents: TalkEvent[];
  };
};

export type TalkHandoffCreateResult = TalkHandoffPublicRecord & {
  token: string;
};

export type TalkHandoffJoinResult =
  | {
      ok: true;
      record: TalkHandoffPublicRecord;
      events: TalkEvent[];
      replacedClientId?: string;
      replacementEvents: TalkEvent[];
      activeClientEvents: TalkEvent[];
    }
  | { ok: false; reason: "not_found" | "expired" | "invalid_token" };

export type TalkHandoffRevokeResult = {
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

export function createTalkHandoff(params: TalkHandoffCreateParams): TalkHandoffCreateResult {
  pruneExpiredTalkHandoffs();
  const createdAt = Date.now();
  const ttlMs = normalizeTtlMs(params.ttlMs);
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
    expiresAt: createdAt + ttlMs,
    room,
  };
  appendTalkHandoffRoomEvent(record, {
    type: "session.started",
    payload: { handoffId: id, roomId },
  });
  handoffs.set(id, record);
  return { ...toPublicTalkHandoffRecord(record), token };
}

export function getTalkHandoff(id: string): TalkHandoffRecord | undefined {
  pruneExpiredTalkHandoffs();
  return handoffs.get(id);
}

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

export function verifyTalkHandoffToken(record: TalkHandoffRecord, token: string): boolean {
  return record.tokenHash === hashTalkHandoffToken(token);
}

export function clearTalkHandoffsForTest(): void {
  handoffs.clear();
}

function normalizeTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_TALK_HANDOFF_TTL_MS;
  }
  return Math.min(Math.max(Math.trunc(value), 1000), MAX_TALK_HANDOFF_TTL_MS);
}

function pruneExpiredTalkHandoffs(now = Date.now()): void {
  for (const [id, record] of handoffs) {
    if (record.expiresAt <= now) {
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
  return createHash("sha256").update(token).digest("base64url");
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
  if (record.expiresAt <= Date.now()) {
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

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
