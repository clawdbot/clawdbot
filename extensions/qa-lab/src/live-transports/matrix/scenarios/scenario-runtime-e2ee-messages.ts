// Qa Matrix plugin module implements message scenario runtime E2EE behavior.
import { randomUUID } from "node:crypto";
import { startMatrixQaFaultProxy } from "../substrate/fault-proxy.js";
import {
  buildMatrixQaImageUnderstandingPrompt,
  createMatrixQaSplitColorImagePng,
  hasMatrixQaExpectedColorReply,
  MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
} from "./scenario-media-fixtures.js";
import {
  patchMatrixQaGatewayMatrixAccount,
  readMatrixQaGatewayMatrixAccount,
  replaceMatrixQaGatewayMatrixAccount,
} from "./scenario-runtime-config.js";
import {
  buildMatrixE2eeReplyArtifact,
  buildSyncStateAfterMissingEncryptionFaultRule,
  runMatrixQaE2eeTopLevelScenario,
  runMatrixQaE2eeTopLevelWithClient,
  withMatrixQaE2eeDriver,
  withMatrixQaIsolatedE2eeDriverRoom,
} from "./scenario-runtime-e2ee-room.js";
import {
  MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID,
  MATRIX_QA_SYNC_STATE_AFTER_PARAM,
  isMatrixQaE2eeNoticeTriggeredSutReply,
  requireMatrixQaGatewayConfigPath,
  resolveMatrixQaE2eeScenarioGroupRoom,
} from "./scenario-runtime-e2ee-shared.js";
import {
  assertThreadReplyArtifact,
  buildMatrixQaToken,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  isMatrixQaExactMarkerReply,
  resolveMatrixQaNoReplyWindowMs,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaReplyArtifact, MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeBasicReplyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const result = await runMatrixQaE2eeTopLevelScenario(context, {
    scenarioId: "matrix-e2ee-basic-reply",
    tokenPrefix: "MATRIX_QA_E2EE_BASIC",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      roomKey: result.roomKey,
      roomId: result.roomId,
    },
    details: [
      `encrypted room key: ${result.roomKey}`,
      `encrypted room id: ${result.roomId}`,
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("E2EE reply", result.reply),
    ].join("\n"),
  };
}

export async function runMatrixQaE2eeStateAfterMissingEncryptionScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error("Matrix E2EE state_after QA scenario requires hard gateway restart support");
  }
  const accountId = context.sutAccountId ?? "sut";
  const configPath = requireMatrixQaGatewayConfigPath(context);
  const originalAccountConfig = await readMatrixQaGatewayMatrixAccount({
    accountId,
    configPath,
  });
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: context.faultProxyTargetBaseUrl ?? context.baseUrl,
    ...context.faultProxyObserver,
    rules: [buildSyncStateAfterMissingEncryptionFaultRule(context.sutAccessToken)],
  });
  let gatewayPatched = false;
  try {
    await context.restartGatewayAfterStateMutation(
      async () => {
        await patchMatrixQaGatewayMatrixAccount({
          accountId,
          accountPatch: {
            homeserver: proxy.baseUrl,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
          },
          configPath,
        });
        gatewayPatched = true;
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
    const result = await runMatrixQaE2eeTopLevelScenario(context, {
      scenarioId: "matrix-e2ee-state-after-missing-encryption",
      tokenPrefix: "MATRIX_QA_E2EE_STATE_AFTER",
    });
    const stateAfterHits = proxy
      .hits()
      .filter((hit) => hit.ruleId === MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID);
    if (stateAfterHits.length > 0) {
      throw new Error(
        `Matrix E2EE gateway still sent ${MATRIX_QA_SYNC_STATE_AFTER_PARAM}=true on /sync`,
      );
    }
    return {
      artifacts: {
        driverEventId: result.driverEventId,
        faultProxyBaseUrl: proxy.baseUrl,
        reply: result.reply,
        roomKey: result.roomKey,
        roomId: result.roomId,
        stateAfterFaultHitCount: stateAfterHits.length,
        stateAfterFaultRuleId: MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID,
        strippedSyncStateAfterParam: true,
      },
      details: [
        `encrypted room key: ${result.roomKey}`,
        `encrypted room id: ${result.roomId}`,
        `driver event: ${result.driverEventId}`,
        `fault proxy: ${proxy.baseUrl}`,
        `state_after sync opt-in hits: ${stateAfterHits.length}`,
        ...buildMatrixReplyDetails("E2EE state_after reply", result.reply),
      ].join("\n"),
    };
  } finally {
    if (gatewayPatched) {
      await context
        .restartGatewayAfterStateMutation(
          async () => {
            await replaceMatrixQaGatewayMatrixAccount({
              accountConfig: originalAccountConfig,
              accountId,
              configPath,
            });
          },
          {
            timeoutMs: context.timeoutMs,
            waitAccountId: accountId,
          },
        )
        .catch(() => undefined);
    }
    await proxy.stop().catch(() => undefined);
  }
}

export async function runMatrixQaE2eeThreadFollowUpScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const { roomId, roomKey } = resolveMatrixQaE2eeScenarioGroupRoom(
    context,
    "matrix-e2ee-thread-follow-up",
  );
  const result = await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-thread-follow-up",
    async (client) => {
      await client.prime();
      const rootEventId = await client.sendTextMessage({
        body: `E2EE thread root ${randomUUID().slice(0, 8)}`,
        roomId,
      });
      const token = buildMatrixQaToken("MATRIX_QA_E2EE_THREAD");
      const driverEventId = await client.sendTextMessage({
        body: buildMentionPrompt(context.sutUserId, token),
        mentionUserIds: [context.sutUserId],
        replyToEventId: rootEventId,
        roomId,
        threadRootEventId: rootEventId,
      });
      const matched = await client.waitForRoomEvent({
        predicate: (event) =>
          isMatrixQaExactMarkerReply(event, {
            roomId,
            sutUserId: context.sutUserId,
            token,
          }) &&
          event.relatesTo?.relType === "m.thread" &&
          event.relatesTo.eventId === rootEventId,
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const reply = buildMatrixE2eeReplyArtifact(matched.event, token);
      assertThreadReplyArtifact(reply, {
        expectedRootEventId: rootEventId,
        label: "E2EE threaded reply",
      });
      return {
        driverEventId,
        reply,
        rootEventId,
        token,
      };
    },
  );
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      rootEventId: result.rootEventId,
      roomKey,
      roomId,
    },
    details: [
      `encrypted room key: ${roomKey}`,
      `encrypted room id: ${roomId}`,
      `thread root event: ${result.rootEventId}`,
      `mention trigger event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("E2EE threaded reply", result.reply),
    ].join("\n"),
  };
}

export async function runMatrixQaE2eeRestartResumeScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.restartGateway) {
    throw new Error("Matrix E2EE restart scenario requires gateway restart support");
  }
  const restartGateway = context.restartGateway;
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-restart-resume",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const first = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_E2EE_BEFORE_RESTART",
      });
      await restartGateway();
      const recovered = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_E2EE_AFTER_RESTART",
      });
      return {
        artifacts: {
          driverUserId,
          firstDriverEventId: first.driverEventId,
          firstReply: first.reply,
          recoveredDriverEventId: recovered.driverEventId,
          recoveredReply: recovered.reply,
          restartSignal: "gateway-restart",
          roomKey: recovered.roomKey,
          roomId: recovered.roomId,
        },
        details: [
          `encrypted room key: ${recovered.roomKey}`,
          `encrypted room id: ${recovered.roomId}`,
          `isolated driver user: ${driverUserId}`,
          `pre-restart event: ${first.driverEventId}`,
          ...buildMatrixReplyDetails("pre-restart reply", first.reply),
          `post-restart event: ${recovered.driverEventId}`,
          ...buildMatrixReplyDetails("post-restart reply", recovered.reply),
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeVerificationNoticeNoTriggerScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const { roomId, roomKey } = resolveMatrixQaE2eeScenarioGroupRoom(
    context,
    "matrix-e2ee-verification-notice-no-trigger",
  );
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-verification-notice-no-trigger",
    async (client) => {
      await client.prime();
      const token = buildMatrixQaToken("MATRIX_QA_E2EE_VERIFY_NOTICE");
      const body = `Matrix verification started with ${context.driverUserId}; ${buildMentionPrompt(
        context.sutUserId,
        token,
      )}`;
      const noticeSentAt = Date.now();
      const noticeEventId = await client.sendNoticeMessage({
        body,
        mentionUserIds: [context.sutUserId],
        roomId,
      });
      const result = await client.waitForOptionalRoomEvent({
        predicate: (event) =>
          isMatrixQaE2eeNoticeTriggeredSutReply({
            event,
            noticeEventId,
            noticeSentAt,
            roomId,
            sutUserId: context.sutUserId,
            token,
          }),
        roomId,
        timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
      });
      if (result.matched) {
        throw new Error(`unexpected E2EE verification-notice reply: ${result.event.eventId}`);
      }
      return {
        artifacts: {
          expectedNoReplyWindowMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
          noticeEventId,
          roomKey,
          roomId,
        },
        details: [
          `encrypted room key: ${roomKey}`,
          `encrypted room id: ${roomId}`,
          `verification notice event: ${noticeEventId}`,
          `waited ${resolveMatrixQaNoReplyWindowMs(context.timeoutMs)}ms with no SUT reply`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeArtifactRedactionScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-artifact-redaction",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const result = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_E2EE_REDACT",
      });
      const leaked = context.observedEvents.some(
        (event) =>
          event.roomId === result.roomId &&
          (event.body?.includes(result.token) || event.formattedBody?.includes(result.token)),
      );
      if (!leaked) {
        throw new Error(
          "Matrix E2EE redaction scenario did not observe decrypted content in memory",
        );
      }
      return {
        artifacts: {
          driverEventId: result.driverEventId,
          driverUserId,
          reply: result.reply,
          roomKey: result.roomKey,
          roomId: result.roomId,
        },
        details: [
          "decrypted E2EE payload reached in-memory assertions only",
          "observed-event artifacts redact body/formatted_body unless OPENCLAW_QA_MATRIX_CAPTURE_CONTENT=1",
          `encrypted room id: ${result.roomId}`,
          `isolated driver user: ${driverUserId}`,
          ...buildMatrixReplyDetails("E2EE reply", result.reply),
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeMediaImageScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-media-image",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const startSince = await client.prime();
      const triggerBody = buildMatrixQaImageUnderstandingPrompt(context.sutUserId);
      const driverEventId = await client.sendImageMessage({
        body: triggerBody,
        buffer: createMatrixQaSplitColorImagePng(),
        contentType: "image/png",
        fileName: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
        mentionUserIds: [context.sutUserId],
        roomId,
      });
      const attachmentEvent = await client.waitForRoomEvent({
        predicate: (event) =>
          event.roomId === roomId &&
          event.eventId === driverEventId &&
          event.sender === driverUserId &&
          event.attachment?.kind === "image" &&
          event.attachment.caption === triggerBody,
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const matched = await client.waitForRoomEvent({
        predicate: (event) =>
          event.roomId === roomId &&
          event.sender === context.sutUserId &&
          event.type === "m.room.message" &&
          event.relatesTo === undefined &&
          hasMatrixQaExpectedColorReply(event.body),
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const reply: MatrixQaReplyArtifact = {
        eventId: matched.event.eventId,
        mentions: matched.event.mentions,
        relatesTo: matched.event.relatesTo,
        sender: matched.event.sender,
      };
      return {
        artifacts: {
          attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
          driverEventId,
          driverUserId,
          reply,
          roomKey,
          roomId,
        },
        details: [
          `encrypted room key: ${roomKey}`,
          `encrypted room id: ${roomId}`,
          `isolated driver user: ${driverUserId}`,
          `driver encrypted image event: ${driverEventId}`,
          `driver encrypted image filename: ${MATRIX_QA_IMAGE_ATTACHMENT_FILENAME}`,
          `driver encrypted image since: ${attachmentEvent.since ?? startSince ?? "<none>"}`,
          ...buildMatrixReplyDetails("E2EE image reply", reply),
        ].join("\n"),
      };
    },
  );
}
