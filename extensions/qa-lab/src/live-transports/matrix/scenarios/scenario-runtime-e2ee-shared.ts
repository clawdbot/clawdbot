// Qa Matrix plugin module implements shared scenario runtime E2EE behavior.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { createMatrixQaClient } from "../substrate/client.js";
import {
  createMatrixQaE2eeScenarioClient,
  runMatrixQaE2eeBootstrap,
} from "../substrate/e2ee-client.js";
import type { MatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  buildMatrixQaE2eeScenarioRoomKey,
  type MatrixQaE2eeScenarioId,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export const MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT = "/_matrix/client/v3/room_keys/version";
export const MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID = "room-key-backup-version-unavailable";
export const MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID = "owner-signature-upload-blocked";
export const MATRIX_QA_KEYS_SIGNATURES_UPLOAD_ENDPOINT =
  "/_matrix/client/v3/keys/signatures/upload";
export const MATRIX_QA_SYNC_ENDPOINT = "/_matrix/client/v3/sync";
export const MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID = "sync-state-after-missing-encryption";
export const MATRIX_QA_SYNC_STATE_AFTER_KEY = "org.matrix.msc4222.state_after";
export const MATRIX_QA_SYNC_STATE_AFTER_PARAM = "org.matrix.msc4222.use_state_after";

type MatrixQaE2eeBootstrapResult = Awaited<ReturnType<typeof runMatrixQaE2eeBootstrap>>;

export function requireMatrixQaE2eeOutputDir(context: MatrixQaScenarioContext) {
  if (!context.outputDir) {
    throw new Error("Matrix E2EE QA scenarios require an output directory");
  }
  return context.outputDir;
}

export function requireMatrixQaCliRuntimeEnv(context: MatrixQaScenarioContext) {
  if (!context.gatewayRuntimeEnv) {
    throw new Error("Matrix CLI QA scenarios require the gateway runtime environment");
  }
  return context.gatewayRuntimeEnv;
}

export function requireMatrixQaGatewayConfigPath(context: MatrixQaScenarioContext) {
  const configPath = requireMatrixQaCliRuntimeEnv(context).OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    throw new Error("Matrix CLI QA scenarios require the gateway config path");
  }
  return configPath;
}

export function requireMatrixQaRegistrationToken(context: MatrixQaScenarioContext) {
  const token = context.registrationToken?.trim();
  if (!token) {
    throw new Error("Matrix CLI QA scenarios require the homeserver registration token");
  }
  return token;
}

export function requireMatrixQaPassword(
  context: MatrixQaScenarioContext,
  actor: "driver" | "observer" | "sut",
) {
  const password =
    actor === "driver"
      ? context.driverPassword
      : actor === "observer"
        ? context.observerPassword
        : context.sutPassword;
  if (!password) {
    throw new Error(`Matrix E2EE ${actor} password is required for this scenario`);
  }
  return password;
}

export function resolveMatrixQaE2eeScenarioGroupRoom(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
) {
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  return {
    roomKey,
    roomId: resolveMatrixQaScenarioRoomId(context, roomKey),
  };
}

export async function registerMatrixQaE2eeScenarioAccount(params: {
  context: MatrixQaScenarioContext;
  deviceName: string;
  localpartPrefix: string;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  const localpartSuffix = params.scenarioId
    .replace(/^matrix-e2ee-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const account = await createMatrixQaClient({
    baseUrl: params.context.baseUrl,
  }).registerWithToken({
    deviceName: params.deviceName,
    localpart: `${params.localpartPrefix}-${localpartSuffix}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    password: `matrix-qa-${randomUUID()}`,
    registrationToken: requireMatrixQaRegistrationToken(params.context),
  });
  if (!account.deviceId) {
    throw new Error(
      `Matrix E2EE QA registration for ${params.scenarioId} did not return a device id`,
    );
  }
  return account;
}

export function assertMatrixQaBootstrapSucceeded(
  label: string,
  result: MatrixQaE2eeBootstrapResult,
) {
  if (!result.success) {
    throw new Error(`${label} bootstrap failed: ${result.error ?? "unknown error"}`);
  }
  if (!result.verification.verified || !result.verification.signedByOwner) {
    throw new Error(`${label} bootstrap did not leave the device verified by its owner`);
  }
  if (!result.verification.crossSigningVerified) {
    throw new Error(`${label} bootstrap did not establish full Matrix identity trust`);
  }
  if (!result.crossSigning.published) {
    throw new Error(`${label} bootstrap did not publish cross-signing keys`);
  }
  if (!result.verification.recoveryKeyStored) {
    throw new Error(`${label} bootstrap did not store a recovery key`);
  }
  if (!result.verification.backupVersion) {
    throw new Error(`${label} bootstrap did not create a room-key backup`);
  }
}

function isMatrixQaRepairableBackupBootstrapError(error: string | undefined) {
  const normalized = error?.toLowerCase() ?? "";
  return (
    normalized.includes("room key backup is not usable") ||
    normalized.includes("m.megolm_backup.v1") ||
    normalized.includes("backup decryption key could not be loaded")
  );
}

const MATRIX_QA_PRESERVE_IDENTITY_BOOTSTRAP_OPTIONS = {
  allowAutomaticCrossSigningReset: false,
} as const;

export async function assertMatrixQaPeerDeviceTrusted(params: {
  client: MatrixQaE2eeScenarioClient;
  deviceId: string;
  label: string;
  timeoutMs: number;
  userId: string;
}) {
  const startedAt = Date.now();
  let status = await params.client.getDeviceVerificationStatus(params.userId, params.deviceId);
  while (!status.verified && Date.now() - startedAt < params.timeoutMs) {
    await sleep(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
    status = await params.client.getDeviceVerificationStatus(params.userId, params.deviceId);
  }
  if (!status.verified) {
    throw new Error(
      `${params.label} did not trust ${params.userId}/${params.deviceId} after verification`,
    );
  }
  return status;
}

export async function ensureMatrixQaE2eeOwnDeviceVerified(params: {
  client: MatrixQaE2eeScenarioClient;
  label: string;
}) {
  let bootstrap = await params.client.bootstrapOwnDeviceVerification(
    MATRIX_QA_PRESERVE_IDENTITY_BOOTSTRAP_OPTIONS,
  );
  if (!bootstrap.success && isMatrixQaRepairableBackupBootstrapError(bootstrap.error)) {
    const reset = await params.client.resetRoomKeyBackup();
    if (reset.success) {
      bootstrap = await params.client.bootstrapOwnDeviceVerification(
        MATRIX_QA_PRESERVE_IDENTITY_BOOTSTRAP_OPTIONS,
      );
    }
  }
  assertMatrixQaBootstrapSucceeded(params.label, bootstrap);
  return {
    bootstrap,
    recoveryKey: await params.client.getRecoveryKey(),
    verification: bootstrap.verification,
  };
}

export async function waitForMatrixQaNonEmptyRoomKeyRestore(params: {
  client: MatrixQaE2eeScenarioClient;
  recoveryKey: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<MatrixQaE2eeScenarioClient["restoreRoomKeyBackup"]>> | null = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    const restored = await params.client.restoreRoomKeyBackup({
      recoveryKey: params.recoveryKey,
    });
    last = restored;
    if (!restored.success) {
      throw new Error(
        `Matrix E2EE room-key backup restore failed: ${restored.error ?? "unknown error"}`,
      );
    }
    if (restored.total > 0 && restored.imported > 0) {
      return restored;
    }
    await sleep(500);
  }
  throw new Error(
    `Matrix E2EE room-key backup restore did not import any keys before timeout (last imported/total: ${last?.imported ?? 0}/${last?.total ?? 0})`,
  );
}

export async function waitForMatrixQaVerificationSummary(params: {
  client: MatrixQaE2eeScenarioClient;
  label: string;
  predicate: (summary: MatrixVerificationSummary) => boolean;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const summaries = await params.client.listVerifications();
    const found = summaries.find(params.predicate);
    if (found) {
      return found;
    }
    await sleep(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
  }
  throw new Error(`timed out waiting for Matrix verification summary: ${params.label}`);
}

export function sameMatrixQaVerificationTransaction(
  left: MatrixVerificationSummary,
  right: MatrixVerificationSummary,
) {
  return Boolean(left.transactionId && left.transactionId === right.transactionId);
}

export function formatMatrixQaSasEmoji(summary: MatrixVerificationSummary) {
  return summary.sas?.emoji?.map(([emoji, label]) => `${emoji} ${label}`) ?? [];
}

function assertMatrixQaSasEmojiMatches(params: {
  initiator: MatrixVerificationSummary;
  recipient: MatrixVerificationSummary;
}) {
  const initiatorEmoji = formatMatrixQaSasEmoji(params.initiator);
  const recipientEmoji = formatMatrixQaSasEmoji(params.recipient);
  if (initiatorEmoji.length === 0 || recipientEmoji.length === 0) {
    throw new Error("Matrix SAS verification did not expose emoji data on both devices");
  }
  if (JSON.stringify(initiatorEmoji) !== JSON.stringify(recipientEmoji)) {
    throw new Error("Matrix SAS emoji did not match between verification devices");
  }
  return initiatorEmoji;
}

export function isMatrixQaE2eeNoticeTriggeredSutReply(params: {
  event: MatrixQaObservedEvent;
  noticeEventId: string;
  noticeSentAt: number;
  roomId: string;
  sutUserId: string;
  token: string;
}) {
  if (
    params.event.roomId !== params.roomId ||
    params.event.sender !== params.sutUserId ||
    params.event.type !== "m.room.message"
  ) {
    return false;
  }
  if (params.event.body?.includes(params.token)) {
    return true;
  }
  if (
    params.event.relatesTo?.eventId === params.noticeEventId ||
    params.event.relatesTo?.inReplyToId === params.noticeEventId
  ) {
    return true;
  }
  return (
    typeof params.event.originServerTs === "number" &&
    params.event.originServerTs >= params.noticeSentAt
  );
}

export async function createMatrixQaE2eeDriverClient(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  opts: { actorId?: "driver" | `driver-${string}` } = {},
) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: context.driverAccessToken,
    actorId: opts.actorId ?? "driver",
    baseUrl: context.baseUrl,
    deviceId: context.driverDeviceId,
    observedEvents: context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(context),
    password: context.driverPassword,
    scenarioId,
    timeoutMs: context.timeoutMs,
    userId: context.driverUserId,
  });
}

async function createMatrixQaE2eeObserverClient(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    baseUrl: context.baseUrl,
    deviceId: context.observerDeviceId,
    observedEvents: context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(context),
    password: context.observerPassword,
    scenarioId,
    timeoutMs: context.timeoutMs,
    userId: context.observerUserId,
  });
}

export async function withMatrixQaE2eeDriverAndObserver<T>(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  run: (clients: {
    driver: MatrixQaE2eeScenarioClient;
    observer: MatrixQaE2eeScenarioClient;
  }) => Promise<T>,
) {
  const driver = await createMatrixQaE2eeDriverClient(context, scenarioId);
  const observer = await createMatrixQaE2eeObserverClient(context, scenarioId);
  try {
    return await run({ driver, observer });
  } finally {
    await Promise.all([driver.stop(), observer.stop()]);
  }
}

export async function completeMatrixQaSasVerification(params: {
  initiator: MatrixQaE2eeScenarioClient;
  recipient: MatrixQaE2eeScenarioClient;
  recipientUserId: string;
  request: {
    deviceId?: string;
    roomId?: string;
    userId: string;
  };
  timeoutMs: number;
}) {
  const initiated = await params.initiator.requestVerification(params.request);
  const recipientRequested = await waitForMatrixQaVerificationSummary({
    client: params.recipient,
    label: "recipient request",
    predicate: (summary) =>
      !summary.initiatedByMe &&
      (sameMatrixQaVerificationTransaction(summary, initiated) ||
        (summary.otherUserId !== params.recipientUserId && summary.pending)),
    timeoutMs: params.timeoutMs,
  });
  if (recipientRequested.canAccept) {
    await params.recipient.acceptVerification(recipientRequested.id);
  }
  await waitForMatrixQaVerificationSummary({
    client: params.initiator,
    label: "initiator ready",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiated) && summary.phaseName === "ready",
    timeoutMs: params.timeoutMs,
  });
  await params.initiator.startVerification(initiated.id, "sas");
  const initiatorSas = await waitForMatrixQaVerificationSummary({
    client: params.initiator,
    label: "initiator SAS",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiated) && summary.hasSas,
    timeoutMs: params.timeoutMs,
  });
  const recipientSas = await waitForMatrixQaVerificationSummary({
    client: params.recipient,
    label: "recipient SAS",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiatorSas) && summary.hasSas,
    timeoutMs: params.timeoutMs,
  });
  const sasEmoji = assertMatrixQaSasEmojiMatches({
    initiator: initiatorSas,
    recipient: recipientSas,
  });
  await params.initiator.confirmVerificationSas(initiatorSas.id);
  await params.recipient.confirmVerificationSas(recipientSas.id);
  const completedInitiator = await waitForMatrixQaVerificationSummary({
    client: params.initiator,
    label: "initiator complete",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiated) && summary.completed,
    timeoutMs: params.timeoutMs,
  });
  const completedRecipient = await waitForMatrixQaVerificationSummary({
    client: params.recipient,
    label: "recipient complete",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, completedInitiator) && summary.completed,
    timeoutMs: params.timeoutMs,
  });
  return {
    completedInitiator,
    completedRecipient,
    sasEmoji,
  };
}
