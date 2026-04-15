import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { PluginRuntime, RuntimeLogger } from "../../runtime-api.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import { formatMatrixEncryptedEventDisabledWarning } from "../encryption-guidance.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";
import { createMatrixVerificationEventRouter } from "./verification-events.js";

const MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_WINDOW_MS = 2 * 60_000;
const MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_THRESHOLD = 3;
const MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_SAMPLE_LIMIT = 3;

type MatrixPostHealthySyncDecryptFailureObservation = {
  key: string;
  roomId: string;
  eventId: string;
  sender: string | null;
  eventTs: number;
  error: string;
};

function formatMatrixPostHealthySyncDecryptionHint(accountId: string): string {
  return (
    "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. " +
    "This device may still be missing new room keys. " +
    `Check 'openclaw matrix verify status --verbose --account ${accountId}' and 'openclaw matrix devices list --account ${accountId}'.`
  );
}

function isFreshPostHealthySyncDecryptFailure(params: {
  event: MatrixRawEvent;
  healthySyncSinceMs?: number;
  graceMs?: number;
  nowMs: number;
}): boolean {
  const { event, healthySyncSinceMs, graceMs = 0, nowMs } = params;
  if (typeof healthySyncSinceMs !== "number" || !Number.isFinite(healthySyncSinceMs)) {
    return false;
  }
  const eventTs = event.origin_server_ts;
  if (!Number.isFinite(eventTs) || eventTs <= 0) {
    return false;
  }
  if (eventTs < healthySyncSinceMs + graceMs) {
    return false;
  }
  if (eventTs > nowMs + 60_000) {
    return false;
  }
  return true;
}

function createMatrixPostHealthySyncDecryptFailureTracker(params: {
  getHealthySyncSinceMs?: () => number | undefined;
  startupGraceMs?: number;
}) {
  let observations: MatrixPostHealthySyncDecryptFailureObservation[] = [];
  let warningEmitted = false;
  let trackedHealthySyncSinceMs: number | undefined;

  const resetObservations = () => {
    observations = [];
    warningEmitted = false;
  };

  const pruneObservations = (nowMs: number) => {
    observations = observations.filter(
      (entry) => nowMs - entry.eventTs <= MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_WINDOW_MS,
    );
    if (observations.length === 0) {
      warningEmitted = false;
    }
  };

  return {
    recordFailure(roomId: string, event: MatrixRawEvent, error: Error) {
      const nowMs = Date.now();
      const healthySyncSinceMs = params.getHealthySyncSinceMs?.();
      if (healthySyncSinceMs !== trackedHealthySyncSinceMs) {
        trackedHealthySyncSinceMs = healthySyncSinceMs;
        resetObservations();
      }
      if (
        !isFreshPostHealthySyncDecryptFailure({
          event,
          healthySyncSinceMs,
          graceMs: params.startupGraceMs,
          nowMs,
        })
      ) {
        return { freshAfterHealthySync: false, failureCount: 0 } as const;
      }

      pruneObservations(nowMs);

      const key = `${roomId}|${event.event_id}`;
      if (!observations.some((entry) => entry.key === key)) {
        observations.push({
          key,
          roomId,
          eventId: event.event_id,
          sender: typeof event.sender === "string" ? event.sender : null,
          eventTs: event.origin_server_ts,
          error: error.message,
        });
      }

      const failureCount = observations.length;
      if (warningEmitted || failureCount < MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_THRESHOLD) {
        return { freshAfterHealthySync: true, failureCount } as const;
      }

      warningEmitted = true;
      const rooms = [...new Set(observations.map((entry) => entry.roomId))].slice(
        0,
        MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_SAMPLE_LIMIT,
      );
      const senders = [...new Set(observations.map((entry) => entry.sender).filter(Boolean))].slice(
        0,
        MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_SAMPLE_LIMIT,
      );
      const eventIds = observations
        .slice(-MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_SAMPLE_LIMIT)
        .map((entry) => entry.eventId);
      const latestError = observations.at(-1)?.error ?? error.message;
      return {
        freshAfterHealthySync: true,
        failureCount,
        warning: {
          rooms,
          roomCount: new Set(observations.map((entry) => entry.roomId)).size,
          senders,
          senderCount: new Set(observations.map((entry) => entry.sender).filter(Boolean)).size,
          eventIds,
          latestError,
          windowMs: MATRIX_POST_HEALTHY_SYNC_DECRYPT_FAILURE_WINDOW_MS,
        },
      } as const;
    },
  };
}

function formatMatrixSelfDecryptionHint(accountId: string): string {
  return (
    "matrix: failed to decrypt a message from this same Matrix user. " +
    "This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. " +
    `Check 'openclaw matrix verify status --verbose --account ${accountId}' and 'openclaw matrix devices list --account ${accountId}'.`
  );
}

async function resolveMatrixSelfUserId(
  client: MatrixClient,
  logVerboseMessage: (message: string) => void,
): Promise<string | null> {
  if (typeof client.getUserId !== "function") {
    return null;
  }
  try {
    return (await client.getUserId()) ?? null;
  } catch (err) {
    logVerboseMessage(`matrix: failed resolving self user id for decrypt warning: ${String(err)}`);
    return null;
  }
}

export function registerMatrixMonitorEvents(params: {
  cfg: CoreConfig;
  client: MatrixClient;
  auth: MatrixAuth;
  allowFrom: string[];
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  readStoreAllowFrom: () => Promise<string[]>;
  directTracker?: {
    invalidateRoom: (roomId: string) => void;
    rememberInvite?: (roomId: string, remoteUserId: string) => void;
  };
  logVerboseMessage: (message: string) => void;
  warnedEncryptedRooms: Set<string>;
  warnedCryptoMissingRooms: Set<string>;
  logger: RuntimeLogger;
  startupGraceMs?: number;
  getHealthySyncSinceMs?: () => number | undefined;
  formatNativeDependencyHint: PluginRuntime["system"]["formatNativeDependencyHint"];
  onRoomMessage: (roomId: string, event: MatrixRawEvent) => void | Promise<void>;
  runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
}): void {
  const {
    cfg,
    client,
    auth,
    allowFrom,
    dmEnabled,
    dmPolicy,
    readStoreAllowFrom,
    directTracker,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    startupGraceMs,
    getHealthySyncSinceMs,
    formatNativeDependencyHint,
    onRoomMessage,
    runDetachedTask,
  } = params;
  const postHealthySyncDecryptFailureTracker = createMatrixPostHealthySyncDecryptFailureTracker({
    getHealthySyncSinceMs,
    startupGraceMs,
  });
  const { routeVerificationEvent, routeVerificationSummary } = createMatrixVerificationEventRouter({
    client,
    allowFrom,
    dmEnabled,
    dmPolicy,
    readStoreAllowFrom,
    logVerboseMessage,
  });

  const runMonitorTask = (label: string, task: () => Promise<void>) => {
    if (runDetachedTask) {
      return runDetachedTask(label, task);
    }
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        logVerboseMessage(`matrix: ${label} failed (${String(error)})`);
      });
  };

  client.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    if (routeVerificationEvent(roomId, event)) {
      return;
    }
    void runMonitorTask(
      `room message handler room=${roomId} id=${event.event_id ?? "unknown"}`,
      async () => {
        await onRoomMessage(roomId, event);
      },
    );
  });

  client.on("room.encrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: encrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on("room.decrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: decrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on(
    "room.failed_decryption",
    async (roomId: string, event: MatrixRawEvent, error: Error) => {
      const failureState = postHealthySyncDecryptFailureTracker.recordFailure(roomId, event, error);
      const selfUserId = await resolveMatrixSelfUserId(client, logVerboseMessage);
      const sender = typeof event.sender === "string" ? event.sender : null;
      const senderMatchesOwnUser = Boolean(selfUserId && sender && selfUserId === sender);
      logger.warn(
        failureState.freshAfterHealthySync
          ? "Failed to decrypt fresh post-healthy-sync message"
          : "Failed to decrypt message",
        {
          roomId,
          eventId: event.event_id,
          sender,
          senderMatchesOwnUser,
          error: error.message,
          freshAfterHealthySync: failureState.freshAfterHealthySync,
          ...(failureState.freshAfterHealthySync
            ? {
                postHealthySyncFailureCount: failureState.failureCount,
              }
            : {}),
        },
      );
      if (failureState.warning) {
        logger.warn(formatMatrixPostHealthySyncDecryptionHint(auth.accountId), {
          roomId,
          eventId: event.event_id,
          failureCount: failureState.failureCount,
          roomCount: failureState.warning.roomCount,
          rooms: failureState.warning.rooms,
          senderCount: failureState.warning.senderCount,
          senders: failureState.warning.senders,
          sampleEventIds: failureState.warning.eventIds,
          latestError: failureState.warning.latestError,
          windowMs: failureState.warning.windowMs,
        });
      }
      if (senderMatchesOwnUser) {
        logger.warn(formatMatrixSelfDecryptionHint(auth.accountId), {
          roomId,
          eventId: event.event_id,
          sender,
        });
      }
      logVerboseMessage(
        `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} freshAfterHealthySync=${String(failureState.freshAfterHealthySync)} error=${error.message}`,
      );
    },
  );

  client.on("verification.summary", (summary) => {
    void runMonitorTask("verification summary handler", async () => {
      await routeVerificationSummary(summary);
    });
  });

  client.on("room.invite", (roomId: string, event: MatrixRawEvent) => {
    directTracker?.invalidateRoom(roomId);
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const invitee = normalizeOptionalString(event?.state_key) ?? "";
    const senderIsInvitee =
      Boolean(invitee) && (normalizeOptionalString(event?.sender) ?? "") === invitee;
    const isDirect = (event?.content as { is_direct?: boolean } | undefined)?.is_direct === true;
    const rememberedSender = normalizeOptionalString(event?.sender);
    if (rememberedSender && !senderIsInvitee) {
      directTracker?.rememberInvite?.(roomId, rememberedSender);
    }
    logVerboseMessage(
      `matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`,
    );
  });

  client.on("room.join", (roomId: string, event: MatrixRawEvent) => {
    directTracker?.invalidateRoom(roomId);
    const eventId = event?.event_id ?? "unknown";
    logVerboseMessage(`matrix: join room=${roomId} id=${eventId}`);
  });

  client.on("room.event", (roomId: string, event: MatrixRawEvent) => {
    const eventType = event?.type ?? "unknown";
    if (eventType === EventType.RoomMessageEncrypted) {
      logVerboseMessage(
        `matrix: encrypted raw event room=${roomId} id=${event?.event_id ?? "unknown"}`,
      );
      if (auth.encryption !== true && !warnedEncryptedRooms.has(roomId)) {
        warnedEncryptedRooms.add(roomId);
        const warning = formatMatrixEncryptedEventDisabledWarning(cfg, auth.accountId);
        logger.warn(warning, { roomId });
      }
      if (auth.encryption === true && !client.crypto && !warnedCryptoMissingRooms.has(roomId)) {
        warnedCryptoMissingRooms.add(roomId);
        const hint = formatNativeDependencyHint({
          packageName: "@matrix-org/matrix-sdk-crypto-nodejs",
          manager: "pnpm",
          downloadCommand: "node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
        });
        const warning = `matrix: encryption enabled but crypto is unavailable; ${hint}`;
        logger.warn(warning, { roomId });
      }
      return;
    }
    if (eventType === EventType.RoomMember) {
      directTracker?.invalidateRoom(roomId);
      const membership = (event?.content as { membership?: string } | undefined)?.membership;
      const stateKey = (event as { state_key?: string }).state_key ?? "";
      logVerboseMessage(
        `matrix: member event room=${roomId} stateKey=${stateKey} membership=${membership ?? "unknown"}`,
      );
    }
    if (eventType === EventType.Reaction) {
      void runMonitorTask(
        `reaction handler room=${roomId} id=${event.event_id ?? "unknown"}`,
        async () => {
          await onRoomMessage(roomId, event);
        },
      );
      return;
    }

    routeVerificationEvent(roomId, event);
  });
}
