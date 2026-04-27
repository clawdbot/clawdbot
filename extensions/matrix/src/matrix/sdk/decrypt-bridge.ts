import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import { MatrixEventEvent, type MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { LogService, noop } from "./logger.js";

type MatrixDecryptIfNeededClient = {
  decryptEventIfNeeded?: (
    event: MatrixEvent,
    opts?: {
      isRetry?: boolean;
    },
  ) => Promise<void>;
};

type MatrixDecryptRetryState = {
  event: MatrixEvent;
  roomId: string;
  eventId: string;
  attempts: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type DecryptBridgeRawEvent = {
  event_id: string;
};

type MatrixCryptoRetrySignalSource = {
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

const MATRIX_DECRYPT_RETRY_BASE_DELAY_MS = 1_500;
const MATRIX_DECRYPT_RETRY_MAX_DELAY_MS = 30_000;
const MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS = 8;

function resolveDecryptRetryKey(roomId: string, eventId: string): string | null {
  if (!roomId || !eventId) {
    return null;
  }
  return `${roomId}|${eventId}`;
}

function isDecryptionFailure(event: MatrixEvent): boolean {
  return (
    typeof (event as { isDecryptionFailure?: () => boolean }).isDecryptionFailure === "function" &&
    (event as { isDecryptionFailure: () => boolean }).isDecryptionFailure()
  );
}

function getDecryptionFailureReason(event: MatrixEvent): DecryptionFailureCode | null {
  const reason = (event as { decryptionFailureReason?: unknown }).decryptionFailureReason;
  return typeof reason === "string" && reason in DecryptionFailureCode
    ? (reason as DecryptionFailureCode)
    : null;
}

function shouldRetryDecryptionFailure(event: MatrixEvent): boolean {
  if (!isDecryptionFailure(event)) {
    return false;
  }
  const reason = getDecryptionFailureReason(event);
  if (!reason) {
    return true;
  }
  return (
    reason === DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID ||
    reason === DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX ||
    reason === DecryptionFailureCode.UNKNOWN_ERROR
  );
}

export class MatrixDecryptBridge<TRawEvent extends DecryptBridgeRawEvent> {
  private readonly trackedEncryptedEvents = new WeakSet<object>();
  private readonly decryptedMessageDedupe = new Map<string, number>();
  private readonly decryptRetries = new Map<string, MatrixDecryptRetryState>();
  private readonly failedDecryptionsNotified = new Set<string>();
  private readonly exhaustedDecryptRetries = new Set<string>();
  private activeRetryRuns = 0;
  private readonly retryIdleResolvers = new Set<() => void>();
  private cryptoRetrySignalsBound = false;

  constructor(
    private readonly deps: {
      client: MatrixDecryptIfNeededClient;
      toRaw: (event: MatrixEvent) => TRawEvent;
      emitDecryptedEvent: (roomId: string, event: TRawEvent) => void;
      emitMessage: (roomId: string, event: TRawEvent) => void;
      emitFailedDecryption: (roomId: string, event: TRawEvent, error: Error) => void;
    },
  ) {}

  shouldEmitUnencryptedMessage(roomId: string, eventId: string): boolean {
    if (!eventId) {
      return true;
    }
    const key = `${roomId}|${eventId}`;
    const createdAt = this.decryptedMessageDedupe.get(key);
    if (createdAt === undefined) {
      return true;
    }
    this.decryptedMessageDedupe.delete(key);
    return false;
  }

  attachEncryptedEvent(event: MatrixEvent, roomId: string): void {
    if (this.trackedEncryptedEvents.has(event)) {
      return;
    }
    this.trackedEncryptedEvents.add(event);
    event.on(MatrixEventEvent.Decrypted, (decryptedEvent: MatrixEvent, err?: Error) => {
      this.handleEncryptedEventDecrypted({
        roomId,
        encryptedEvent: event,
        decryptedEvent,
        err,
      });
    });
    if (shouldRetryDecryptionFailure(event)) {
      const raw = this.deps.toRaw(event);
      const eventId = raw.event_id || event.getId() || "";
      this.scheduleDecryptRetry({ event, roomId, eventId });
    }
  }

  retryPendingNow(reason: string): void {
    const pending = Array.from(this.decryptRetries.entries());
    if (pending.length === 0) {
      return;
    }
    LogService.debug("MatrixClientLite", `Retrying pending decryptions due to ${reason}`);
    for (const [retryKey, state] of pending) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.inFlight) {
        continue;
      }
      this.runDecryptRetry(retryKey).catch(noop);
    }
  }

  bindCryptoRetrySignals(crypto: MatrixCryptoRetrySignalSource | undefined): void {
    if (!crypto || this.cryptoRetrySignalsBound) {
      return;
    }
    this.cryptoRetrySignalsBound = true;

    const trigger = (reason: string): void => {
      this.retryPendingNow(reason);
    };

    crypto.on(CryptoEvent.KeyBackupDecryptionKeyCached, () => {
      trigger("crypto.keyBackupDecryptionKeyCached");
    });
    crypto.on(CryptoEvent.RehydrationCompleted, () => {
      trigger("dehydration.RehydrationCompleted");
    });
    crypto.on(CryptoEvent.DevicesUpdated, () => {
      trigger("crypto.devicesUpdated");
    });
    crypto.on(CryptoEvent.KeysChanged, () => {
      trigger("crossSigning.keysChanged");
    });
  }

  stop(): void {
    for (const retryKey of this.decryptRetries.keys()) {
      this.clearDecryptRetry(retryKey);
    }
  }

  async drainPendingDecryptions(reason: string): Promise<void> {
    for (let attempts = 0; attempts < MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS; attempts += 1) {
      if (this.decryptRetries.size === 0) {
        return;
      }
      this.retryPendingNow(reason);
      await this.waitForActiveRetryRunsToFinish();
      const hasPendingRetryTimers = Array.from(this.decryptRetries.values()).some(
        (state) => state.timer || state.inFlight,
      );
      if (!hasPendingRetryTimers) {
        return;
      }
    }
  }

  private handleEncryptedEventDecrypted(params: {
    roomId: string;
    encryptedEvent: MatrixEvent;
    decryptedEvent: MatrixEvent;
    err?: Error;
  }): void {
    const decryptedRoomId = params.decryptedEvent.getRoomId() || params.roomId;
    const decryptedRaw = this.deps.toRaw(params.decryptedEvent);
    const retryEventId = decryptedRaw.event_id || params.encryptedEvent.getId() || "";
    const retryKey = resolveDecryptRetryKey(decryptedRoomId, retryEventId);

    if (params.err) {
      this.emitFailedDecryptionOnce(retryKey, decryptedRoomId, decryptedRaw, params.err);
      if (shouldRetryDecryptionFailure(params.decryptedEvent)) {
        this.scheduleDecryptRetry({
          event: params.encryptedEvent,
          roomId: decryptedRoomId,
          eventId: retryEventId,
        });
      } else if (retryKey) {
        this.clearDecryptRetry(retryKey);
      }
      return;
    }

    if (isDecryptionFailure(params.decryptedEvent)) {
      this.emitFailedDecryptionOnce(
        retryKey,
        decryptedRoomId,
        decryptedRaw,
        new Error("Matrix event failed to decrypt"),
      );
      if (shouldRetryDecryptionFailure(params.decryptedEvent)) {
        this.scheduleDecryptRetry({
          event: params.encryptedEvent,
          roomId: decryptedRoomId,
          eventId: retryEventId,
        });
      } else if (retryKey) {
        this.clearDecryptRetry(retryKey);
      }
      return;
    }

    if (retryKey) {
      this.clearDecryptRetry(retryKey);
    }
    this.rememberDecryptedMessage(decryptedRoomId, decryptedRaw.event_id);
    this.deps.emitDecryptedEvent(decryptedRoomId, decryptedRaw);
    this.deps.emitMessage(decryptedRoomId, decryptedRaw);
  }

  private emitFailedDecryptionOnce(
    retryKey: string | null,
    roomId: string,
    event: TRawEvent,
    error: Error,
  ): void {
    if (retryKey) {
      if (this.failedDecryptionsNotified.has(retryKey)) {
        return;
      }
      this.failedDecryptionsNotified.add(retryKey);
    }
    this.deps.emitFailedDecryption(roomId, event, error);
  }

  private scheduleDecryptRetry(params: {
    event: MatrixEvent;
    roomId: string;
    eventId: string;
  }): void {
    const retryKey = resolveDecryptRetryKey(params.roomId, params.eventId);
    if (!retryKey) {
      return;
    }
    const existing = this.decryptRetries.get(retryKey);
    if (this.exhaustedDecryptRetries.has(retryKey)) {
      return;
    }
    if (existing?.timer || existing?.inFlight) {
      return;
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    if (attempts > MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS) {
      const retry = this.decryptRetries.get(retryKey);
      if (retry?.timer) {
        clearTimeout(retry.timer);
      }
      this.decryptRetries.delete(retryKey);
      this.exhaustedDecryptRetries.add(retryKey);
      LogService.debug(
        "MatrixClientLite",
        `Giving up decryption retry for ${params.eventId} in ${params.roomId} after ${attempts - 1} attempts`,
      );
      return;
    }
    const delayMs = Math.min(
      MATRIX_DECRYPT_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1),
      MATRIX_DECRYPT_RETRY_MAX_DELAY_MS,
    );
    const next: MatrixDecryptRetryState = {
      event: params.event,
      roomId: params.roomId,
      eventId: params.eventId,
      attempts,
      inFlight: false,
      timer: null,
    };
    next.timer = setTimeout(() => {
      this.runDecryptRetry(retryKey).catch(noop);
    }, delayMs);
    this.decryptRetries.set(retryKey, next);
  }

  private async runDecryptRetry(retryKey: string): Promise<void> {
    const state = this.decryptRetries.get(retryKey);
    if (!state || state.inFlight) {
      return;
    }

    state.inFlight = true;
    state.timer = null;
    this.activeRetryRuns += 1;
    const canDecrypt = typeof this.deps.client.decryptEventIfNeeded === "function";
    if (!canDecrypt) {
      this.clearDecryptRetry(retryKey);
      this.activeRetryRuns = Math.max(0, this.activeRetryRuns - 1);
      this.resolveRetryIdleIfNeeded();
      return;
    }

    try {
      await this.deps.client.decryptEventIfNeeded?.(state.event, {
        isRetry: true,
      });
    } catch {
      // Retry with backoff until we hit the configured retry cap.
    } finally {
      state.inFlight = false;
      this.activeRetryRuns = Math.max(0, this.activeRetryRuns - 1);
      this.resolveRetryIdleIfNeeded();
    }

    if (this.decryptRetries.get(retryKey) !== state) {
      return;
    }
    if (isDecryptionFailure(state.event)) {
      if (!shouldRetryDecryptionFailure(state.event)) {
        this.clearDecryptRetry(retryKey);
        return;
      }
      this.scheduleDecryptRetry(state);
      return;
    }

    this.clearDecryptRetry(retryKey);
    const raw = this.deps.toRaw(state.event);
    this.rememberDecryptedMessage(state.roomId, raw.event_id);
    this.deps.emitDecryptedEvent(state.roomId, raw);
    this.deps.emitMessage(state.roomId, raw);
  }

  private clearDecryptRetry(retryKey: string): void {
    const state = this.decryptRetries.get(retryKey);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.decryptRetries.delete(retryKey);
    this.exhaustedDecryptRetries.delete(retryKey);
    this.failedDecryptionsNotified.delete(retryKey);
  }

  private rememberDecryptedMessage(roomId: string, eventId: string): void {
    if (!eventId) {
      return;
    }
    const now = Date.now();
    this.pruneDecryptedMessageDedupe(now);
    this.decryptedMessageDedupe.set(`${roomId}|${eventId}`, now);
  }

  private pruneDecryptedMessageDedupe(now: number): void {
    const ttlMs = 30_000;
    for (const [key, createdAt] of this.decryptedMessageDedupe) {
      if (now - createdAt > ttlMs) {
        this.decryptedMessageDedupe.delete(key);
      }
    }
    const maxEntries = 2048;
    while (this.decryptedMessageDedupe.size > maxEntries) {
      const oldest = this.decryptedMessageDedupe.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.decryptedMessageDedupe.delete(oldest);
    }
  }

  private async waitForActiveRetryRunsToFinish(): Promise<void> {
    if (this.activeRetryRuns === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.retryIdleResolvers.add(resolve);
      if (this.activeRetryRuns === 0) {
        this.retryIdleResolvers.delete(resolve);
        resolve();
      }
    });
  }

  private resolveRetryIdleIfNeeded(): void {
    if (this.activeRetryRuns !== 0) {
      return;
    }
    for (const resolve of this.retryIdleResolvers) {
      resolve();
    }
    this.retryIdleResolvers.clear();
  }
}
