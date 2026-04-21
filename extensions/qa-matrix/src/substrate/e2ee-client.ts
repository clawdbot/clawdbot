import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  EncryptedFile,
  MatrixDeviceVerificationStatus,
  MatrixClient,
  MatrixOwnDeviceDeleteResult,
  MatrixOwnDeviceInfo,
  MatrixRawEvent,
  MatrixRecoveryKeyVerificationResult,
  MatrixRoomKeyBackupResetResult,
  MatrixRoomKeyBackupRestoreResult,
  MatrixVerificationBootstrapResult,
  MatrixVerificationMethod,
  MatrixVerificationSummary,
  MessageEventContent,
} from "@openclaw/matrix/test-api.js";
import { buildMatrixQaMessageContent } from "./client.js";
import { findMatrixQaObservedEventMatch, normalizeMatrixQaObservedEvent } from "./events.js";
import type { MatrixQaObservedEvent } from "./events.js";
import type { MatrixQaRoomEventWaitResult } from "./sync.js";

type MatrixQaE2eeActorId = "driver" | "observer" | `driver-${string}`;

type MatrixQaE2eeRuntime = typeof import("@openclaw/matrix/test-api.js");

type MatrixQaE2eeClientParams = {
  accessToken: string;
  actorId: MatrixQaE2eeActorId;
  baseUrl: string;
  deviceId?: string;
  outputDir: string;
  password?: string;
  scenarioId: string;
  timeoutMs: number;
  userId: string;
};

const MATRIX_QA_E2EE_SYNC_FILTER = {
  room: {
    ephemeral: { not_types: ["m.receipt"] },
  },
};

export type MatrixQaE2eeScenarioClient = {
  acceptVerification(id: string): Promise<MatrixVerificationSummary>;
  bootstrapOwnDeviceVerification(params?: {
    forceResetCrossSigning?: boolean;
    recoveryKey?: string;
  }): Promise<MatrixVerificationBootstrapResult>;
  confirmVerificationReciprocateQr(id: string): Promise<MatrixVerificationSummary>;
  confirmVerificationSas(id: string): Promise<MatrixVerificationSummary>;
  deleteOwnDevices(deviceIds: string[]): Promise<MatrixOwnDeviceDeleteResult>;
  generateVerificationQr(id: string): Promise<{ qrDataBase64: string }>;
  getDeviceVerificationStatus(
    userId: string,
    deviceId: string,
  ): Promise<MatrixDeviceVerificationStatus>;
  getRecoveryKey(): Promise<{
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null>;
  listOwnDevices(): Promise<MatrixOwnDeviceInfo[]>;
  listVerifications(): Promise<MatrixVerificationSummary[]>;
  prime(): Promise<string | undefined>;
  requestVerification(params: {
    deviceId?: string;
    ownUser?: boolean;
    roomId?: string;
    userId?: string;
  }): Promise<MatrixVerificationSummary>;
  resetRoomKeyBackup(): Promise<MatrixRoomKeyBackupResetResult>;
  restoreRoomKeyBackup(params?: {
    recoveryKey?: string;
  }): Promise<MatrixRoomKeyBackupRestoreResult>;
  scanVerificationQr(id: string, qrDataBase64: string): Promise<MatrixVerificationSummary>;
  verifyWithRecoveryKey(rawRecoveryKey: string): Promise<MatrixRecoveryKeyVerificationResult>;
  sendTextMessage(opts: {
    body: string;
    mentionUserIds?: string[];
    replyToEventId?: string;
    roomId: string;
    threadRootEventId?: string;
  }): Promise<string>;
  sendNoticeMessage(opts: {
    body: string;
    mentionUserIds?: string[];
    roomId: string;
  }): Promise<string>;
  sendImageMessage(opts: {
    body: string;
    buffer: Buffer;
    contentType: string;
    fileName: string;
    mentionUserIds?: string[];
    roomId: string;
  }): Promise<string>;
  startVerification(
    id: string,
    method?: MatrixVerificationMethod,
  ): Promise<MatrixVerificationSummary>;
  stop(): Promise<void>;
  waitForOptionalRoomEvent(params: {
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    timeoutMs: number;
  }): Promise<MatrixQaRoomEventWaitResult>;
  waitForRoomEvent(params: {
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    timeoutMs: number;
  }): Promise<{
    event: MatrixQaObservedEvent;
    since?: string;
  }>;
};

async function loadMatrixQaE2eeRuntime(): Promise<MatrixQaE2eeRuntime> {
  const { loadQaRunnerBundledPluginTestApi } =
    await import("openclaw/plugin-sdk/qa-runner-runtime");
  return loadQaRunnerBundledPluginTestApi<MatrixQaE2eeRuntime>("matrix");
}

function buildMatrixQaE2eeStoragePaths(params: {
  actorId: MatrixQaE2eeActorId;
  outputDir: string;
  scenarioId: string;
}) {
  const rootDir = path.join(params.outputDir, "matrix-e2ee", "accounts", params.actorId);
  const accountDir = path.join(rootDir, "account");
  const scenarioKey = params.scenarioId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-80);
  const runKey = path
    .basename(params.outputDir)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(-80);
  const actorKey = params.actorId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-40);
  return {
    accountDir,
    cryptoDatabasePrefix: `qa-matrix-${runKey || "run"}-${actorKey || "actor"}`,
    idbSnapshotPath: path.join(accountDir, "crypto-idb-snapshot.json"),
    recoveryKeyPath: path.join(accountDir, "recovery-key.json"),
    rootDir,
    storagePath: path.join(rootDir, "scenarios", scenarioKey || "scenario", "sync-store.json"),
  };
}

async function prepareMatrixQaE2eeStorage(params: {
  actorId: MatrixQaE2eeActorId;
  outputDir: string;
  scenarioId: string;
}) {
  const storage = buildMatrixQaE2eeStoragePaths(params);
  await fs.mkdir(storage.rootDir, { recursive: true });
  await fs.mkdir(storage.accountDir, { recursive: true });
  await fs.mkdir(path.dirname(storage.storagePath), { recursive: true });
  await fs.writeFile(storage.idbSnapshotPath, "[]\n", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  });
  return storage;
}

async function createMatrixQaE2eeMatrixClient(params: MatrixQaE2eeClientParams) {
  const runtime = await loadMatrixQaE2eeRuntime();
  const storage = await prepareMatrixQaE2eeStorage({
    actorId: params.actorId,
    outputDir: params.outputDir,
    scenarioId: params.scenarioId,
  });
  return new runtime.MatrixClient(params.baseUrl, params.accessToken, {
    autoBootstrapCrypto: false,
    cryptoDatabasePrefix: storage.cryptoDatabasePrefix,
    deviceId: params.deviceId,
    encryption: true,
    idbSnapshotPath: storage.idbSnapshotPath,
    localTimeoutMs: Math.max(10_000, params.timeoutMs),
    password: params.password,
    recoveryKeyPath: storage.recoveryKeyPath,
    ssrfPolicy: { allowPrivateNetwork: true },
    storagePath: storage.storagePath,
    syncFilter: MATRIX_QA_E2EE_SYNC_FILTER,
    userId: params.userId,
  });
}

export async function createMatrixQaE2eeScenarioClient(
  params: MatrixQaE2eeClientParams & {
    observedEvents: MatrixQaObservedEvent[];
  },
): Promise<MatrixQaE2eeScenarioClient> {
  const client: MatrixClient = await createMatrixQaE2eeMatrixClient(params);
  const localEvents: MatrixQaObservedEvent[] = [];
  const verificationSummaries: MatrixVerificationSummary[] = [];
  const observedEventIds = new Set<string>();
  let cursorIndex = 0;

  const recordEvent = (roomId: string, event: MatrixRawEvent) => {
    const normalized = normalizeMatrixQaObservedEvent(roomId, event);
    if (!normalized || observedEventIds.has(normalized.eventId)) {
      return;
    }
    observedEventIds.add(normalized.eventId);
    localEvents.push(normalized);
    params.observedEvents.push(normalized);
  };
  client.on("room.message", recordEvent);
  const recordVerificationSummary = (summary: MatrixVerificationSummary) => {
    verificationSummaries.push(summary);
  };
  client.on("verification.summary", recordVerificationSummary);

  try {
    await client.start({ readyTimeoutMs: Math.min(45_000, Math.max(15_000, params.timeoutMs)) });
  } catch (error) {
    await client.stopAndPersist().catch(() => undefined);
    throw error;
  }

  const prime = async () => {
    cursorIndex = Math.max(cursorIndex, localEvents.length);
    return `e2ee:${cursorIndex}`;
  };
  const waitForOptionalRoomEvent: MatrixQaE2eeScenarioClient["waitForOptionalRoomEvent"] = async (
    waitParams,
  ) => {
    const startSince = `e2ee:${cursorIndex}`;
    const startedAt = Date.now();
    let scanIndex = cursorIndex;
    while (Date.now() - startedAt < waitParams.timeoutMs) {
      const matched = findMatrixQaObservedEventMatch({
        cursorIndex: scanIndex,
        events: localEvents,
        predicate: waitParams.predicate,
        roomId: waitParams.roomId,
      });
      if (matched) {
        cursorIndex = Math.max(cursorIndex, matched.nextCursorIndex);
        return {
          event: matched.event,
          matched: true,
          since: `e2ee:${cursorIndex}`,
        };
      }
      scanIndex = localEvents.length;
      await sleep(Math.min(250, Math.max(25, waitParams.timeoutMs - (Date.now() - startedAt))));
    }
    cursorIndex = Math.max(cursorIndex, scanIndex);
    return {
      matched: false,
      since: startSince,
    };
  };

  const requireCrypto = () => {
    if (!client.crypto) {
      throw new Error("Matrix E2EE scenario requires Matrix crypto");
    }
    return client.crypto;
  };

  return {
    async acceptVerification(id) {
      return await requireCrypto().acceptVerification(id);
    },
    async bootstrapOwnDeviceVerification(opts) {
      return await client.bootstrapOwnDeviceVerification(opts);
    },
    async confirmVerificationReciprocateQr(id) {
      return await requireCrypto().confirmVerificationReciprocateQr(id);
    },
    async confirmVerificationSas(id) {
      return await requireCrypto().confirmVerificationSas(id);
    },
    async deleteOwnDevices(deviceIds) {
      return await client.deleteOwnDevices(deviceIds);
    },
    async generateVerificationQr(id) {
      return await requireCrypto().generateVerificationQr(id);
    },
    async getDeviceVerificationStatus(userId, deviceId) {
      return await client.getDeviceVerificationStatus(userId, deviceId);
    },
    async getRecoveryKey() {
      return await requireCrypto().getRecoveryKey();
    },
    async listOwnDevices() {
      return await client.listOwnDevices();
    },
    async listVerifications() {
      const current = await requireCrypto().listVerifications();
      return [...verificationSummaries, ...current].toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    },
    prime,
    async requestVerification(opts) {
      return await requireCrypto().requestVerification(opts);
    },
    async resetRoomKeyBackup() {
      return await client.resetRoomKeyBackup();
    },
    async restoreRoomKeyBackup(opts) {
      return await client.restoreRoomKeyBackup(opts);
    },
    async scanVerificationQr(id, qrDataBase64) {
      return await requireCrypto().scanVerificationQr(id, qrDataBase64);
    },
    async sendTextMessage(opts) {
      return await client.sendMessage(
        opts.roomId,
        buildMatrixQaMessageContent(opts) as MessageEventContent,
      );
    },
    async sendNoticeMessage(opts) {
      return await client.sendMessage(opts.roomId, {
        ...buildMatrixQaMessageContent(opts),
        msgtype: "m.notice",
      } as MessageEventContent);
    },
    async sendImageMessage(opts) {
      const encrypted = await requireCrypto().encryptMedia(opts.buffer);
      const contentUri = await client.uploadContent(
        encrypted.buffer,
        opts.contentType,
        opts.fileName,
      );
      const file: EncryptedFile = { url: contentUri, ...encrypted.file };
      return await client.sendMessage(opts.roomId, {
        ...buildMatrixQaMessageContent({
          body: opts.body,
          mentionUserIds: opts.mentionUserIds,
        }),
        file,
        filename: opts.fileName,
        info: {
          mimetype: opts.contentType,
          size: opts.buffer.byteLength,
        },
        msgtype: "m.image",
      } as MessageEventContent);
    },
    async startVerification(id, method) {
      return await requireCrypto().startVerification(id, method);
    },
    async stop() {
      client.off("room.message", recordEvent);
      client.off("verification.summary", recordVerificationSummary);
      await client.drainPendingDecryptions().catch(() => undefined);
      await client.stopAndPersist();
    },
    waitForOptionalRoomEvent,
    async waitForRoomEvent(waitParams) {
      const result = await waitForOptionalRoomEvent(waitParams);
      if (result.matched) {
        return {
          event: result.event,
          since: result.since,
        };
      }
      throw new Error(`timed out after ${waitParams.timeoutMs}ms waiting for Matrix E2EE event`);
    },
    async verifyWithRecoveryKey(rawRecoveryKey) {
      return await client.verifyWithRecoveryKey(rawRecoveryKey);
    },
  };
}

export async function runMatrixQaE2eeBootstrap(
  params: MatrixQaE2eeClientParams,
): Promise<MatrixVerificationBootstrapResult> {
  const client: MatrixClient = await createMatrixQaE2eeMatrixClient(params);

  try {
    return await client.bootstrapOwnDeviceVerification();
  } finally {
    await client.stopAndPersist().catch(() => undefined);
  }
}

export const __testing = {
  MATRIX_QA_E2EE_SYNC_FILTER,
  buildMatrixQaE2eeStoragePaths,
  findMatrixQaObservedEventMatch,
};
