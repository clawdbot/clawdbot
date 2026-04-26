import { EventEmitter } from "node:events";
import {
  ClientEvent,
  Filter,
  MatrixEventEvent,
  Preset,
  createClient as createMatrixJsClient,
  type IFilterDefinition,
  type MatrixClient as MatrixJsClient,
  type MatrixEvent,
} from "matrix-js-sdk/lib/matrix.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import { normalizeNullableString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../runtime-api.js";
import { resolveMatrixRoomKeyBackupReadinessError } from "./backup-health.js";
import { FileBackedMatrixSyncStore } from "./client/file-sync-store.js";
import { createMatrixJsSdkClientLogger } from "./client/logging.js";
import {
  formatMatrixErrorMessage,
  formatMatrixErrorReason,
  isMatrixNotFoundError,
} from "./errors.js";
import type {
  MatrixCryptoBootstrapOptions,
  MatrixCryptoBootstrapResult,
} from "./sdk/crypto-bootstrap.js";
import type { MatrixCryptoFacade } from "./sdk/crypto-facade.js";
import type { MatrixDecryptBridge } from "./sdk/decrypt-bridge.js";
import { matrixEventToRaw, parseMxc } from "./sdk/event-helpers.js";
import { MatrixAuthedHttpClient } from "./sdk/http-client.js";
import { MATRIX_IDB_PERSIST_INTERVAL_MS } from "./sdk/idb-persistence-lock.js";
import { ConsoleLogger, LogService, noop } from "./sdk/logger.js";
import {
  MatrixRecoveryKeyStore,
  isRepairableSecretStorageAccessError,
} from "./sdk/recovery-key-store.js";
import { createMatrixGuardedFetch, type HttpMethod, type QueryParams } from "./sdk/transport.js";
import type {
  MatrixClientEventMap,
  MatrixCryptoBootstrapApi,
  MatrixDeviceVerificationStatusLike,
  MatrixRelationsPage,
  MatrixRawEvent,
  MessageEventContent,
} from "./sdk/types.js";
import type { MatrixVerificationSummary } from "./sdk/verification-manager.js";
import { createMatrixStartupAbortError, throwIfMatrixStartupAborted } from "./startup-abort.js";
import {
  isMatrixReadySyncState,
  isMatrixTerminalSyncState,
  type MatrixSyncState,
} from "./sync-state.js";

export { ConsoleLogger, LogService };
export type {
  DimensionalFileInfo,
  FileWithThumbnailInfo,
  TimedFileInfo,
  VideoFileInfo,
} from "./sdk/types.js";
export type {
  EncryptedFile,
  LocationMessageEventContent,
  MatrixRawEvent,
  MessageEventContent,
  TextualMessageEventContent,
} from "./sdk/types.js";

export type MatrixOwnDeviceVerificationStatus = {
  encryptionEnabled: boolean;
  userId: string | null;
  deviceId: string | null;
  // "verified" is intentionally strict: this device must be trusted through the
  // Matrix cross-signing identity chain, not merely signed by the owner key.
  verified: boolean;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
  recoveryKeyStored: boolean;
  recoveryKeyCreatedAt: string | null;
  recoveryKeyId: string | null;
  backupVersion: string | null;
  backup: MatrixRoomKeyBackupStatus;
  serverDeviceKnown: boolean | null;
};

export type MatrixDeviceVerificationStatus = {
  encryptionEnabled: boolean;
  userId: string | null;
  deviceId: string | null;
  verified: boolean;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
};

export type MatrixRoomKeyBackupStatus = {
  serverVersion: string | null;
  activeVersion: string | null;
  trusted: boolean | null;
  matchesDecryptionKey: boolean | null;
  decryptionKeyCached: boolean | null;
  keyLoadAttempted: boolean;
  keyLoadError: string | null;
};

export type MatrixRoomKeyBackupRestoreResult = {
  success: boolean;
  error?: string;
  backupVersion: string | null;
  imported: number;
  total: number;
  loadedFromSecretStorage: boolean;
  restoredAt?: string;
  backup: MatrixRoomKeyBackupStatus;
};

export type MatrixRoomKeyBackupResetResult = {
  success: boolean;
  error?: string;
  previousVersion: string | null;
  deletedVersion: string | null;
  createdVersion: string | null;
  resetAt?: string;
  backup: MatrixRoomKeyBackupStatus;
};

export type MatrixRecoveryKeyVerificationResult = MatrixOwnDeviceVerificationStatus & {
  success: boolean;
  recoveryKeyAccepted: boolean;
  backupUsable: boolean;
  deviceOwnerVerified: boolean;
  verifiedAt?: string;
  error?: string;
};

export type MatrixOwnCrossSigningPublicationStatus = {
  userId: string | null;
  masterKeyPublished: boolean;
  selfSigningKeyPublished: boolean;
  userSigningKeyPublished: boolean;
  published: boolean;
};

export type MatrixVerificationBootstrapResult = {
  success: boolean;
  error?: string;
  verification: MatrixOwnDeviceVerificationStatus;
  crossSigning: MatrixOwnCrossSigningPublicationStatus;
  pendingVerifications: number;
  cryptoBootstrap: MatrixCryptoBootstrapResult | null;
};

const MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS = {
  allowAutomaticCrossSigningReset: false,
} satisfies MatrixCryptoBootstrapOptions;

const MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS = {
  forceResetCrossSigning: true,
  allowSecretStorageRecreateWithoutRecoveryKey: true,
  strict: true,
} satisfies MatrixCryptoBootstrapOptions;

function createMatrixExplicitBootstrapOptions(params?: {
  allowAutomaticCrossSigningReset?: boolean;
  forceResetCrossSigning?: boolean;
  strict?: boolean;
}): MatrixCryptoBootstrapOptions {
  return {
    forceResetCrossSigning: params?.forceResetCrossSigning === true,
    allowAutomaticCrossSigningReset: params?.allowAutomaticCrossSigningReset !== false,
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    strict: params?.strict !== false,
  };
}

export type MatrixOwnDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  lastSeenIp: string | null;
  lastSeenTs: number | null;
  current: boolean;
};

export type MatrixRoomKeyBackupResetOptions = {
  rotateRecoveryKey?: boolean;
};

export type MatrixOwnDeviceDeleteResult = {
  currentDeviceId: string | null;
  deletedDeviceIds: string[];
  remainingDevices: MatrixOwnDeviceInfo[];
};

type MatrixCryptoRuntime = typeof import("./sdk/crypto-runtime.js");

let loadedMatrixCryptoRuntime: MatrixCryptoRuntime | null = null;
let matrixCryptoRuntimePromise: Promise<MatrixCryptoRuntime> | null = null;

async function loadMatrixCryptoRuntime(): Promise<MatrixCryptoRuntime> {
  matrixCryptoRuntimePromise ??= import("./sdk/crypto-runtime.js").then((runtime) => {
    loadedMatrixCryptoRuntime = runtime;
    return runtime;
  });
  return await matrixCryptoRuntimePromise;
}

const normalizeOptionalString = normalizeNullableString;

function isUnsupportedAuthenticatedMediaEndpointError(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode === 404 || statusCode === 405 || statusCode === 501) {
    return true;
  }
  const message = formatMatrixErrorReason(err);
  return (
    message.includes("m_unrecognized") ||
    message.includes("unrecognized request") ||
    message.includes("method not allowed") ||
    message.includes("not implemented")
  );
}

export class MatrixClient {
  private readonly client: MatrixJsClient;
  private readonly emitter = new EventEmitter();
  private readonly httpClient: MatrixAuthedHttpClient;
  private readonly localTimeoutMs: number;
  private readonly initialSyncLimit?: number;
  private readonly syncFilter?: IFilterDefinition;
  private readonly encryptionEnabled: boolean;
  private readonly password?: string;
  private readonly syncStore?: FileBackedMatrixSyncStore;
  private readonly idbSnapshotPath?: string;
  private readonly cryptoDatabasePrefix?: string;
  private bridgeRegistered = false;
  private started = false;
  private cryptoBootstrapped = false;
  private selfUserId: string | null;
  private readonly dmRoomIds = new Set<string>();
  private cryptoInitialized = false;
  private decryptBridge?: MatrixDecryptBridge<MatrixRawEvent>;
  private verificationManager?: import("./sdk/verification-manager.js").MatrixVerificationManager;
  private readonly sendQueue = new KeyedAsyncQueue();
  private readonly recoveryKeyStore: MatrixRecoveryKeyStore;
  private cryptoBootstrapper?:
    | import("./sdk/crypto-bootstrap.js").MatrixCryptoBootstrapper<MatrixRawEvent>
    | undefined;
  private readonly autoBootstrapCrypto: boolean;
  private stopPersistPromise: Promise<void> | null = null;
  private verificationSummaryListenerBound = false;
  private currentSyncState: MatrixSyncState | null = null;

  readonly dms = {
    update: async (): Promise<boolean> => {
      return await this.refreshDmCache();
    },
    isDm: (roomId: string): boolean => this.dmRoomIds.has(roomId),
  };

  crypto?: MatrixCryptoFacade;

  constructor(
    homeserver: string,
    accessToken: string,
    opts: {
      userId?: string;
      password?: string;
      deviceId?: string;
      localTimeoutMs?: number;
      encryption?: boolean;
      initialSyncLimit?: number;
      syncFilter?: IFilterDefinition;
      storagePath?: string;
      recoveryKeyPath?: string;
      idbSnapshotPath?: string;
      cryptoDatabasePrefix?: string;
      autoBootstrapCrypto?: boolean;
      ssrfPolicy?: SsrFPolicy;
      dispatcherPolicy?: PinnedDispatcherPolicy;
    } = {},
  ) {
    this.httpClient = new MatrixAuthedHttpClient({
      homeserver,
      accessToken,
      ssrfPolicy: opts.ssrfPolicy,
      dispatcherPolicy: opts.dispatcherPolicy,
    });
    this.localTimeoutMs = Math.max(1, opts.localTimeoutMs ?? 60_000);
    this.initialSyncLimit = opts.initialSyncLimit;
    this.syncFilter = opts.syncFilter;
    this.encryptionEnabled = opts.encryption === true;
    this.password = opts.password;
    this.syncStore = opts.storagePath ? new FileBackedMatrixSyncStore(opts.storagePath) : undefined;
    this.idbSnapshotPath = opts.idbSnapshotPath;
    this.cryptoDatabasePrefix = opts.cryptoDatabasePrefix;
    this.selfUserId = opts.userId?.trim() || null;
    this.autoBootstrapCrypto = opts.autoBootstrapCrypto !== false;
    this.recoveryKeyStore = new MatrixRecoveryKeyStore(opts.recoveryKeyPath);
    const cryptoCallbacks = this.encryptionEnabled
      ? this.recoveryKeyStore.buildCryptoCallbacks()
      : undefined;
    this.client = createMatrixJsClient({
      baseUrl: homeserver,
      accessToken,
      userId: opts.userId,
      deviceId: opts.deviceId,
      logger: createMatrixJsSdkClientLogger("MatrixClient"),
      localTimeoutMs: this.localTimeoutMs,
      fetchFn: createMatrixGuardedFetch({
        ssrfPolicy: opts.ssrfPolicy,
        dispatcherPolicy: opts.dispatcherPolicy,
      }),
      store: this.syncStore,
      cryptoCallbacks: cryptoCallbacks as never,
      verificationMethods: [
        VerificationMethod.Sas,
        VerificationMethod.ShowQrCode,
        VerificationMethod.ScanQrCode,
        VerificationMethod.Reciprocate,
      ],
    });
  }

  on<TEvent extends keyof MatrixClientEventMap>(
    eventName: TEvent,
    listener: (...args: MatrixClientEventMap[TEvent]) => void,
  ): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  off<TEvent extends keyof MatrixClientEventMap>(
    eventName: TEvent,
    listener: (...args: MatrixClientEventMap[TEvent]) => void,
  ): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  private idbPersistTimer: ReturnType<typeof setInterval> | null = null;

  private async ensureCryptoSupportInitialized(): Promise<void> {
    if (
      this.decryptBridge &&
      (!this.encryptionEnabled ||
        (this.verificationManager && this.cryptoBootstrapper && this.crypto))
    ) {
      return;
    }

    const runtime = await loadMatrixCryptoRuntime();
    this.decryptBridge ??= new runtime.MatrixDecryptBridge<MatrixRawEvent>({
      client: this.client,
      toRaw: (event) => matrixEventToRaw(event, { contentMode: "original" }),
      emitDecryptedEvent: (roomId, event) => {
        this.emitter.emit("room.decrypted_event", roomId, event);
      },
      emitMessage: (roomId, event) => {
        this.emitter.emit("room.message", roomId, event);
      },
      emitFailedDecryption: (roomId, event, error) => {
        this.emitter.emit("room.failed_decryption", roomId, event, error);
      },
    });
    if (!this.encryptionEnabled) {
      return;
    }

    this.verificationManager ??= new runtime.MatrixVerificationManager({
      trustOwnDeviceAfterSas: async (deviceId: string) => {
        const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
        if (typeof crypto?.crossSignDevice !== "function") {
          return;
        }
        await crypto.crossSignDevice(deviceId);
      },
    });
    this.cryptoBootstrapper ??= new runtime.MatrixCryptoBootstrapper<MatrixRawEvent>({
      getUserId: () => this.getUserId(),
      getPassword: () => this.password,
      getDeviceId: () => this.client.getDeviceId(),
      verificationManager: this.verificationManager,
      recoveryKeyStore: this.recoveryKeyStore,
      decryptBridge: this.decryptBridge,
    });
    if (!this.crypto) {
      this.crypto = runtime.createMatrixCryptoFacade({
        client: this.client,
        verificationManager: this.verificationManager,
        recoveryKeyStore: this.recoveryKeyStore,
        getRoomStateEvent: (roomId, eventType, stateKey = "") =>
          this.getRoomStateEvent(roomId, eventType, stateKey),
        downloadContent: (mxcUrl) => this.downloadContent(mxcUrl),
      });
    }
    if (!this.verificationSummaryListenerBound) {
      this.verificationSummaryListenerBound = true;
      this.verificationManager.onSummaryChanged((summary: MatrixVerificationSummary) => {
        this.emitter.emit("verification.summary", summary);
      });
    }
  }

  async start(opts: { abortSignal?: AbortSignal; readyTimeoutMs?: number } = {}): Promise<void> {
    await this.startSyncSession({
      bootstrapCrypto: true,
      abortSignal: opts.abortSignal,
      readyTimeoutMs: opts.readyTimeoutMs,
    });
  }

  private async waitForInitialSyncReady(
    params: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const timeoutMs = params.timeoutMs ?? 30_000;
    if (isMatrixReadySyncState(this.currentSyncState)) {
      return;
    }
    if (isMatrixTerminalSyncState(this.currentSyncState)) {
      throw new Error(`Matrix sync entered ${this.currentSyncState} during startup`);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const abortSignal = params.abortSignal;

      const cleanup = () => {
        this.off("sync.state", onSyncState);
        this.off("sync.unexpected_error", onUnexpectedError);
        abortSignal?.removeEventListener("abort", onAbort);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      };

      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const onSyncState = (state: MatrixSyncState, _prevState: string | null, error?: unknown) => {
        if (isMatrixReadySyncState(state)) {
          settleResolve();
          return;
        }
        if (isMatrixTerminalSyncState(state)) {
          settleReject(
            new Error(
              error instanceof Error && error.message
                ? error.message
                : `Matrix sync entered ${state} during startup`,
            ),
          );
        }
      };

      const onUnexpectedError = (error: Error) => {
        settleReject(error);
      };

      const onAbort = () => {
        settleReject(createMatrixStartupAbortError());
      };

      this.on("sync.state", onSyncState);
      this.on("sync.unexpected_error", onUnexpectedError);
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => {
        settleReject(
          new Error(`Matrix client did not reach a ready sync state within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      timeoutId.unref?.();
    });
  }

  private async startSyncSession(opts: {
    bootstrapCrypto: boolean;
    abortSignal?: AbortSignal;
    readyTimeoutMs?: number;
  }): Promise<void> {
    if (this.started) {
      return;
    }

    throwIfMatrixStartupAborted(opts.abortSignal);
    await this.ensureCryptoSupportInitialized();
    throwIfMatrixStartupAborted(opts.abortSignal);
    this.registerBridge();
    await this.initializeCryptoIfNeeded(opts.abortSignal);

    await this.client.startClient({
      initialSyncLimit: this.initialSyncLimit,
      ...(this.syncFilter ? { filter: Filter.fromJson(this.selfUserId, "", this.syncFilter) } : {}),
    });
    await this.waitForInitialSyncReady({
      abortSignal: opts.abortSignal,
      timeoutMs: opts.readyTimeoutMs,
    });
    throwIfMatrixStartupAborted(opts.abortSignal);
    if (opts.bootstrapCrypto && this.autoBootstrapCrypto) {
      await this.bootstrapCryptoIfNeeded(opts.abortSignal);
    }
    throwIfMatrixStartupAborted(opts.abortSignal);
    this.started = true;
    this.emitOutstandingInviteEvents();
    await this.refreshDmCache().catch(noop);
  }

  async prepareForOneOff(): Promise<void> {
    if (!this.encryptionEnabled) {
      return;
    }
    await this.ensureCryptoSupportInitialized();
    await this.initializeCryptoIfNeeded();
    if (!this.crypto) {
      return;
    }
    try {
      const joinedRooms = await this.getJoinedRooms();
      await this.crypto.prepare(joinedRooms);
    } catch {
      // One-off commands should continue even if crypto room prep is incomplete.
    }
  }

  hasPersistedSyncState(): boolean {
    // Only trust restart replay when the previous process completed a final
    // sync-store persist. A stale cursor can make Matrix re-surface old events.
    return this.syncStore?.hasSavedSyncFromCleanShutdown() === true;
  }

  private async ensureStartedForCryptoControlPlane(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.startSyncSession({ bootstrapCrypto: false });
  }

  stopSyncWithoutPersist(): void {
    if (this.idbPersistTimer) {
      clearInterval(this.idbPersistTimer);
      this.idbPersistTimer = null;
    }
    this.currentSyncState = null;
    this.client.stopClient();
    this.started = false;
  }

  async drainPendingDecryptions(reason = "matrix client shutdown"): Promise<void> {
    await this.decryptBridge?.drainPendingDecryptions(reason);
  }

  stop(): void {
    this.stopSyncWithoutPersist();
    this.decryptBridge?.stop();
    // Final persist on shutdown
    this.syncStore?.markCleanShutdown();
    if (loadedMatrixCryptoRuntime) {
      const { persistIdbToDisk } = loadedMatrixCryptoRuntime;
      this.stopPersistPromise = Promise.all([
        persistIdbToDisk({
          snapshotPath: this.idbSnapshotPath,
          databasePrefix: this.cryptoDatabasePrefix,
        }).catch(noop),
        this.syncStore?.flush().catch(noop),
      ]).then(() => undefined);
      return;
    }
    this.stopPersistPromise = loadMatrixCryptoRuntime()
      .then(async ({ persistIdbToDisk }) => {
        await Promise.all([
          persistIdbToDisk({
            snapshotPath: this.idbSnapshotPath,
            databasePrefix: this.cryptoDatabasePrefix,
          }).catch(noop),
          this.syncStore?.flush().catch(noop),
        ]);
      })
      .catch(noop)
      .then(() => undefined);
  }

  async stopAndPersist(): Promise<void> {
    this.stop();
    await this.stopPersistPromise;
  }

  private async bootstrapCryptoIfNeeded(abortSignal?: AbortSignal): Promise<void> {
    if (!this.encryptionEnabled || !this.cryptoInitialized || this.cryptoBootstrapped) {
      return;
    }
    throwIfMatrixStartupAborted(abortSignal);
    await this.ensureCryptoSupportInitialized();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return;
    }
    const cryptoBootstrapper = this.cryptoBootstrapper;
    if (!cryptoBootstrapper) {
      return;
    }
    const initial = await cryptoBootstrapper.bootstrap(
      crypto,
      MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS,
    );
    throwIfMatrixStartupAborted(abortSignal);
    if (!initial.crossSigningPublished || initial.ownDeviceVerified === false) {
      const status = await this.getOwnDeviceVerificationStatus();
      if (status.signedByOwner) {
        LogService.warn(
          "MatrixClientLite",
          "Cross-signing/bootstrap is incomplete for an already owner-signed device; skipping automatic reset and preserving the current identity. Restore the recovery key or run an explicit verification bootstrap if repair is needed.",
        );
      } else {
        // No password guard: passwordless token-auth bots should still attempt repair.
        // UIA failures inside bootstrap() are caught below and logged as warnings.
        try {
          // The repair path already force-resets cross-signing; allow secret storage
          // recreation so the new keys can be persisted. Without this, a device that
          // lost its recovery key enters a permanent failure loop because the new
          // cross-signing keys have nowhere to be stored.
          const repaired = await cryptoBootstrapper.bootstrap(
            crypto,
            MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS,
          );
          throwIfMatrixStartupAborted(abortSignal);
          if (repaired.crossSigningPublished && repaired.ownDeviceVerified !== false) {
            LogService.info(
              "MatrixClientLite",
              "Cross-signing/bootstrap recovered after forced reset",
            );
          }
        } catch (err) {
          LogService.warn(
            "MatrixClientLite",
            "Failed to recover cross-signing/bootstrap with forced reset:",
            err,
          );
        }
      }
    }
    this.cryptoBootstrapped = true;
  }

  private async initializeCryptoIfNeeded(abortSignal?: AbortSignal): Promise<void> {
    if (!this.encryptionEnabled || this.cryptoInitialized) {
      return;
    }
    throwIfMatrixStartupAborted(abortSignal);
    const { persistIdbToDisk, restoreIdbFromDisk } = await loadMatrixCryptoRuntime();

    // Restore persisted IndexedDB crypto store before initializing WASM crypto.
    await restoreIdbFromDisk(this.idbSnapshotPath);
    throwIfMatrixStartupAborted(abortSignal);

    try {
      await this.client.initRustCrypto({
        cryptoDatabasePrefix: this.cryptoDatabasePrefix,
      });
      this.cryptoInitialized = true;
      throwIfMatrixStartupAborted(abortSignal);

      // Persist the crypto store after successful init (captures fresh keys on first run).
      await persistIdbToDisk({
        snapshotPath: this.idbSnapshotPath,
        databasePrefix: this.cryptoDatabasePrefix,
      });
      throwIfMatrixStartupAborted(abortSignal);

      // Periodically persist to capture new Olm sessions and room keys.
      this.idbPersistTimer = setInterval(() => {
        persistIdbToDisk({
          snapshotPath: this.idbSnapshotPath,
          databasePrefix: this.cryptoDatabasePrefix,
        }).catch(noop);
      }, MATRIX_IDB_PERSIST_INTERVAL_MS);
      this.idbPersistTimer.unref?.();
    } catch (err) {
      LogService.warn("MatrixClientLite", "Failed to initialize rust crypto:", err);
    }
  }

  async getUserId(): Promise<string> {
    const fromClient = this.client.getUserId();
    if (fromClient) {
      this.selfUserId = fromClient;
      return fromClient;
    }
    if (this.selfUserId) {
      return this.selfUserId;
    }
    const whoami = (await this.doRequest("GET", "/_matrix/client/v3/account/whoami")) as {
      user_id?: string;
    };
    const resolved = whoami.user_id?.trim();
    if (!resolved) {
      throw new Error("Matrix whoami did not return user_id");
    }
    this.selfUserId = resolved;
    return resolved;
  }

  async getJoinedRooms(): Promise<string[]> {
    const joined = await this.client.getJoinedRooms();
    return Array.isArray(joined.joined_rooms) ? joined.joined_rooms : [];
  }

  async getJoinedRoomMembers(roomId: string): Promise<string[]> {
    const members = await this.client.getJoinedRoomMembers(roomId);
    const joined = members?.joined;
    if (!joined || typeof joined !== "object") {
      return [];
    }
    return Object.keys(joined);
  }

  async getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey = "",
  ): Promise<Record<string, unknown>> {
    const state = await this.client.getStateEvent(roomId, eventType, stateKey);
    return (state ?? {}) as Record<string, unknown>;
  }

  async getAccountData(eventType: string): Promise<Record<string, unknown> | undefined> {
    const event = this.client.getAccountData(eventType as never);
    return (event?.getContent() as Record<string, unknown> | undefined) ?? undefined;
  }

  async setAccountData(eventType: string, content: Record<string, unknown>): Promise<void> {
    await this.client.setAccountData(eventType as never, content as never);
    await this.refreshDmCache().catch(noop);
  }

  async resolveRoom(aliasOrRoomId: string): Promise<string | null> {
    if (aliasOrRoomId.startsWith("!")) {
      return aliasOrRoomId;
    }
    if (!aliasOrRoomId.startsWith("#")) {
      return aliasOrRoomId;
    }
    try {
      const resolved = await this.client.getRoomIdForAlias(aliasOrRoomId);
      return resolved.room_id ?? null;
    } catch {
      return null;
    }
  }

  async createDirectRoom(
    remoteUserId: string,
    opts: { encrypted?: boolean } = {},
  ): Promise<string> {
    const initialState = opts.encrypted
      ? [
          {
            type: "m.room.encryption",
            state_key: "",
            content: {
              algorithm: "m.megolm.v1.aes-sha2",
            },
          },
        ]
      : undefined;
    const result = await this.client.createRoom({
      invite: [remoteUserId],
      is_direct: true,
      preset: Preset.TrustedPrivateChat,
      initial_state: initialState,
    });
    return result.room_id;
  }

  async sendMessage(roomId: string, content: MessageEventContent): Promise<string> {
    return await this.runSerializedRoomSend(roomId, async () => {
      const sent = await this.client.sendMessage(roomId, content as never);
      return sent.event_id;
    });
  }

  async sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    return await this.runSerializedRoomSend(roomId, async () => {
      const sent = await this.client.sendEvent(roomId, eventType as never, content as never);
      return sent.event_id;
    });
  }

  // Keep outbound room events ordered when multiple plugin paths emit
  // messages/reactions/polls into the same Matrix room concurrently.
  private async runSerializedRoomSend<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    return await this.sendQueue.enqueue(roomId, task);
  }

  async sendStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const sent = await this.client.sendStateEvent(
      roomId,
      eventType as never,
      content as never,
      stateKey,
    );
    return sent.event_id;
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const sent = await this.client.redactEvent(
      roomId,
      eventId,
      undefined,
      reason?.trim() ? { reason } : undefined,
    );
    return sent.event_id;
  }

  async doRequest(
    method: HttpMethod,
    endpoint: string,
    qs?: QueryParams,
    body?: unknown,
    opts?: { allowAbsoluteEndpoint?: boolean },
  ): Promise<unknown> {
    return await this.httpClient.requestJson({
      method,
      endpoint,
      qs,
      body,
      timeoutMs: this.localTimeoutMs,
      allowAbsoluteEndpoint: opts?.allowAbsoluteEndpoint,
    });
  }

  async getUserProfile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> {
    return await this.client.getProfileInfo(userId);
  }

  async setDisplayName(displayName: string): Promise<void> {
    await this.client.setDisplayName(displayName);
  }

  async setAvatarUrl(avatarUrl: string): Promise<void> {
    await this.client.setAvatarUrl(avatarUrl);
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.client.joinRoom(roomId);
  }

  mxcToHttp(mxcUrl: string): string | null {
    return this.client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, true, false, true);
  }

  async downloadContent(
    mxcUrl: string,
    opts: {
      allowRemote?: boolean;
      maxBytes?: number;
      readIdleTimeoutMs?: number;
    } = {},
  ): Promise<Buffer> {
    const parsed = parseMxc(mxcUrl);
    if (!parsed) {
      throw new Error(`Invalid Matrix content URI: ${mxcUrl}`);
    }
    const encodedServer = encodeURIComponent(parsed.server);
    const encodedMediaId = encodeURIComponent(parsed.mediaId);
    const request = async (endpoint: string): Promise<Buffer> =>
      await this.httpClient.requestRaw({
        method: "GET",
        endpoint,
        qs: { allow_remote: opts.allowRemote ?? true },
        timeoutMs: this.localTimeoutMs,
        maxBytes: opts.maxBytes,
        readIdleTimeoutMs: opts.readIdleTimeoutMs,
      });

    const authenticatedEndpoint = `/_matrix/client/v1/media/download/${encodedServer}/${encodedMediaId}`;
    try {
      return await request(authenticatedEndpoint);
    } catch (err) {
      if (!isUnsupportedAuthenticatedMediaEndpointError(err)) {
        throw err;
      }
    }

    const legacyEndpoint = `/_matrix/media/v3/download/${encodedServer}/${encodedMediaId}`;
    return await request(legacyEndpoint);
  }

  async uploadContent(file: Buffer, contentType?: string, filename?: string): Promise<string> {
    const uploaded = await this.client.uploadContent(new Uint8Array(file), {
      type: contentType || "application/octet-stream",
      name: filename,
      includeFilename: Boolean(filename),
    });
    return uploaded.content_uri;
  }

  async getEvent(roomId: string, eventId: string): Promise<Record<string, unknown>> {
    const rawEvent = (await this.client.fetchRoomEvent(roomId, eventId)) as Record<string, unknown>;
    if (rawEvent.type !== "m.room.encrypted") {
      return rawEvent;
    }

    const mapper = this.client.getEventMapper();
    const event = mapper(rawEvent);
    let decryptedEvent: MatrixEvent | undefined;
    const onDecrypted = (candidate: MatrixEvent) => {
      decryptedEvent = candidate;
    };
    event.once(MatrixEventEvent.Decrypted, onDecrypted);
    try {
      await this.client.decryptEventIfNeeded(event);
    } finally {
      event.off(MatrixEventEvent.Decrypted, onDecrypted);
    }
    return matrixEventToRaw(decryptedEvent ?? event);
  }

  async getRelations(
    roomId: string,
    eventId: string,
    relationType: string | null,
    eventType?: string | null,
    opts: {
      from?: string;
    } = {},
  ): Promise<MatrixRelationsPage> {
    const result = await this.client.relations(roomId, eventId, relationType, eventType, opts);
    return {
      originalEvent: result.originalEvent ? matrixEventToRaw(result.originalEvent) : null,
      events: result.events.map((event) => matrixEventToRaw(event)),
      nextBatch: result.nextBatch ?? null,
      prevBatch: result.prevBatch ?? null,
    };
  }

  async hydrateEvents(
    roomId: string,
    events: Array<Record<string, unknown>>,
  ): Promise<MatrixRawEvent[]> {
    if (events.length === 0) {
      return [];
    }

    const mapper = this.client.getEventMapper();
    const mappedEvents = events.map((event) =>
      mapper({
        room_id: roomId,
        ...event,
      }),
    );
    await Promise.all(mappedEvents.map((event) => this.client.decryptEventIfNeeded(event)));
    return mappedEvents.map((event) => matrixEventToRaw(event));
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs: number): Promise<void> {
    await this.client.sendTyping(roomId, typing, timeoutMs);
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.httpClient.requestJson({
      method: "POST",
      endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(
        eventId,
      )}`,
      body: {},
      timeoutMs: this.localTimeoutMs,
    });
  }

  async getRoomKeyBackupStatus(): Promise<MatrixRoomKeyBackupStatus> {
    if (!this.encryptionEnabled) {
      return {
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: null,
        keyLoadAttempted: false,
        keyLoadError: null,
      };
    }

    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    const serverVersionFallback = await this.resolveRoomKeyBackupVersion();
    if (!crypto) {
      return {
        serverVersion: serverVersionFallback,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: null,
        keyLoadAttempted: false,
        keyLoadError: null,
      };
    }

    let { activeVersion, decryptionKeyCached } = await this.resolveRoomKeyBackupLocalState(crypto);
    let { serverVersion, trusted, matchesDecryptionKey } =
      await this.resolveRoomKeyBackupTrustState(crypto, serverVersionFallback);
    const shouldLoadBackupKey =
      Boolean(serverVersion) && (decryptionKeyCached === false || matchesDecryptionKey === false);
    const shouldActivateBackup = Boolean(serverVersion) && !activeVersion;
    let keyLoadAttempted = false;
    let keyLoadError: string | null = null;
    if (serverVersion && (shouldLoadBackupKey || shouldActivateBackup)) {
      if (shouldLoadBackupKey) {
        if (
          typeof crypto.loadSessionBackupPrivateKeyFromSecretStorage ===
          "function" /* pragma: allowlist secret */
        ) {
          keyLoadAttempted = true;
          try {
            await crypto.loadSessionBackupPrivateKeyFromSecretStorage(); // pragma: allowlist secret
          } catch (err) {
            keyLoadError = formatMatrixErrorMessage(err);
          }
        } else {
          keyLoadError =
            "Matrix crypto backend does not support loading backup keys from secret storage";
        }
      }
      if (!keyLoadError) {
        await this.enableTrustedRoomKeyBackupIfPossible(crypto);
      }
      ({ activeVersion, decryptionKeyCached } = await this.resolveRoomKeyBackupLocalState(crypto));
      ({ serverVersion, trusted, matchesDecryptionKey } = await this.resolveRoomKeyBackupTrustState(
        crypto,
        serverVersion,
      ));
    }

    return {
      serverVersion,
      activeVersion,
      trusted,
      matchesDecryptionKey,
      decryptionKeyCached,
      keyLoadAttempted,
      keyLoadError,
    };
  }

  async getDeviceVerificationStatus(
    userId: string | null | undefined,
    deviceId: string | null | undefined,
  ): Promise<MatrixDeviceVerificationStatus> {
    const normalizedUserId = userId?.trim() || null;
    const normalizedDeviceId = deviceId?.trim() || null;
    if (!this.encryptionEnabled) {
      return {
        encryptionEnabled: false,
        userId: normalizedUserId,
        deviceId: normalizedDeviceId,
        verified: false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
      };
    }

    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    let deviceStatus: MatrixDeviceVerificationStatusLike | null = null;
    if (
      crypto &&
      normalizedUserId &&
      normalizedDeviceId &&
      typeof crypto.getDeviceVerificationStatus === "function"
    ) {
      deviceStatus = await crypto
        .getDeviceVerificationStatus(normalizedUserId, normalizedDeviceId)
        .catch(() => null);
    }
    const { isMatrixDeviceVerifiedInCurrentClient } = await loadMatrixCryptoRuntime();

    return {
      encryptionEnabled: true,
      userId: normalizedUserId,
      deviceId: normalizedDeviceId,
      verified: isMatrixDeviceVerifiedInCurrentClient(deviceStatus),
      localVerified: deviceStatus?.localVerified === true,
      crossSigningVerified: deviceStatus?.crossSigningVerified === true,
      signedByOwner: deviceStatus?.signedByOwner === true,
    };
  }

  async getOwnDeviceVerificationStatus(): Promise<MatrixOwnDeviceVerificationStatus> {
    const recoveryKey = this.recoveryKeyStore.getRecoveryKeySummary();
    const userId = this.client.getUserId() ?? this.selfUserId ?? null;
    const deviceId = this.client.getDeviceId()?.trim() || null;
    const [backup, deviceVerification, ownDevices] = await Promise.all([
      this.getRoomKeyBackupStatus(),
      this.getDeviceVerificationStatus(userId, deviceId),
      this.listOwnDevices().catch(() => null),
    ]);
    const serverDeviceKnown = deviceId
      ? (ownDevices?.some((device) => device.deviceId === deviceId) ?? null)
      : null;

    return {
      ...deviceVerification,
      verified: deviceVerification.crossSigningVerified,
      recoveryKeyStored: Boolean(recoveryKey),
      recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
      recoveryKeyId: recoveryKey?.keyId ?? null,
      backupVersion: backup.serverVersion,
      backup,
      serverDeviceKnown,
    };
  }

  async getOwnDeviceIdentityVerificationStatus(): Promise<MatrixDeviceVerificationStatus> {
    const userId = this.client.getUserId() ?? this.selfUserId ?? null;
    const deviceId = this.client.getDeviceId()?.trim() || null;
    const deviceVerification = await this.getDeviceVerificationStatus(userId, deviceId);
    return {
      ...deviceVerification,
      verified: deviceVerification.crossSigningVerified,
    };
  }

  async trustOwnIdentityAfterSelfVerification(): Promise<void> {
    if (!this.encryptionEnabled) {
      return;
    }

    await this.ensureStartedForCryptoControlPlane();
    await this.ensureCryptoSupportInitialized();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    const ownIdentity =
      crypto && typeof crypto.getOwnIdentity === "function"
        ? await crypto.getOwnIdentity().catch(() => undefined)
        : undefined;
    if (!ownIdentity) {
      return;
    }

    try {
      if (typeof ownIdentity.isVerified === "function" && ownIdentity.isVerified()) {
        return;
      }
      if (typeof ownIdentity.verify !== "function") {
        return;
      }
      await ownIdentity.verify();
    } finally {
      ownIdentity.free?.();
    }
  }

  async verifyWithRecoveryKey(
    rawRecoveryKey: string,
  ): Promise<MatrixRecoveryKeyVerificationResult> {
    const fail = async (
      error: string,
      fields: Partial<
        Pick<
          MatrixRecoveryKeyVerificationResult,
          "backupUsable" | "deviceOwnerVerified" | "recoveryKeyAccepted"
        >
      > = {},
    ): Promise<MatrixRecoveryKeyVerificationResult> => {
      const status = await this.getOwnDeviceVerificationStatus();
      return {
        success: false,
        recoveryKeyAccepted: fields.recoveryKeyAccepted ?? false,
        backupUsable: fields.backupUsable ?? false,
        deviceOwnerVerified: fields.deviceOwnerVerified ?? status.verified,
        error,
        ...status,
      };
    };

    if (!this.encryptionEnabled) {
      return await fail("Matrix encryption is disabled for this client");
    }

    await this.ensureStartedForCryptoControlPlane();
    await this.ensureCryptoSupportInitialized();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return await fail("Matrix crypto is not available (start client with encryption enabled)");
    }

    const backupUsableBeforeStagedRecovery =
      resolveMatrixRoomKeyBackupReadinessError(await this.getRoomKeyBackupStatus(), {
        requireServerBackup: true,
      }) === null;
    const trimmedRecoveryKey = rawRecoveryKey.trim();
    if (!trimmedRecoveryKey) {
      return await fail("Matrix recovery key is required");
    }

    let stagedKeyId: string | null = null;
    try {
      stagedKeyId = (await this.resolveDefaultSecretStorageKeyId(crypto)) ?? null;
      this.recoveryKeyStore.stageEncodedRecoveryKey({
        encodedPrivateKey: trimmedRecoveryKey,
        keyId: stagedKeyId,
      });
    } catch (err) {
      return await fail(formatMatrixErrorMessage(err));
    }

    try {
      const cryptoBootstrapper = this.cryptoBootstrapper;
      if (!cryptoBootstrapper) {
        return await fail("Matrix crypto bootstrapper is not available");
      }
      await cryptoBootstrapper.bootstrap(crypto, {
        allowAutomaticCrossSigningReset: false,
      });
      await this.enableTrustedRoomKeyBackupIfPossible(crypto);
      const status = await this.getOwnDeviceVerificationStatus();
      const backupError = resolveMatrixRoomKeyBackupReadinessError(status.backup, {
        requireServerBackup: false,
      });
      const backupUsable =
        resolveMatrixRoomKeyBackupReadinessError(status.backup, {
          requireServerBackup: true,
        }) === null;
      const stagedRecoveryKeyUsed = this.recoveryKeyStore.hasStagedRecoveryKeyBeenUsed();
      const secretStorageStatus =
        typeof crypto.getSecretStorageStatus === "function"
          ? await crypto.getSecretStorageStatus().catch(() => null)
          : null;
      const stagedRecoveryKeyConfirmedBySecretStorage =
        Boolean(stagedKeyId) &&
        secretStorageStatus?.secretStorageKeyValidityMap?.[stagedKeyId ?? ""] === true;
      const stagedRecoveryKeyRejectedBySecretStorage =
        Boolean(stagedKeyId) &&
        secretStorageStatus?.secretStorageKeyValidityMap?.[stagedKeyId ?? ""] === false;
      const stagedRecoveryKeyUnlockedBackup =
        stagedRecoveryKeyUsed &&
        !stagedRecoveryKeyRejectedBySecretStorage &&
        !stagedRecoveryKeyConfirmedBySecretStorage &&
        !backupUsableBeforeStagedRecovery &&
        backupUsable;
      const storedRecoveryKeyMatches =
        this.recoveryKeyStore.getRecoveryKeySummary()?.encodedPrivateKey?.trim() ===
        trimmedRecoveryKey;
      const stagedRecoveryKeyValidated =
        (stagedRecoveryKeyUsed &&
          (stagedRecoveryKeyConfirmedBySecretStorage || stagedRecoveryKeyUnlockedBackup)) ||
        (storedRecoveryKeyMatches && backupUsable);
      const recoveryKeyAccepted = stagedRecoveryKeyValidated && (status.verified || backupUsable);
      if (!status.verified) {
        if (backupUsable && stagedRecoveryKeyValidated) {
          this.recoveryKeyStore.commitStagedRecoveryKey({
            keyId: stagedKeyId,
          });
        } else {
          this.recoveryKeyStore.discardStagedRecoveryKey();
        }
        const committedStatus = recoveryKeyAccepted
          ? await this.getOwnDeviceVerificationStatus()
          : status;
        return {
          success: false,
          recoveryKeyAccepted,
          backupUsable,
          deviceOwnerVerified: false,
          error:
            "Matrix recovery key was applied, but this device still lacks full Matrix identity trust. The recovery key can unlock usable backup material only when 'Backup usable' is yes; full identity trust still requires Matrix cross-signing verification.",
          ...committedStatus,
        };
      }
      if (backupError) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return {
          success: false,
          recoveryKeyAccepted,
          backupUsable,
          deviceOwnerVerified: true,
          error: backupError,
          ...status,
        };
      }
      if (!stagedRecoveryKeyValidated) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return {
          success: false,
          recoveryKeyAccepted: false,
          backupUsable,
          deviceOwnerVerified: true,
          error:
            "Matrix recovery key could not be verified against active Matrix backup material; existing backup may be usable from previously loaded recovery material.",
          ...status,
        };
      }

      this.recoveryKeyStore.commitStagedRecoveryKey({
        keyId: stagedKeyId,
      });
      const committedStatus = await this.getOwnDeviceVerificationStatus();
      return {
        success: true,
        recoveryKeyAccepted: true,
        backupUsable,
        deviceOwnerVerified: true,
        verifiedAt: new Date().toISOString(),
        ...committedStatus,
      };
    } catch (err) {
      this.recoveryKeyStore.discardStagedRecoveryKey();
      return await fail(formatMatrixErrorMessage(err));
    }
  }

  async restoreRoomKeyBackup(
    params: {
      recoveryKey?: string;
    } = {},
  ): Promise<MatrixRoomKeyBackupRestoreResult> {
    let loadedFromSecretStorage = false;
    const fail = async (error: string): Promise<MatrixRoomKeyBackupRestoreResult> => {
      const backup = await this.getRoomKeyBackupStatus();
      return {
        success: false,
        error,
        backupVersion: backup.serverVersion,
        imported: 0,
        total: 0,
        loadedFromSecretStorage,
        backup,
      };
    };

    if (!this.encryptionEnabled) {
      return await fail("Matrix encryption is disabled for this client");
    }

    await this.ensureStartedForCryptoControlPlane();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return await fail("Matrix crypto is not available (start client with encryption enabled)");
    }

    try {
      const rawRecoveryKey = params.recoveryKey?.trim();
      if (rawRecoveryKey) {
        this.recoveryKeyStore.stageEncodedRecoveryKey({
          encodedPrivateKey: rawRecoveryKey,
          keyId: await this.resolveDefaultSecretStorageKeyId(crypto),
        });
      }

      const backup = await this.getRoomKeyBackupStatus();
      loadedFromSecretStorage = backup.keyLoadAttempted && !backup.keyLoadError;
      const backupError = resolveMatrixRoomKeyBackupReadinessError(backup, {
        allowUntrustedMatchingKey: true,
        requireServerBackup: true,
      });
      if (backupError) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return await fail(backupError);
      }
      if (typeof crypto.restoreKeyBackup !== "function") {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return await fail("Matrix crypto backend does not support full key backup restore");
      }

      const restore = await crypto.restoreKeyBackup();
      if (rawRecoveryKey) {
        this.recoveryKeyStore.commitStagedRecoveryKey({
          keyId: await this.resolveDefaultSecretStorageKeyId(crypto),
        });
      }
      const finalBackup = await this.getRoomKeyBackupStatus();
      return {
        success: true,
        backupVersion: backup.serverVersion,
        imported: typeof restore.imported === "number" ? restore.imported : 0,
        total: typeof restore.total === "number" ? restore.total : 0,
        loadedFromSecretStorage,
        restoredAt: new Date().toISOString(),
        backup: finalBackup,
      };
    } catch (err) {
      this.recoveryKeyStore.discardStagedRecoveryKey();
      return await fail(formatMatrixErrorMessage(err));
    }
  }

  async resetRoomKeyBackup(
    options: MatrixRoomKeyBackupResetOptions = {},
  ): Promise<MatrixRoomKeyBackupResetResult> {
    let previousVersion: string | null = null;
    let deletedVersion: string | null = null;
    const fail = async (error: string): Promise<MatrixRoomKeyBackupResetResult> => {
      const backup = await this.getRoomKeyBackupStatus();
      return {
        success: false,
        error,
        previousVersion,
        deletedVersion,
        createdVersion: backup.serverVersion,
        backup,
      };
    };

    if (!this.encryptionEnabled) {
      return await fail("Matrix encryption is disabled for this client");
    }

    await this.ensureStartedForCryptoControlPlane();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return await fail("Matrix crypto is not available (start client with encryption enabled)");
    }

    previousVersion = await this.resolveRoomKeyBackupVersion();

    // Probe backup-secret access directly before reset. This keeps the reset preflight
    // focused on durable secret-storage health instead of the broader backup status flow,
    // and still catches stale SSSS/recovery-key state even when the server backup is gone.
    const forceNewSecretStorage =
      options.rotateRecoveryKey === true ||
      (await this.shouldForceSecretStorageRecreationForBackupReset(crypto));

    try {
      if (previousVersion) {
        try {
          await this.doRequest(
            "DELETE",
            `/_matrix/client/v3/room_keys/version/${encodeURIComponent(previousVersion)}`,
          );
        } catch (err) {
          if (!isMatrixNotFoundError(err)) {
            throw err;
          }
        }
        deletedVersion = previousVersion;
      }

      await this.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
        setupNewKeyBackup: true,
        // Force SSSS recreation when the existing SSSS key is broken (bad MAC), so
        // the new backup key is written into a fresh SSSS consistent with recovery_key.json.
        forceNewSecretStorage,
        forceNewRecoveryKey: options.rotateRecoveryKey === true,
        // Also allow recreation if bootstrapSecretStorage itself surfaces a repairable
        // error (e.g. bad MAC from a different SSSS entry).
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      });
      await this.enableTrustedRoomKeyBackupIfPossible(crypto);

      const backup = await this.getRoomKeyBackupStatus();
      const createdVersion = backup.serverVersion;
      if (!createdVersion) {
        return await fail("Matrix room key backup is still missing after reset.");
      }
      if (backup.activeVersion !== createdVersion) {
        return await fail(
          "Matrix room key backup was recreated on the server but is not active on this device.",
        );
      }
      if (backup.decryptionKeyCached === false) {
        return await fail(
          "Matrix room key backup was recreated but its decryption key is not cached on this device.",
        );
      }
      if (backup.matchesDecryptionKey === false) {
        return await fail(
          "Matrix room key backup was recreated but this device does not have the matching backup decryption key.",
        );
      }
      if (backup.trusted === false) {
        return await fail(
          "Matrix room key backup was recreated but is not trusted on this device.",
        );
      }

      return {
        success: true,
        previousVersion,
        deletedVersion,
        createdVersion,
        resetAt: new Date().toISOString(),
        backup,
      };
    } catch (err) {
      return await fail(formatMatrixErrorMessage(err));
    }
  }

  async getOwnCrossSigningPublicationStatus(): Promise<MatrixOwnCrossSigningPublicationStatus> {
    const userId = this.client.getUserId() ?? this.selfUserId ?? null;
    if (!userId) {
      return {
        userId: null,
        masterKeyPublished: false,
        selfSigningKeyPublished: false,
        userSigningKeyPublished: false,
        published: false,
      };
    }

    try {
      const response = (await this.doRequest("POST", "/_matrix/client/v3/keys/query", undefined, {
        device_keys: { [userId]: [] as string[] },
      })) as {
        master_keys?: Record<string, unknown>;
        self_signing_keys?: Record<string, unknown>;
        user_signing_keys?: Record<string, unknown>;
      };
      const masterKeyPublished = Boolean(response.master_keys?.[userId]);
      const selfSigningKeyPublished = Boolean(response.self_signing_keys?.[userId]);
      const userSigningKeyPublished = Boolean(response.user_signing_keys?.[userId]);
      return {
        userId,
        masterKeyPublished,
        selfSigningKeyPublished,
        userSigningKeyPublished,
        published: masterKeyPublished && selfSigningKeyPublished && userSigningKeyPublished,
      };
    } catch {
      return {
        userId,
        masterKeyPublished: false,
        selfSigningKeyPublished: false,
        userSigningKeyPublished: false,
        published: false,
      };
    }
  }

  async bootstrapOwnDeviceVerification(params?: {
    allowAutomaticCrossSigningReset?: boolean;
    recoveryKey?: string;
    forceResetCrossSigning?: boolean;
    strict?: boolean;
  }): Promise<MatrixVerificationBootstrapResult> {
    const pendingVerifications = async (): Promise<number> =>
      this.crypto ? (await this.crypto.listVerifications()).length : 0;
    if (!this.encryptionEnabled) {
      return {
        success: false,
        error: "Matrix encryption is disabled for this client",
        verification: await this.getOwnDeviceVerificationStatus(),
        crossSigning: await this.getOwnCrossSigningPublicationStatus(),
        pendingVerifications: await pendingVerifications(),
        cryptoBootstrap: null,
      };
    }

    let bootstrapError: string | undefined;
    let bootstrapSummary: MatrixCryptoBootstrapResult | null = null;
    try {
      await this.ensureStartedForCryptoControlPlane();
      await this.ensureCryptoSupportInitialized();
      const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
      if (!crypto) {
        throw new Error("Matrix crypto is not available (start client with encryption enabled)");
      }

      const rawRecoveryKey = params?.recoveryKey?.trim();
      if (rawRecoveryKey) {
        this.recoveryKeyStore.stageEncodedRecoveryKey({
          encodedPrivateKey: rawRecoveryKey,
          keyId: await this.resolveDefaultSecretStorageKeyId(crypto),
        });
      }

      const cryptoBootstrapper = this.cryptoBootstrapper;
      if (!cryptoBootstrapper) {
        throw new Error("Matrix crypto bootstrapper is not available");
      }
      bootstrapSummary = await cryptoBootstrapper.bootstrap(
        crypto,
        createMatrixExplicitBootstrapOptions(params),
      );
      await this.ensureRoomKeyBackupEnabled(crypto);
    } catch (err) {
      this.recoveryKeyStore.discardStagedRecoveryKey();
      bootstrapError = formatMatrixErrorMessage(err);
    }

    const verification = await this.getOwnDeviceVerificationStatus();
    const crossSigning = await this.getOwnCrossSigningPublicationStatus();
    const verificationError =
      verification.verified && crossSigning.published
        ? null
        : (bootstrapError ??
          "Matrix verification bootstrap did not produce a device verified by its owner with published cross-signing keys");
    const backupError =
      verificationError === null
        ? resolveMatrixRoomKeyBackupReadinessError(verification.backup, {
            requireServerBackup: true,
          })
        : null;
    const success = verificationError === null && backupError === null;
    if (success) {
      this.recoveryKeyStore.commitStagedRecoveryKey({
        keyId: await this.resolveDefaultSecretStorageKeyId(
          this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined,
        ),
      });
    } else {
      this.recoveryKeyStore.discardStagedRecoveryKey();
    }
    const error = success ? undefined : (backupError ?? verificationError ?? undefined);
    return {
      success,
      error,
      verification: success ? await this.getOwnDeviceVerificationStatus() : verification,
      crossSigning,
      pendingVerifications: await pendingVerifications(),
      cryptoBootstrap: bootstrapSummary,
    };
  }

  async listOwnDevices(): Promise<MatrixOwnDeviceInfo[]> {
    const currentDeviceId = this.client.getDeviceId()?.trim() || null;
    const devices = await this.client.getDevices();
    const entries = Array.isArray(devices?.devices) ? devices.devices : [];
    return entries.map((device) => ({
      deviceId: device.device_id,
      displayName: device.display_name?.trim() || null,
      lastSeenIp: device.last_seen_ip?.trim() || null,
      lastSeenTs:
        typeof device.last_seen_ts === "number" && Number.isFinite(device.last_seen_ts)
          ? device.last_seen_ts
          : null,
      current: currentDeviceId !== null && device.device_id === currentDeviceId,
    }));
  }

  async deleteOwnDevices(deviceIds: string[]): Promise<MatrixOwnDeviceDeleteResult> {
    const uniqueDeviceIds = [...new Set(deviceIds.map((value) => value.trim()).filter(Boolean))];
    const currentDeviceId = this.client.getDeviceId()?.trim() || null;
    const protectedDeviceIds = uniqueDeviceIds.filter((deviceId) => deviceId === currentDeviceId);
    if (protectedDeviceIds.length > 0) {
      throw new Error(`Refusing to delete the current Matrix device: ${protectedDeviceIds[0]}`);
    }

    const deleteWithAuth = async (authData?: Record<string, unknown>): Promise<void> => {
      await this.client.deleteMultipleDevices(uniqueDeviceIds, authData as never);
    };

    if (uniqueDeviceIds.length > 0) {
      try {
        await deleteWithAuth();
      } catch (err) {
        const session =
          err &&
          typeof err === "object" &&
          "data" in err &&
          err.data &&
          typeof err.data === "object" &&
          "session" in err.data &&
          typeof err.data.session === "string"
            ? err.data.session
            : null;
        const userId = await this.getUserId().catch(() => this.selfUserId);
        if (!session || !userId || !this.password?.trim()) {
          throw err;
        }
        await deleteWithAuth({
          type: "m.login.password",
          session,
          identifier: { type: "m.id.user", user: userId },
          password: this.password,
        });
      }
    }

    return {
      currentDeviceId,
      deletedDeviceIds: uniqueDeviceIds,
      remainingDevices: await this.listOwnDevices(),
    };
  }

  private async resolveActiveRoomKeyBackupVersion(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<string | null> {
    if (typeof crypto.getActiveSessionBackupVersion !== "function") {
      return null;
    }
    const version = await crypto.getActiveSessionBackupVersion().catch(() => null);
    return normalizeOptionalString(version);
  }

  private async resolveCachedRoomKeyBackupDecryptionKey(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<boolean | null> {
    const getSessionBackupPrivateKey = crypto.getSessionBackupPrivateKey; // pragma: allowlist secret
    if (typeof getSessionBackupPrivateKey !== "function") {
      return null;
    }
    const key = await getSessionBackupPrivateKey.call(crypto).catch(() => null); // pragma: allowlist secret
    return key ? key.length > 0 : false;
  }

  private async resolveRoomKeyBackupLocalState(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<{ activeVersion: string | null; decryptionKeyCached: boolean | null }> {
    const [activeVersion, decryptionKeyCached] = await Promise.all([
      this.resolveActiveRoomKeyBackupVersion(crypto),
      this.resolveCachedRoomKeyBackupDecryptionKey(crypto),
    ]);
    return { activeVersion, decryptionKeyCached };
  }

  private async shouldForceSecretStorageRecreationForBackupReset(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<boolean> {
    const decryptionKeyCached = await this.resolveCachedRoomKeyBackupDecryptionKey(crypto);
    if (decryptionKeyCached !== false) {
      return false;
    }
    const loadSessionBackupPrivateKeyFromSecretStorage =
      crypto.loadSessionBackupPrivateKeyFromSecretStorage; // pragma: allowlist secret
    if (typeof loadSessionBackupPrivateKeyFromSecretStorage !== "function") {
      return false;
    }
    try {
      await loadSessionBackupPrivateKeyFromSecretStorage.call(crypto); // pragma: allowlist secret
      return false;
    } catch (err) {
      return isRepairableSecretStorageAccessError(err);
    }
  }

  private async resolveRoomKeyBackupTrustState(
    crypto: MatrixCryptoBootstrapApi,
    fallbackVersion: string | null,
  ): Promise<{
    serverVersion: string | null;
    trusted: boolean | null;
    matchesDecryptionKey: boolean | null;
  }> {
    let serverVersion = fallbackVersion;
    let trusted: boolean | null = null;
    let matchesDecryptionKey: boolean | null = null;
    if (typeof crypto.getKeyBackupInfo === "function") {
      const info = await crypto.getKeyBackupInfo().catch(() => null);
      serverVersion = normalizeOptionalString(info?.version) ?? serverVersion;
      if (info && typeof crypto.isKeyBackupTrusted === "function") {
        const trustInfo = await crypto.isKeyBackupTrusted(info).catch(() => null);
        trusted = typeof trustInfo?.trusted === "boolean" ? trustInfo.trusted : null;
        matchesDecryptionKey =
          typeof trustInfo?.matchesDecryptionKey === "boolean"
            ? trustInfo.matchesDecryptionKey
            : null;
      }
    }
    return { serverVersion, trusted, matchesDecryptionKey };
  }

  private async resolveDefaultSecretStorageKeyId(
    crypto: MatrixCryptoBootstrapApi | undefined,
  ): Promise<string | null | undefined> {
    const getSecretStorageStatus = crypto?.getSecretStorageStatus; // pragma: allowlist secret
    if (typeof getSecretStorageStatus !== "function") {
      return undefined;
    }
    const status = await getSecretStorageStatus.call(crypto).catch(() => null); // pragma: allowlist secret
    return status?.defaultKeyId;
  }

  private async resolveRoomKeyBackupVersion(): Promise<string | null> {
    try {
      const response = (await this.doRequest("GET", "/_matrix/client/v3/room_keys/version")) as {
        version?: string;
      };
      return normalizeOptionalString(response.version);
    } catch {
      return null;
    }
  }

  private async enableTrustedRoomKeyBackupIfPossible(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<void> {
    if (typeof crypto.checkKeyBackupAndEnable !== "function") {
      return;
    }
    await crypto.checkKeyBackupAndEnable();
  }

  private async ensureRoomKeyBackupEnabled(crypto: MatrixCryptoBootstrapApi): Promise<void> {
    const existingVersion = await this.resolveRoomKeyBackupVersion();
    if (existingVersion) {
      return;
    }
    LogService.info(
      "MatrixClientLite",
      "No room key backup version found on server, creating one via secret storage bootstrap",
    );
    // matrix-js-sdk 41.3.0 can log transient PerSessionKeyBackupDownloader
    // diagnostics while setupNewKeyBackup creates the first backup, including
    // "Got current backup version from server: undefined" and
    // "Unsupported algorithm undefined". This is an expected upstream
    // matrix-js-sdk race: resetKeyBackup emits key-backup cache events before
    // its async checkKeyBackupAndEnable pass has populated active backup state.
    // Keep the explicit server re-check below and do not hide the SDK logs; if
    // this needs fixing in code, upstream a minimal Matrix SDK repro instead of
    // patching here.
    await this.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
      setupNewKeyBackup: true,
    });
    const createdVersion = await this.resolveRoomKeyBackupVersion();
    if (!createdVersion) {
      throw new Error("Matrix room key backup is still missing after bootstrap");
    }
    LogService.info("MatrixClientLite", `Room key backup enabled (version ${createdVersion})`);
  }

  private registerBridge(): void {
    if (this.bridgeRegistered || !this.decryptBridge) {
      return;
    }
    this.bridgeRegistered = true;
    const decryptBridge = this.decryptBridge;

    this.client.on(ClientEvent.Event, (event: MatrixEvent) => {
      const roomId = event.getRoomId();
      if (!roomId) {
        return;
      }

      const raw = matrixEventToRaw(event, { contentMode: "original" });
      const isEncryptedEvent = raw.type === "m.room.encrypted";
      this.emitter.emit("room.event", roomId, raw);
      if (isEncryptedEvent) {
        this.emitter.emit("room.encrypted_event", roomId, raw);
      } else {
        if (decryptBridge.shouldEmitUnencryptedMessage(roomId, raw.event_id)) {
          this.emitter.emit("room.message", roomId, raw);
        }
      }

      const stateKey = raw.state_key ?? "";
      const selfUserId = this.client.getUserId() ?? this.selfUserId ?? "";
      const membership =
        raw.type === "m.room.member"
          ? (raw.content as { membership?: string }).membership
          : undefined;
      if (stateKey && selfUserId && stateKey === selfUserId) {
        if (membership === "invite") {
          this.emitter.emit("room.invite", roomId, raw);
        } else if (membership === "join") {
          this.emitter.emit("room.join", roomId, raw);
        }
      }

      if (isEncryptedEvent) {
        decryptBridge.attachEncryptedEvent(event, roomId);
      }
    });

    // Some SDK invite transitions are surfaced as room lifecycle events instead of raw timeline events.
    this.client.on(ClientEvent.Room, (room) => {
      this.emitMembershipForRoom(room);
    });
    this.client.on(
      ClientEvent.Sync,
      (state: MatrixSyncState, prevState: string | null, data?: unknown) => {
        this.currentSyncState = state;
        const error =
          data && typeof data === "object" && "error" in data
            ? (data as { error?: unknown }).error
            : undefined;
        this.emitter.emit("sync.state", state, prevState, error);
      },
    );
    this.client.on(ClientEvent.SyncUnexpectedError, (error: Error) => {
      this.emitter.emit("sync.unexpected_error", error);
    });
  }

  private emitMembershipForRoom(room: unknown): void {
    const roomObj = room as {
      roomId?: string;
      getMyMembership?: () => string | null | undefined;
      selfMembership?: string | null | undefined;
    };
    const roomId = roomObj.roomId?.trim();
    if (!roomId) {
      return;
    }
    const membership = roomObj.getMyMembership?.() ?? roomObj.selfMembership ?? undefined;
    const selfUserId = this.client.getUserId() ?? this.selfUserId ?? "";
    if (!selfUserId) {
      return;
    }
    const raw: MatrixRawEvent = {
      event_id: `$membership-${roomId}-${Date.now()}`,
      type: "m.room.member",
      sender: selfUserId,
      state_key: selfUserId,
      content: { membership },
      origin_server_ts: Date.now(),
      unsigned: { age: 0 },
    };
    if (membership === "invite") {
      this.emitter.emit("room.invite", roomId, raw);
      return;
    }
    if (membership === "join") {
      this.emitter.emit("room.join", roomId, raw);
    }
  }

  private emitOutstandingInviteEvents(): void {
    const listRooms = (this.client as { getRooms?: () => unknown[] }).getRooms;
    if (typeof listRooms !== "function") {
      return;
    }
    const rooms = listRooms.call(this.client);
    if (!Array.isArray(rooms)) {
      return;
    }
    for (const room of rooms) {
      this.emitMembershipForRoom(room);
    }
  }

  private async refreshDmCache(): Promise<boolean> {
    const direct = await this.getAccountData("m.direct");
    this.dmRoomIds.clear();
    if (!direct || typeof direct !== "object") {
      return false;
    }
    for (const value of Object.values(direct)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const roomId of value) {
        if (typeof roomId === "string" && roomId.trim()) {
          this.dmRoomIds.add(roomId);
        }
      }
    }
    return true;
  }
}
