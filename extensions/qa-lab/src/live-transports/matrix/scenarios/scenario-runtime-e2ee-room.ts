// Qa Matrix plugin module implements room and fault scenario runtime E2EE behavior.
import { randomUUID } from "node:crypto";
import { createMatrixQaClient } from "../substrate/client.js";
import {
  createMatrixQaE2eeScenarioClient,
  runMatrixQaE2eeBootstrap,
} from "../substrate/e2ee-client.js";
import type { MatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  startMatrixQaFaultProxy,
  type MatrixQaFaultProxyHit,
  type MatrixQaFaultProxyRule,
} from "../substrate/fault-proxy.js";
import {
  buildMatrixQaE2eeScenarioRoomKey,
  type MatrixQaE2eeScenarioId,
} from "./scenario-contract.js";
import {
  isMatrixQaPlainRecord,
  patchMatrixQaGatewayMatrixAccount,
  readMatrixQaGatewayMatrixAccount,
} from "./scenario-runtime-config.js";
import {
  MATRIX_QA_KEYS_SIGNATURES_UPLOAD_ENDPOINT,
  MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID,
  MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID,
  MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT,
  MATRIX_QA_SYNC_ENDPOINT,
  MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID,
  MATRIX_QA_SYNC_STATE_AFTER_KEY,
  MATRIX_QA_SYNC_STATE_AFTER_PARAM,
  createMatrixQaE2eeDriverClient,
  requireMatrixQaE2eeOutputDir,
  requireMatrixQaGatewayConfigPath,
  registerMatrixQaE2eeScenarioAccount,
  resolveMatrixQaE2eeScenarioGroupRoom,
  waitForMatrixQaNonEmptyRoomKeyRestore,
} from "./scenario-runtime-e2ee-shared.js";
import {
  assertTopLevelReplyArtifact,
  buildMatrixQaToken,
  buildMentionPrompt,
  doesMatrixQaReplyBodyMatchToken,
  isMatrixQaExactMarkerReply,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaReplyArtifact } from "./scenario-types.js";

type MatrixQaE2eeBootstrapResult = Awaited<ReturnType<typeof runMatrixQaE2eeBootstrap>>;

export function buildMatrixE2eeReplyArtifact(
  event: MatrixQaObservedEvent,
  token: string,
): MatrixQaReplyArtifact {
  return {
    eventId: event.eventId,
    mentions: event.mentions,
    relatesTo: event.relatesTo,
    sender: event.sender,
    tokenMatched: doesMatrixQaReplyBodyMatchToken(event, token),
  };
}

export function buildRoomKeyBackupUnavailableFaultRule(
  accessToken: string,
): MatrixQaFaultProxyRule {
  return {
    id: MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID,
    match: (request) =>
      request.method === "GET" &&
      request.path === MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT &&
      request.bearerToken === accessToken,
    response: () => ({
      body: {
        errcode: "M_NOT_FOUND",
        error: "No current key backup",
      },
      status: 404,
    }),
  };
}

function buildOwnerSignatureUploadBlockedFaultRule(accessToken: string): MatrixQaFaultProxyRule {
  return {
    id: MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID,
    match: (request) =>
      request.method === "POST" &&
      request.path === MATRIX_QA_KEYS_SIGNATURES_UPLOAD_ENDPOINT &&
      request.bearerToken === accessToken,
    response: () => ({
      body: {},
      status: 200,
    }),
  };
}

function removeMatrixQaSyncStateAfterEncryptionEvents(payload: unknown) {
  if (!isMatrixQaPlainRecord(payload)) {
    return 0;
  }
  const rooms = isMatrixQaPlainRecord(payload.rooms) ? payload.rooms : {};
  const join = isMatrixQaPlainRecord(rooms.join) ? rooms.join : {};
  let removed = 0;
  for (const room of Object.values(join)) {
    if (!isMatrixQaPlainRecord(room)) {
      continue;
    }
    const stateAfter = room[MATRIX_QA_SYNC_STATE_AFTER_KEY];
    if (!isMatrixQaPlainRecord(stateAfter) || !Array.isArray(stateAfter.events)) {
      continue;
    }
    const filtered = stateAfter.events.filter((event) => {
      if (isMatrixQaPlainRecord(event) && event.type === "m.room.encryption") {
        removed += 1;
        return false;
      }
      return true;
    });
    stateAfter.events = filtered;
  }
  return removed;
}

export function buildSyncStateAfterMissingEncryptionFaultRule(
  accessToken: string,
): MatrixQaFaultProxyRule {
  return {
    id: MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID,
    match: (request) =>
      request.method === "GET" &&
      request.path === MATRIX_QA_SYNC_ENDPOINT &&
      request.bearerToken === accessToken &&
      new URLSearchParams(request.search).get(MATRIX_QA_SYNC_STATE_AFTER_PARAM) === "true",
    mutateResponse: ({ response }) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        return response;
      }
      const payload = JSON.parse(response.body.toString("utf8")) as unknown;
      removeMatrixQaSyncStateAfterEncryptionEvents(payload);
      return {
        ...response,
        body: Buffer.from(JSON.stringify(payload)),
      };
    },
  };
}

export async function runMatrixQaFaultedE2eeBootstrap(context: MatrixQaScenarioContext): Promise<{
  faultHits: MatrixQaFaultProxyHit[];
  result: MatrixQaE2eeBootstrapResult;
}> {
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: context.faultProxyTargetBaseUrl ?? context.baseUrl,
    ...context.faultProxyObserver,
    rules: [buildRoomKeyBackupUnavailableFaultRule(context.driverAccessToken)],
  });
  try {
    const result = await runMatrixQaE2eeBootstrap({
      accessToken: context.driverAccessToken,
      actorId: "driver",
      baseUrl: proxy.baseUrl,
      deviceId: context.driverDeviceId,
      outputDir: requireMatrixQaE2eeOutputDir(context),
      ...(context.driverPassword ? { password: context.driverPassword } : {}),
      scenarioId: "matrix-e2ee-key-bootstrap-failure",
      timeoutMs: context.timeoutMs,
      userId: context.driverUserId,
    });
    return {
      faultHits: proxy.hits(),
      result,
    };
  } finally {
    await proxy.stop();
  }
}

export async function runMatrixQaFaultedRecoveryOwnerVerification(params: {
  accessToken: string;
  context: MatrixQaScenarioContext;
  deviceId: string;
  encodedRecoveryKey: string;
  userId: string;
}): Promise<{
  faultHits: MatrixQaFaultProxyHit[];
  restore: Awaited<ReturnType<MatrixQaE2eeScenarioClient["restoreRoomKeyBackup"]>>;
  verification: Awaited<ReturnType<MatrixQaE2eeScenarioClient["verifyWithRecoveryKey"]>>;
}> {
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: params.context.faultProxyTargetBaseUrl ?? params.context.baseUrl,
    ...params.context.faultProxyObserver,
    rules: [buildOwnerSignatureUploadBlockedFaultRule(params.accessToken)],
  });
  const recoveryClient = await createMatrixQaE2eeScenarioClient({
    accessToken: params.accessToken,
    actorId: `driver-recovery-${randomUUID().slice(0, 8)}`,
    baseUrl: proxy.baseUrl,
    deviceId: params.deviceId,
    observedEvents: params.context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    scenarioId: "matrix-e2ee-recovery-owner-verification-required",
    timeoutMs: params.context.timeoutMs,
    userId: params.userId,
  });
  try {
    const verification = await recoveryClient.verifyWithRecoveryKey(params.encodedRecoveryKey);
    const restore = await waitForMatrixQaNonEmptyRoomKeyRestore({
      client: recoveryClient,
      recoveryKey: params.encodedRecoveryKey,
      timeoutMs: params.context.timeoutMs,
    });
    return {
      faultHits: proxy.hits(),
      restore,
      verification,
    };
  } finally {
    await recoveryClient.stop().catch(() => undefined);
    await proxy.stop();
  }
}

export function assertMatrixQaFaultedRecoveryOwnerVerificationRequired(
  faulted: Awaited<ReturnType<typeof runMatrixQaFaultedRecoveryOwnerVerification>>,
) {
  if (faulted.faultHits.length === 0) {
    throw new Error("Matrix E2EE owner signature fault proxy was not exercised");
  }
  if (faulted.verification.success) {
    throw new Error(
      "Matrix E2EE recovery verification unexpectedly succeeded while owner signature upload was blocked",
    );
  }
  if (!faulted.verification.recoveryKeyAccepted) {
    throw new Error("Matrix E2EE recovery key was not accepted");
  }
  if (!faulted.verification.backupUsable) {
    throw new Error("Matrix E2EE recovery key did not leave room-key backup usable");
  }
  if (faulted.verification.deviceOwnerVerified) {
    throw new Error("Matrix E2EE recovery device should still require Matrix identity trust");
  }
  if (!faulted.restore.success) {
    throw new Error(
      `Matrix E2EE room-key backup restore failed after owner-verification fault: ${faulted.restore.error ?? "unknown error"}`,
    );
  }
}

export function assertMatrixQaExpectedBootstrapFailure(params: {
  faultHits: MatrixQaFaultProxyHit[];
  result: MatrixQaE2eeBootstrapResult;
}) {
  if (params.faultHits.length === 0) {
    throw new Error("Matrix E2EE bootstrap fault proxy was not exercised");
  }
  if (params.result.success) {
    throw new Error(
      "Matrix E2EE bootstrap unexpectedly succeeded while room-key backup was faulted",
    );
  }
  const bootstrapError = params.result.error ?? "";
  if (!bootstrapError.toLowerCase().includes("room key backup")) {
    throw new Error(`Matrix E2EE bootstrap failed for an unexpected reason: ${bootstrapError}`);
  }
  return bootstrapError;
}

export async function withMatrixQaE2eeDriver<T>(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  run: (client: MatrixQaE2eeScenarioClient) => Promise<T>,
  opts: { actorId?: "driver" | `driver-${string}` } = {},
) {
  const client = await createMatrixQaE2eeDriverClient(context, scenarioId, opts);
  try {
    return await run(client);
  } finally {
    await client.stop();
  }
}

async function createMatrixQaE2eeRegisteredScenarioClient(params: {
  account: Awaited<ReturnType<typeof registerMatrixQaE2eeScenarioAccount>>;
  actorId: `driver-${string}`;
  context: MatrixQaScenarioContext;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: params.account.accessToken,
    actorId: params.actorId,
    baseUrl: params.context.baseUrl,
    deviceId: params.account.deviceId,
    observedEvents: params.context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    password: params.account.password,
    scenarioId: params.scenarioId,
    timeoutMs: params.context.timeoutMs,
    userId: params.account.userId,
  });
}

export async function withMatrixQaIsolatedE2eeDriverRoom<T>(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  run: (params: {
    client: MatrixQaE2eeScenarioClient;
    driverUserId: string;
    roomId: string;
    roomKey: string;
  }) => Promise<T>,
) {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error(
      "Matrix E2EE isolated driver room scenario requires hard gateway restart support",
    );
  }
  const accountId = context.sutAccountId ?? "sut";
  const configPath = requireMatrixQaGatewayConfigPath(context);
  const accountConfig = await readMatrixQaGatewayMatrixAccount({
    accountId,
    configPath,
  });
  const originalGroups = isMatrixQaPlainRecord(accountConfig.groups) ? accountConfig.groups : {};
  const originalGroupAllowFrom = Array.isArray(accountConfig.groupAllowFrom)
    ? accountConfig.groupAllowFrom
    : undefined;
  const originalGroupPolicy = accountConfig.groupPolicy;
  const driverAccount = await registerMatrixQaE2eeScenarioAccount({
    context,
    deviceName: "OpenClaw Matrix QA Isolated E2EE Driver",
    localpartPrefix: "qa-e2ee-driver",
    scenarioId,
  });
  const driverApi = createMatrixQaClient({
    accessToken: driverAccount.accessToken,
    baseUrl: context.baseUrl,
  });
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  const roomId = await driverApi.createPrivateRoom({
    encrypted: true,
    inviteUserIds: [context.observerUserId, context.sutUserId],
    name: `Matrix QA ${scenarioId} Isolated E2EE Room`,
  });
  await Promise.all([
    createMatrixQaClient({
      accessToken: context.observerAccessToken,
      baseUrl: context.baseUrl,
    }).joinRoom(roomId),
    createMatrixQaClient({
      accessToken: context.sutAccessToken,
      baseUrl: context.baseUrl,
    }).joinRoom(roomId),
  ]);

  const isolatedGroups = {
    [roomId]: {
      enabled: true,
      requireMention: true,
    },
  };
  const applyPatch = async (accountPatch: Record<string, unknown>) => {
    await context.restartGatewayAfterStateMutation?.(
      async () => {
        await patchMatrixQaGatewayMatrixAccount({
          accountId,
          accountPatch,
          configPath,
        });
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
  };

  let patchedGateway;
  let client: MatrixQaE2eeScenarioClient | undefined;
  try {
    await applyPatch({
      groupAllowFrom: [driverAccount.userId],
      groupPolicy: "allowlist",
      groups: isolatedGroups,
    });
    patchedGateway = true;
    const actorId: `driver-${string}` = `driver-${scenarioId
      .replace(/^matrix-e2ee-/, "")
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 28)}`;
    client = await createMatrixQaE2eeRegisteredScenarioClient({
      account: driverAccount,
      actorId,
      context,
      scenarioId,
    });
    await Promise.all([
      client.waitForJoinedMember({
        roomId,
        timeoutMs: context.timeoutMs,
        userId: context.sutUserId,
      }),
      client.waitForJoinedMember({
        roomId,
        timeoutMs: context.timeoutMs,
        userId: context.observerUserId,
      }),
    ]);
    return await run({
      client,
      driverUserId: driverAccount.userId,
      roomId,
      roomKey,
    });
  } finally {
    await client?.stop().catch(() => undefined);
    if (patchedGateway) {
      const restorePatch: Record<string, unknown> = {
        groupAllowFrom: originalGroupAllowFrom,
        groupPolicy: originalGroupPolicy,
        groups: originalGroups,
      };
      await applyPatch(restorePatch).catch(() => undefined);
    }
  }
}

export async function runMatrixQaE2eeTopLevelWithClient(
  context: MatrixQaScenarioContext,
  params: {
    client: MatrixQaE2eeScenarioClient;
    driverUserId: string;
    roomId: string;
    roomKey: string;
    tokenPrefix: string;
  },
) {
  const startSince = await params.client.prime();
  const token = buildMatrixQaToken(params.tokenPrefix);
  const body = buildMentionPrompt(context.sutUserId, token);
  const driverEventId = await params.client.sendTextMessage({
    body,
    mentionUserIds: [context.sutUserId],
    roomId: params.roomId,
  });
  const matched = await params.client.waitForRoomEvent({
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: params.roomId,
        sutUserId: context.sutUserId,
        token,
      }) && event.relatesTo === undefined,
    roomId: params.roomId,
    timeoutMs: context.timeoutMs,
  });
  const reply = buildMatrixE2eeReplyArtifact(matched.event, token);
  assertTopLevelReplyArtifact("E2EE reply", reply);
  return {
    driverEventId,
    driverUserId: params.driverUserId,
    reply,
    roomId: params.roomId,
    roomKey: params.roomKey,
    since: matched.since ?? startSince,
    token,
  };
}

export async function runMatrixQaE2eeTopLevelScenario(
  context: MatrixQaScenarioContext,
  params: {
    scenarioId: MatrixQaE2eeScenarioId;
    tokenPrefix: string;
  },
) {
  const { roomId, roomKey } = resolveMatrixQaE2eeScenarioGroupRoom(context, params.scenarioId);
  return await withMatrixQaE2eeDriver(context, params.scenarioId, async (client) => {
    return await runMatrixQaE2eeTopLevelWithClient(context, {
      client,
      driverUserId: context.driverUserId,
      roomId,
      roomKey,
      tokenPrefix: params.tokenPrefix,
    });
  });
}
