import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  Filter,
  createClient as createMatrixJsClient,
  type IFilterDefinition,
  type MatrixClient as MatrixJsClient,
} from "matrix-js-sdk/lib/matrix.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "../../runtime-api.js";
import { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import { createMatrixJsSdkClientLogger } from "../client/logging.js";
import { createMatrixStartupAbortError, throwIfMatrixStartupAborted } from "../startup-abort.js";
import {
  isMatrixReadySyncState,
  isMatrixTerminalSyncState,
  type MatrixSyncState,
} from "../sync-state.js";
import {
  MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS,
  MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS,
  isMatrixAccessTokenInvalidatedError,
  resolveMatrixLocalTimeoutMs,
  type MatrixOwnDeviceInfo,
  type MatrixOwnDeviceVerificationStatus,
} from "./client-support.js";
import type { MatrixCryptoFacade } from "./crypto-facade.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { matrixEventToRaw } from "./event-helpers.js";
import { MatrixAuthedHttpClient } from "./http-client.js";
import { MATRIX_IDB_PERSIST_INTERVAL_MS } from "./idb-persistence-lock.js";
import { LogService, noop } from "./logger.js";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { createMatrixGuardedFetch } from "./transport.js";
import type { MatrixClientEventMap, MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";
import type { MatrixVerificationSummary } from "./verification-manager.js";

type MatrixCryptoRuntime = typeof import("./crypto-runtime.js");

export type MatrixMessageWireDispatch = {
  roomId: string;
  eventType: "m.room.message" | "m.room.encrypted";
  transactionId: string;
  requestPath: string;
};

type MatrixMessageWireDispatchGuard = (dispatch: MatrixMessageWireDispatch) => Promise<void>;

function resolveMessageWireDispatch(
  resource: RequestInfo | URL,
  init?: RequestInit,
): MatrixMessageWireDispatch | null {
  const method = (
    init?.method ?? (resource instanceof Request ? resource.method : "GET")
  ).toUpperCase();
  if (method !== "PUT") {
    return null;
  }
  const rawUrl =
    typeof resource === "string"
      ? resource
      : resource instanceof URL
        ? resource.href
        : resource.url;
  const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
  const roomsIndex = segments.lastIndexOf("rooms");
  if (roomsIndex < 0 || segments[roomsIndex + 2] !== "send" || segments.length !== roomsIndex + 5) {
    return null;
  }
  const eventType = decodeURIComponent(segments[roomsIndex + 3] ?? "");
  if (eventType !== "m.room.message" && eventType !== "m.room.encrypted") {
    return null;
  }
  return {
    roomId: decodeURIComponent(segments[roomsIndex + 1] ?? ""),
    eventType,
    transactionId: decodeURIComponent(segments[roomsIndex + 4] ?? ""),
    requestPath: new URL(rawUrl).pathname,
  };
}

let loadedMatrixCryptoRuntime: MatrixCryptoRuntime | null = null;

export const loadMatrixCryptoRuntime = createLazyRuntimeModule(() =>
  import("./crypto-runtime.js").then((runtime) => {
    loadedMatrixCryptoRuntime = runtime;
    return runtime;
  }),
);

export abstract class MatrixClientBase {
  abstract getUserId(): Promise<string>;
  abstract getJoinedRooms(): Promise<string[]>;
  abstract listOwnDevices(): Promise<MatrixOwnDeviceInfo[]>;
  abstract getOwnDeviceVerificationStatus(): Promise<MatrixOwnDeviceVerificationStatus>;
  abstract getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey?: string,
  ): Promise<Record<string, unknown>>;
  abstract getMessageWireEventType(roomId: string): Promise<"m.room.message" | "m.room.encrypted">;
  abstract downloadContent(
    mxcUrl: string,
    opts?: { allowRemote?: boolean; maxBytes?: number; readIdleTimeoutMs?: number },
  ): Promise<Buffer>;
  protected abstract registerBridge(): void;
  protected abstract emitOutstandingInviteEvents(): void;
  protected abstract refreshDmCache(): Promise<boolean>;

  protected readonly client: MatrixJsClient;
  protected readonly emitter = new EventEmitter();
  protected readonly httpClient: MatrixAuthedHttpClient;
  protected readonly localTimeoutMs: number;
  protected readonly initialSyncLimit?: number;
  protected readonly syncFilter?: IFilterDefinition;
  protected readonly encryptionEnabled: boolean;
  protected readonly password?: string;
  protected readonly syncStore?: SqliteBackedMatrixSyncStore;
  protected readonly idbSnapshotPath?: string;
  protected readonly cryptoDatabasePrefix?: string;
  protected bridgeRegistered = false;
  protected started = false;
  protected cryptoBootstrapped = false;
  protected selfUserId: string | null;
  protected readonly dmRoomIds = new Set<string>();
  protected cryptoInitialized = false;
  protected decryptBridge?: MatrixDecryptBridge<MatrixRawEvent>;
  protected verificationManager?: import("./verification-manager.js").MatrixVerificationManager;
  protected readonly sendQueue = new KeyedAsyncQueue();
  protected readonly recoveryKeyStore: MatrixRecoveryKeyStore;
  protected cryptoBootstrapper?:
    | import("./crypto-bootstrap.js").MatrixCryptoBootstrapper<MatrixRawEvent>
    | undefined;
  protected readonly autoBootstrapCrypto: boolean;
  protected stopPersistPromise: Promise<void> | null = null;
  protected verificationSummaryListenerBound = false;
  protected currentSyncState: MatrixSyncState | null = null;
  protected currentSyncError: unknown = undefined;
  protected readonly transactionScopeHomeserver: string;
  protected readonly transactionScopeAccessTokenHash: string;
  protected transactionScopeDeviceId: string | null;
  protected transactionScopeId: string | null = null;
  protected transactionScopePromise: Promise<string> | null = null;
  private readonly messageWireDispatchGuards = new Map<string, MatrixMessageWireDispatchGuard>();

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
      storageRootDir?: string;
      recoveryKeyPath?: string;
      idbSnapshotPath?: string;
      cryptoDatabasePrefix?: string;
      autoBootstrapCrypto?: boolean;
      ssrfPolicy?: SsrFPolicy;
      dispatcherPolicy?: PinnedDispatcherPolicy;
    } = {},
  ) {
    this.transactionScopeHomeserver = homeserver;
    this.transactionScopeAccessTokenHash = createHash("sha256").update(accessToken).digest("hex");
    this.transactionScopeDeviceId = opts.deviceId?.trim() || null;
    this.httpClient = new MatrixAuthedHttpClient({
      homeserver,
      accessToken,
      ssrfPolicy: opts.ssrfPolicy,
      dispatcherPolicy: opts.dispatcherPolicy,
    });
    this.localTimeoutMs = resolveMatrixLocalTimeoutMs(opts.localTimeoutMs);
    this.initialSyncLimit = opts.initialSyncLimit;
    this.syncFilter = opts.syncFilter;
    this.encryptionEnabled = opts.encryption === true;
    const { password: loginPassword } = opts;
    this.password = loginPassword;
    this.syncStore = opts.storageRootDir
      ? new SqliteBackedMatrixSyncStore(opts.storageRootDir)
      : undefined;
    this.idbSnapshotPath = opts.idbSnapshotPath;
    this.cryptoDatabasePrefix = opts.cryptoDatabasePrefix;
    this.selfUserId = opts.userId?.trim() || null;
    this.autoBootstrapCrypto = opts.autoBootstrapCrypto !== false;
    this.recoveryKeyStore = new MatrixRecoveryKeyStore(opts.recoveryKeyPath);
    const cryptoCallbacks = this.encryptionEnabled
      ? this.recoveryKeyStore.buildCryptoCallbacks()
      : undefined;
    const guardedFetch = createMatrixGuardedFetch({
      ssrfPolicy: opts.ssrfPolicy,
      dispatcherPolicy: opts.dispatcherPolicy,
    });
    this.client = createMatrixJsClient({
      baseUrl: homeserver,
      accessToken,
      userId: opts.userId,
      deviceId: opts.deviceId,
      logger: createMatrixJsSdkClientLogger("MatrixClient"),
      localTimeoutMs: this.localTimeoutMs,
      fetchFn: (async (resource: RequestInfo | URL, init?: RequestInit) => {
        const dispatch = resolveMessageWireDispatch(resource, init);
        if (dispatch) {
          await this.messageWireDispatchGuards.get(dispatch.transactionId)?.(dispatch);
        }
        return await guardedFetch(resource, init);
      }) as typeof fetch,
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

  protected async withMessageWireDispatchGuard<T>(params: {
    transactionId?: string;
    guard?: MatrixMessageWireDispatchGuard;
    run: () => Promise<T>;
  }): Promise<T> {
    if (!params.transactionId || !params.guard) {
      return await params.run();
    }
    if (this.messageWireDispatchGuards.has(params.transactionId)) {
      throw new Error(`Matrix transaction ${params.transactionId} already has a dispatch guard`);
    }
    this.messageWireDispatchGuards.set(params.transactionId, params.guard);
    try {
      return await params.run();
    } finally {
      this.messageWireDispatchGuards.delete(params.transactionId);
    }
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

  protected idbPersistTimer: ReturnType<typeof setInterval> | null = null;

  protected async ensureCryptoSupportInitialized(): Promise<void> {
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
      canUnlockSecretStorage: async () => {
        const secretStorage = (
          this.client as {
            secretStorage?: Partial<
              Pick<MatrixJsClient["secretStorage"], "checkKey" | "getDefaultKeyId" | "getKey">
            >;
          }
        ).secretStorage;
        // Partial test/runtime facades can omit secretStorage; forced reset must fail closed
        // without turning missing recovery access into a noisy caught TypeError.
        if (
          !secretStorage ||
          typeof secretStorage.getDefaultKeyId !== "function" ||
          typeof secretStorage.getKey !== "function" ||
          typeof secretStorage.checkKey !== "function"
        ) {
          return false;
        }
        const defaultKeyId = await secretStorage.getDefaultKeyId();
        if (!defaultKeyId) {
          return false;
        }
        const keyTuple = await secretStorage.getKey(defaultKeyId);
        const key = this.recoveryKeyStore.getSecretStorageKeyCandidate(defaultKeyId);
        if (!keyTuple || !key) {
          return false;
        }
        const keyInfo = keyTuple[1];
        if (!keyInfo.iv?.trim() || !keyInfo.mac?.trim()) {
          return false;
        }
        return await secretStorage.checkKey(key, keyInfo);
      },
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
        isRoomEncrypted: async (roomId) =>
          (await this.getMessageWireEventType(roomId)) === "m.room.encrypted",
        downloadContent: (mxcUrl, opts) => this.downloadContent(mxcUrl, opts),
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

  protected async waitForInitialSyncReady(
    params: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const timeoutMs = params.timeoutMs ?? 30_000;
    if (isMatrixReadySyncState(this.currentSyncState)) {
      return;
    }
    if (isMatrixAccessTokenInvalidatedError(this.currentSyncError)) {
      throw this.currentSyncError instanceof Error
        ? this.currentSyncError
        : new Error("Matrix access token invalidated", { cause: this.currentSyncError });
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
        if (isMatrixAccessTokenInvalidatedError(error)) {
          settleReject(
            error instanceof Error ? error : new Error("Matrix access token invalidated"),
          );
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

  protected async startSyncSession(opts: {
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

  protected async ensureStartedForCryptoControlPlane(): Promise<void> {
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
    this.currentSyncError = undefined;
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

  stopWithoutPersist(): void {
    this.stopSyncWithoutPersist();
    this.decryptBridge?.stop();
    this.stopPersistPromise = Promise.resolve();
  }

  protected async bootstrapCryptoIfNeeded(abortSignal?: AbortSignal): Promise<void> {
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
        // Forced reset validates the active SSSS recovery key before rotating local keys.
        // Missing or stale recovery material fails without mutating crypto state.
        try {
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

  protected async initializeCryptoIfNeeded(abortSignal?: AbortSignal): Promise<void> {
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
}
