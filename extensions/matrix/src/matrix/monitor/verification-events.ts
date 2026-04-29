import type { MatrixClient } from "../sdk.js";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";
import {
  isMatrixVerificationEventType,
  isMatrixVerificationRequestMsgType,
  matrixVerificationConstants,
} from "./verification-utils.js";

const MAX_TRACKED_VERIFICATION_EVENTS = 1024;
const SAS_NOTICE_RETRY_DELAY_MS = 750;
const VERIFICATION_EVENT_STARTUP_GRACE_MS = 30_000;

type MatrixVerificationStage = "request" | "ready" | "start" | "cancel" | "done" | "other";

type MatrixVerificationSummaryLike = {
  id: string;
  transactionId?: string;
  roomId?: string;
  otherUserId: string;
  updatedAt?: string;
  completed?: boolean;
  pending?: boolean;
  phase?: number;
  phaseName?: string;
  sas?: {
    decimal?: [number, number, number];
    emoji?: Array<[string, string]>;
  };
};

type MatrixDirectRoomDeps = {
  inspectMatrixDirectRooms: typeof import("../direct-management.js").inspectMatrixDirectRooms;
  isStrictDirectRoom: typeof import("../direct-room.js").isStrictDirectRoom;
};

let matrixDirectRoomDepsPromise: Promise<MatrixDirectRoomDeps> | undefined;

async function loadMatrixDirectRoomDeps(): Promise<MatrixDirectRoomDeps> {
  matrixDirectRoomDepsPromise ??= Promise.all([
    import("../direct-management.js"),
    import("../direct-room.js"),
  ]).then(([directManagementModule, directRoomModule]) => ({
    inspectMatrixDirectRooms: directManagementModule.inspectMatrixDirectRooms,
    isStrictDirectRoom: directRoomModule.isStrictDirectRoom,
  }));
  return await matrixDirectRoomDepsPromise;
}

function trimMaybeString(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readVerificationSignal(event: MatrixRawEvent): {
  stage: MatrixVerificationStage;
  flowId: string | null;
} | null {
  const type = trimMaybeString(event?.type) ?? "";
  const content = event?.content ?? {};
  const msgtype = trimMaybeString((content as { msgtype?: unknown }).msgtype) ?? "";
  const relatedEventId = trimMaybeString(
    (content as { "m.relates_to"?: { event_id?: unknown } })["m.relates_to"]?.event_id,
  );
  const transactionId = trimMaybeString((content as { transaction_id?: unknown }).transaction_id);
  if (type === EventType.RoomMessage && isMatrixVerificationRequestMsgType(msgtype)) {
    return {
      stage: "request",
      flowId: trimMaybeString(event.event_id) ?? transactionId ?? relatedEventId,
    };
  }
  if (!isMatrixVerificationEventType(type)) {
    return null;
  }
  const flowId = transactionId ?? relatedEventId ?? trimMaybeString(event.event_id);
  if (type === `${matrixVerificationConstants.eventPrefix}request`) {
    return { stage: "request", flowId };
  }
  if (type === `${matrixVerificationConstants.eventPrefix}ready`) {
    return { stage: "ready", flowId };
  }
  if (type === "m.key.verification.start") {
    return { stage: "start", flowId };
  }
  if (type === "m.key.verification.cancel") {
    return { stage: "cancel", flowId };
  }
  if (type === "m.key.verification.done") {
    return { stage: "done", flowId };
  }
  return { stage: "other", flowId };
}

function formatVerificationStageNotice(params: {
  stage: MatrixVerificationStage;
  senderId: string;
  event: MatrixRawEvent;
}): string | null {
  const { stage, senderId, event } = params;
  const content = event.content as { code?: unknown; reason?: unknown };
  switch (stage) {
    case "request":
      return `Matrix verification request received from ${senderId}. Open "Verify by emoji" in your Matrix client to continue.`;
    case "ready":
      return `Matrix verification is ready with ${senderId}. Choose "Verify by emoji" to reveal the emoji sequence.`;
    case "start":
      return `Matrix verification started with ${senderId}.`;
    case "done":
      return `Matrix verification completed with ${senderId}.`;
    case "cancel": {
      const code = trimMaybeString(content.code);
      const reason = trimMaybeString(content.reason);
      if (code && reason) {
        return `Matrix verification cancelled by ${senderId} (${code}: ${reason}).`;
      }
      if (reason) {
        return `Matrix verification cancelled by ${senderId} (${reason}).`;
      }
      return `Matrix verification cancelled by ${senderId}.`;
    }
    default:
      return null;
  }
}

function formatVerificationSasNotice(summary: MatrixVerificationSummaryLike): string | null {
  const sas = summary.sas;
  if (!sas) {
    return null;
  }
  const emojiLine =
    Array.isArray(sas.emoji) && sas.emoji.length > 0
      ? `SAS emoji: ${sas.emoji
          .map(
            ([emoji, name]) => `${trimMaybeString(emoji) ?? "?"} ${trimMaybeString(name) ?? "?"}`,
          )
          .join(" | ")}`
      : null;
  const decimalLine =
    Array.isArray(sas.decimal) && sas.decimal.length === 3
      ? `SAS decimal: ${sas.decimal.join(" ")}`
      : null;
  if (!emojiLine && !decimalLine) {
    return null;
  }
  const lines = [`Matrix verification SAS with ${summary.otherUserId}:`];
  if (emojiLine) {
    lines.push(emojiLine);
  }
  if (decimalLine) {
    lines.push(decimalLine);
  }
  lines.push("If both sides match, choose 'They match' in your Matrix app.");
  return lines.join("\n");
}

function resolveVerificationFlowCandidates(params: {
  event: MatrixRawEvent;
  flowId: string | null;
}): string[] {
  const { event, flowId } = params;
  const content = event.content as {
    transaction_id?: unknown;
    "m.relates_to"?: { event_id?: unknown };
  };
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    const normalized = trimMaybeString(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };
  add(flowId);
  add(event.event_id);
  add(content.transaction_id);
  add(content["m.relates_to"]?.event_id);
  return Array.from(candidates);
}

function resolveSummaryRecency(summary: MatrixVerificationSummaryLike): number {
  const ts = Date.parse(summary.updatedAt ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

function isActiveVerificationSummary(summary: MatrixVerificationSummaryLike): boolean {
  if (summary.completed === true) {
    return false;
  }
  if (summary.phaseName === "cancelled" || summary.phaseName === "done") {
    return false;
  }
  if (typeof summary.phase === "number" && summary.phase >= 4) {
    return false;
  }
  return true;
}

async function resolveVerificationSummaryForSignal(
  client: MatrixClient,
  params: {
    roomId: string;
    event: MatrixRawEvent;
    senderId: string;
    flowId: string | null;
  },
): Promise<MatrixVerificationSummaryLike | null> {
  if (!client.crypto) {
    return null;
  }
  await client.crypto
    .ensureVerificationDmTracked({
      roomId: params.roomId,
      userId: params.senderId,
    })
    .catch(() => null);
  const list = await client.crypto.listVerifications();
  if (list.length === 0) {
    return null;
  }
  const candidates = resolveVerificationFlowCandidates({
    event: params.event,
    flowId: params.flowId,
  });
  const byTransactionId = list.find((entry) =>
    candidates.some((candidate) => entry.transactionId === candidate),
  );
  if (byTransactionId) {
    return byTransactionId;
  }

  // Only fall back by user inside the active DM with that user. Otherwise a
  // spoofed verification event in an unrelated room can leak the current SAS
  // prompt into that room.
  const { inspectMatrixDirectRooms, isStrictDirectRoom } = await loadMatrixDirectRoomDeps();
  const inspection = await inspectMatrixDirectRooms({
    client,
    remoteUserId: params.senderId,
  }).catch(() => null);
  const activeRoomId = trimMaybeString(inspection?.activeRoomId);
  if (activeRoomId) {
    if (activeRoomId !== params.roomId) {
      return null;
    }
  } else if (
    !(await isStrictDirectRoom({
      client,
      roomId: params.roomId,
      remoteUserId: params.senderId,
    }))
  ) {
    // If we cannot determine a canonical active DM, preserve the older
    // strict-room fallback so transient m.direct or joined-room read failures
    // do not suppress SAS notices for the current DM.
    return null;
  }

  // Fallback for DM flows where transaction IDs do not match room event IDs consistently.
  const activeByUser = list
    .filter((entry) => entry.otherUserId === params.senderId && isActiveVerificationSummary(entry))
    .toSorted((a, b) => resolveSummaryRecency(b) - resolveSummaryRecency(a));
  const activeInRoom = activeByUser.filter((entry) => {
    const roomId = trimMaybeString(entry.roomId);
    return roomId === params.roomId;
  });
  if (activeInRoom.length > 0) {
    return activeInRoom[0] ?? null;
  }
  return activeByUser[0] ?? null;
}

async function resolveVerificationSasNoticeForSignal(
  client: MatrixClient,
  params: {
    roomId: string;
    event: MatrixRawEvent;
    senderId: string;
    flowId: string | null;
    stage: MatrixVerificationStage;
    sasNoticeRetryDelayMs?: number;
  },
): Promise<{ summary: MatrixVerificationSummaryLike | null; sasNotice: string | null }> {
  const summary = await resolveVerificationSummaryForSignal(client, params);
  const immediateNotice =
    summary && isActiveVerificationSummary(summary) ? formatVerificationSasNotice(summary) : null;
  if (immediateNotice || (params.stage !== "ready" && params.stage !== "start")) {
    return {
      summary,
      sasNotice: immediateNotice,
    };
  }

  await new Promise((resolve) =>
    setTimeout(resolve, params.sasNoticeRetryDelayMs ?? SAS_NOTICE_RETRY_DELAY_MS),
  );
  const retriedSummary = await resolveVerificationSummaryForSignal(client, params);
  return {
    summary: retriedSummary,
    sasNotice:
      retriedSummary && isActiveVerificationSummary(retriedSummary)
        ? formatVerificationSasNotice(retriedSummary)
        : null,
  };
}

function trackBounded(set: Set<string>, value: string): boolean {
  if (!value || set.has(value)) {
    return false;
  }
  set.add(value);
  if (set.size > MAX_TRACKED_VERIFICATION_EVENTS) {
    const oldest = set.values().next().value;
    if (typeof oldest === "string") {
      set.delete(oldest);
    }
  }
  return true;
}

async function sendVerificationNotice(params: {
  client: MatrixClient;
  roomId: string;
  body: string;
  logVerboseMessage: (message: string) => void;
}): Promise<void> {
  const roomId = trimMaybeString(params.roomId);
  if (!roomId) {
    return;
  }
  try {
    await params.client.sendMessage(roomId, {
      msgtype: "m.notice",
      body: params.body,
    });
  } catch (err) {
    params.logVerboseMessage(
      `matrix: failed sending verification notice room=${roomId}: ${String(err)}`,
    );
  }
}

async function isVerificationNoticeAuthorized(params: {
  senderId: string;
  allowFrom: string[];
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  readStoreAllowFrom: () => Promise<string[]>;
  logVerboseMessage: (message: string) => void;
}): Promise<boolean> {
  // Verification notices are DM-only. If DM ingress is disabled, there is no
  // policy-compatible path for posting these notices back into the room.
  if (!params.dmEnabled || params.dmPolicy === "disabled") {
    params.logVerboseMessage(
      `matrix: blocked verification sender ${params.senderId} (dmPolicy=${params.dmPolicy}, dmEnabled=${String(params.dmEnabled)})`,
    );
    return false;
  }
  const storeAllowFrom =
    params.dmPolicy !== "allowlist" && params.dmPolicy !== "open"
      ? await params.readStoreAllowFrom()
      : [];
  const accessState = resolveMatrixMonitorAccessState({
    allowFrom: params.allowFrom,
    storeAllowFrom,
    dmPolicy: params.dmPolicy,
    // Verification flows only exist in strict DMs, so room/group allowlists do
    // not participate in the authorization decision here.
    groupAllowFrom: [],
    roomUsers: [],
    senderId: params.senderId,
    isRoom: false,
  });
  if (accessState.directAllowMatch.allowed) {
    return true;
  }
  params.logVerboseMessage(
    `matrix: blocked verification sender ${params.senderId} (dmPolicy=${params.dmPolicy})`,
  );
  return false;
}

export function createMatrixVerificationEventRouter(params: {
  client: MatrixClient;
  allowFrom: string[];
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  readStoreAllowFrom: () => Promise<string[]>;
  logVerboseMessage: (message: string) => void;
  sasNoticeRetryDelayMs?: number;
  runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
}) {
  const routerStartedAtMs = Date.now();
  const routedVerificationEvents = new Set<string>();
  const routedVerificationSasFingerprints = new Set<string>();
  const routedVerificationStageNotices = new Set<string>();
  const verificationFlowRooms = new Map<string, string>();
  const verificationUserRooms = new Map<string, string>();

  async function resolveActiveDirectRoomId(remoteUserId: string): Promise<string | null> {
    const { inspectMatrixDirectRooms } = await loadMatrixDirectRoomDeps();
    const inspection = await inspectMatrixDirectRooms({
      client: params.client,
      remoteUserId,
    }).catch(() => null);
    return trimMaybeString(inspection?.activeRoomId);
  }

  function shouldEmitVerificationEventNotice(event: MatrixRawEvent): boolean {
    const eventTs =
      typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts)
        ? event.origin_server_ts
        : null;
    if (eventTs === null) {
      return true;
    }
    return eventTs >= routerStartedAtMs - VERIFICATION_EVENT_STARTUP_GRACE_MS;
  }

  function rememberVerificationRoom(roomId: string, event: MatrixRawEvent, flowId: string | null) {
    for (const candidate of resolveVerificationFlowCandidates({ event, flowId })) {
      verificationFlowRooms.set(candidate, roomId);
      if (verificationFlowRooms.size > MAX_TRACKED_VERIFICATION_EVENTS) {
        const oldest = verificationFlowRooms.keys().next().value;
        if (typeof oldest === "string") {
          verificationFlowRooms.delete(oldest);
        }
      }
    }
  }

  function rememberVerificationUserRoom(remoteUserId: string, roomId: string): void {
    const normalizedUserId = trimMaybeString(remoteUserId);
    const normalizedRoomId = trimMaybeString(roomId);
    if (!normalizedUserId || !normalizedRoomId) {
      return;
    }
    verificationUserRooms.delete(normalizedUserId);
    verificationUserRooms.set(normalizedUserId, normalizedRoomId);
    if (verificationUserRooms.size > MAX_TRACKED_VERIFICATION_EVENTS) {
      const oldest = verificationUserRooms.keys().next().value;
      if (typeof oldest === "string") {
        verificationUserRooms.delete(oldest);
      }
    }
  }

  async function resolveSummaryRoomId(
    summary: MatrixVerificationSummaryLike,
  ): Promise<string | null> {
    const mappedRoomId =
      trimMaybeString(summary.roomId) ??
      trimMaybeString(
        summary.transactionId ? verificationFlowRooms.get(summary.transactionId) : null,
      ) ??
      trimMaybeString(verificationFlowRooms.get(summary.id));
    if (mappedRoomId) {
      return mappedRoomId;
    }

    const remoteUserId = trimMaybeString(summary.otherUserId);
    if (!remoteUserId) {
      return null;
    }
    const recentRoomId = trimMaybeString(verificationUserRooms.get(remoteUserId));
    const activeRoomId = await resolveActiveDirectRoomId(remoteUserId);
    if (recentRoomId && activeRoomId && recentRoomId === activeRoomId) {
      return recentRoomId;
    }
    if (activeRoomId) {
      return activeRoomId;
    }
    if (
      recentRoomId &&
      (await (
        await loadMatrixDirectRoomDeps()
      ).isStrictDirectRoom({
        client: params.client,
        roomId: recentRoomId,
        remoteUserId,
      }))
    ) {
      return recentRoomId;
    }
    return null;
  }

  async function routeVerificationSummary(summary: MatrixVerificationSummaryLike): Promise<void> {
    const roomId = await resolveSummaryRoomId(summary);
    if (!roomId || !isActiveVerificationSummary(summary)) {
      return;
    }
    if (
      !(await (
        await loadMatrixDirectRoomDeps()
      ).isStrictDirectRoom({
        client: params.client,
        roomId,
        remoteUserId: summary.otherUserId,
      }))
    ) {
      params.logVerboseMessage(
        `matrix: ignoring verification summary outside strict DM room=${roomId} sender=${summary.otherUserId}`,
      );
      return;
    }
    if (
      !(await isVerificationNoticeAuthorized({
        senderId: summary.otherUserId,
        allowFrom: params.allowFrom,
        dmEnabled: params.dmEnabled,
        dmPolicy: params.dmPolicy,
        readStoreAllowFrom: params.readStoreAllowFrom,
        logVerboseMessage: params.logVerboseMessage,
      }))
    ) {
      return;
    }
    const sasNotice = formatVerificationSasNotice(summary);
    if (!sasNotice) {
      return;
    }
    const sasFingerprint = `${summary.id}:${JSON.stringify(summary.sas)}`;
    if (!trackBounded(routedVerificationSasFingerprints, sasFingerprint)) {
      return;
    }
    await sendVerificationNotice({
      client: params.client,
      roomId,
      body: sasNotice,
      logVerboseMessage: params.logVerboseMessage,
    });
  }

  function routeVerificationEvent(roomId: string, event: MatrixRawEvent): boolean {
    const senderId = trimMaybeString(event?.sender);
    if (!senderId) {
      return false;
    }
    const signal = readVerificationSignal(event);
    if (!signal) {
      return false;
    }
    rememberVerificationRoom(roomId, event, signal.flowId);

    const routeTask = async () => {
      if (!shouldEmitVerificationEventNotice(event)) {
        params.logVerboseMessage(
          `matrix: ignoring historical verification event room=${roomId} id=${event.event_id ?? "unknown"} type=${event.type ?? "unknown"}`,
        );
        return;
      }
      const flowId = signal.flowId;
      const sourceEventId = trimMaybeString(event?.event_id);
      const sourceFingerprint = sourceEventId ?? `${senderId}:${event.type}:${flowId ?? "none"}`;
      const shouldRouteInRoom = await (
        await loadMatrixDirectRoomDeps()
      ).isStrictDirectRoom({
        client: params.client,
        roomId,
        remoteUserId: senderId,
      });
      if (!shouldRouteInRoom) {
        params.logVerboseMessage(
          `matrix: ignoring verification event outside strict DM room=${roomId} sender=${senderId}`,
        );
        return;
      }
      if (
        !(await isVerificationNoticeAuthorized({
          senderId,
          allowFrom: params.allowFrom,
          dmEnabled: params.dmEnabled,
          dmPolicy: params.dmPolicy,
          readStoreAllowFrom: params.readStoreAllowFrom,
          logVerboseMessage: params.logVerboseMessage,
        }))
      ) {
        return;
      }
      rememberVerificationUserRoom(senderId, roomId);
      if (!trackBounded(routedVerificationEvents, sourceFingerprint)) {
        return;
      }

      const stageNotice = formatVerificationStageNotice({ stage: signal.stage, senderId, event });
      const { summary, sasNotice } = await resolveVerificationSasNoticeForSignal(params.client, {
        roomId,
        event,
        senderId,
        flowId,
        stage: signal.stage,
        sasNoticeRetryDelayMs: params.sasNoticeRetryDelayMs,
      }).catch(() => ({ summary: null, sasNotice: null }));

      const notices: string[] = [];
      if (stageNotice) {
        const stageKey = `${roomId}:${senderId}:${flowId ?? sourceFingerprint}:${signal.stage}`;
        if (trackBounded(routedVerificationStageNotices, stageKey)) {
          notices.push(stageNotice);
        }
      }
      if (summary && sasNotice) {
        const sasFingerprint = `${summary.id}:${JSON.stringify(summary.sas)}`;
        if (trackBounded(routedVerificationSasFingerprints, sasFingerprint)) {
          notices.push(sasNotice);
        }
      }
      if (notices.length === 0) {
        return;
      }

      for (const body of notices) {
        await sendVerificationNotice({
          client: params.client,
          roomId,
          body,
          logVerboseMessage: params.logVerboseMessage,
        });
      }
    };
    if (params.runDetachedTask) {
      void params.runDetachedTask(
        `verification event handler room=${roomId} id=${event.event_id ?? "unknown"}`,
        routeTask,
      );
    } else {
      void routeTask().catch((err) => {
        params.logVerboseMessage(`matrix: failed routing verification event: ${String(err)}`);
      });
    }

    return true;
  }

  return {
    routeVerificationEvent,
    routeVerificationSummary,
  };
}
