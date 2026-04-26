import { ensureMatrixCryptoRuntime } from "../deps.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { EncryptedFile } from "./types.js";
import type {
  MatrixVerificationCryptoApi,
  MatrixVerificationManager,
  MatrixVerificationMethod,
  MatrixVerificationSummary,
} from "./verification-manager.js";

type MatrixCryptoFacadeClient = {
  getRoom: (roomId: string) => { hasEncryptionStateEvent: () => boolean } | null;
  getCrypto: () => unknown;
  getUserId: () => string | null;
};

export type MatrixCryptoFacade = {
  prepare: (joinedRooms: string[]) => Promise<void>;
  updateSyncData: (
    toDeviceMessages: unknown,
    otkCounts: unknown,
    unusedFallbackKeyAlgs: unknown,
    changedDeviceLists: unknown,
    leftDeviceLists: unknown,
  ) => Promise<void>;
  isRoomEncrypted: (roomId: string) => Promise<boolean>;
  requestOwnUserVerification: () => Promise<MatrixVerificationSummary | null>;
  encryptMedia: (buffer: Buffer) => Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }>;
  decryptMedia: (
    file: EncryptedFile,
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
  getRecoveryKey: () => Promise<{
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null>;
  listVerifications: () => Promise<MatrixVerificationSummary[]>;
  ensureVerificationDmTracked: (params: {
    roomId: string;
    userId: string;
  }) => Promise<MatrixVerificationSummary | null>;
  requestVerification: (params: {
    ownUser?: boolean;
    userId?: string;
    deviceId?: string;
    roomId?: string;
  }) => Promise<MatrixVerificationSummary>;
  acceptVerification: (id: string) => Promise<MatrixVerificationSummary>;
  cancelVerification: (
    id: string,
    params?: { reason?: string; code?: string },
  ) => Promise<MatrixVerificationSummary>;
  startVerification: (
    id: string,
    method?: MatrixVerificationMethod,
  ) => Promise<MatrixVerificationSummary>;
  generateVerificationQr: (id: string) => Promise<{ qrDataBase64: string }>;
  scanVerificationQr: (id: string, qrDataBase64: string) => Promise<MatrixVerificationSummary>;
  confirmVerificationSas: (id: string) => Promise<MatrixVerificationSummary>;
  mismatchVerificationSas: (id: string) => Promise<MatrixVerificationSummary>;
  confirmVerificationReciprocateQr: (id: string) => Promise<MatrixVerificationSummary>;
  getVerificationSas: (
    id: string,
  ) => Promise<{ decimal?: [number, number, number]; emoji?: Array<[string, string]> }>;
};

type MatrixCryptoNodeRuntime = typeof import("./crypto-node.runtime.js");
let matrixCryptoNodeRuntimePromise: Promise<MatrixCryptoNodeRuntime> | null = null;

async function loadMatrixCryptoNodeRuntime(): Promise<MatrixCryptoNodeRuntime> {
  // Keep the native crypto package out of the main CLI startup graph.
  matrixCryptoNodeRuntimePromise ??= import("./crypto-node.runtime.js").catch((error: unknown) => {
    matrixCryptoNodeRuntimePromise = null;
    throw error;
  });
  return await matrixCryptoNodeRuntimePromise;
}

async function loadMatrixCryptoNodeBindings() {
  await ensureMatrixCryptoRuntime();
  const runtime = await loadMatrixCryptoNodeRuntime();
  return runtime.loadMatrixCryptoNodeBindings();
}

function trackInProgressToDeviceVerifications(deps: {
  client: MatrixCryptoFacadeClient;
  verificationManager: MatrixVerificationManager;
}) {
  const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
  const userId = deps.client.getUserId();
  if (!userId || typeof crypto?.getVerificationRequestsToDeviceInProgress !== "function") {
    return;
  }
  for (const request of crypto.getVerificationRequestsToDeviceInProgress(userId)) {
    deps.verificationManager.trackVerificationRequest(request);
  }
}

export function createMatrixCryptoFacade(deps: {
  client: MatrixCryptoFacadeClient;
  verificationManager: MatrixVerificationManager;
  recoveryKeyStore: MatrixRecoveryKeyStore;
  getRoomStateEvent: (
    roomId: string,
    eventType: string,
    stateKey?: string,
  ) => Promise<Record<string, unknown>>;
  downloadContent: (
    mxcUrl: string,
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
}): MatrixCryptoFacade {
  return {
    prepare: async (_joinedRooms: string[]) => {
      // matrix-js-sdk performs crypto prep during startup; no extra work required here.
    },
    updateSyncData: async (
      _toDeviceMessages: unknown,
      _otkCounts: unknown,
      _unusedFallbackKeyAlgs: unknown,
      _changedDeviceLists: unknown,
      _leftDeviceLists: unknown,
    ) => {
      // compatibility no-op
    },
    isRoomEncrypted: async (roomId: string): Promise<boolean> => {
      const room = deps.client.getRoom(roomId);
      if (room?.hasEncryptionStateEvent()) {
        return true;
      }
      try {
        const event = await deps.getRoomStateEvent(roomId, "m.room.encryption", "");
        return typeof event.algorithm === "string" && event.algorithm.length > 0;
      } catch {
        return false;
      }
    },
    requestOwnUserVerification: async () => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      return await deps.verificationManager.requestOwnUserVerification(crypto);
    },
    encryptMedia: async (
      buffer: Buffer,
    ): Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }> => {
      const { Attachment } = await loadMatrixCryptoNodeBindings();
      const encrypted = Attachment.encrypt(new Uint8Array(buffer));
      const mediaInfoJson = encrypted.mediaEncryptionInfo;
      if (!mediaInfoJson) {
        throw new Error("Matrix media encryption failed: missing media encryption info");
      }
      const parsed = JSON.parse(mediaInfoJson) as EncryptedFile;
      return {
        buffer: Buffer.from(encrypted.encryptedData),
        file: {
          key: parsed.key,
          iv: parsed.iv,
          hashes: parsed.hashes,
          v: parsed.v,
        },
      };
    },
    decryptMedia: async (
      file: EncryptedFile,
      opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
    ): Promise<Buffer> => {
      const { Attachment, EncryptedAttachment } = await loadMatrixCryptoNodeBindings();
      const encrypted = await deps.downloadContent(file.url, opts);
      const metadata: EncryptedFile = {
        url: file.url,
        key: file.key,
        iv: file.iv,
        hashes: file.hashes,
        v: file.v,
      };
      const attachment = new EncryptedAttachment(
        new Uint8Array(encrypted),
        JSON.stringify(metadata),
      );
      const decrypted = Attachment.decrypt(attachment);
      return Buffer.from(decrypted);
    },
    getRecoveryKey: async () => {
      return deps.recoveryKeyStore.getRecoveryKeySummary();
    },
    listVerifications: async () => {
      trackInProgressToDeviceVerifications(deps);
      return deps.verificationManager.listVerifications();
    },
    ensureVerificationDmTracked: async ({ roomId, userId }) => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      const request =
        typeof crypto?.findVerificationRequestDMInProgress === "function"
          ? crypto.findVerificationRequestDMInProgress(roomId, userId)
          : undefined;
      if (!request) {
        return null;
      }
      return deps.verificationManager.trackVerificationRequest(request);
    },
    requestVerification: async (params) => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      return await deps.verificationManager.requestVerification(crypto, params);
    },
    acceptVerification: async (id) => {
      trackInProgressToDeviceVerifications(deps);
      return await deps.verificationManager.acceptVerification(id);
    },
    cancelVerification: async (id, params) => {
      trackInProgressToDeviceVerifications(deps);
      return await deps.verificationManager.cancelVerification(id, params);
    },
    startVerification: async (id, method = "sas") => {
      trackInProgressToDeviceVerifications(deps);
      return await deps.verificationManager.startVerification(id, method);
    },
    generateVerificationQr: async (id) => {
      trackInProgressToDeviceVerifications(deps);
      return await deps.verificationManager.generateVerificationQr(id);
    },
    scanVerificationQr: async (id, qrDataBase64) => {
      trackInProgressToDeviceVerifications(deps);
      return await deps.verificationManager.scanVerificationQr(id, qrDataBase64);
    },
    confirmVerificationSas: async (id) => {
      trackInProgressToDeviceVerifications(deps);
      return await deps.verificationManager.confirmVerificationSas(id);
    },
    mismatchVerificationSas: async (id) => {
      trackInProgressToDeviceVerifications(deps);
      return deps.verificationManager.mismatchVerificationSas(id);
    },
    confirmVerificationReciprocateQr: async (id) => {
      trackInProgressToDeviceVerifications(deps);
      return deps.verificationManager.confirmVerificationReciprocateQr(id);
    },
    getVerificationSas: async (id) => {
      trackInProgressToDeviceVerifications(deps);
      return deps.verificationManager.getVerificationSas(id);
    },
  };
}
