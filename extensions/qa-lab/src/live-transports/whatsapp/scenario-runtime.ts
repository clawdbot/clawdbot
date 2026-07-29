import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import type { WhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import { runWhatsAppApprovalScenario } from "./whatsapp-live.approvals.js";
import {
  buildWhatsAppQaScenarioResultBase,
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaScenarioTarget,
  type WhatsAppObservedMessage,
  type WhatsAppQaMessageScenarioContext,
  type WhatsAppQaScenarioImplementation,
  type WhatsAppQaScenarioMetadata,
  type WhatsAppQaScenarioResult,
  type WhatsAppQaScenarioRun,
} from "./whatsapp-live.contracts.js";
import {
  WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS,
  assertWhatsAppScenarioMessageBatch,
  isTransientWhatsAppQaDriverError,
  messageMatches,
  resolveWhatsAppQaNoReplyTarget,
  restartWhatsAppQaDriverSession,
  waitForNoWhatsAppReply,
  waitForWhatsAppScenarioSutMessage,
} from "./whatsapp-live.operations.js";
import {
  whatsappQaGroupAudioGatingScenario,
  whatsappQaGroupOutboundAudioScenario,
  whatsappQaGroupOutboundMediaScenario,
  whatsappQaGroupOutboundPollScenario,
  whatsappQaInboundStructuredMessagesScenario,
  whatsappQaMessageActionsScenario,
  whatsappQaOutboundDocumentPreservesFilenameScenario,
  whatsappQaOutboundPollScenario,
  whatsappQaOutboundSendSerializationScenario,
} from "./whatsapp-live.scenario-implementations.capabilities.js";
import {
  whatsappQaBroadcastGroupFanoutScenario,
  whatsappQaCanaryScenario,
  whatsappQaGroupActivationAlwaysScenario,
  whatsappQaGroupPendingHistoryContextScenario,
  whatsappQaGroupReplyToBotTriggersScenario,
  whatsappQaGroupReplyToMessageScenario,
  whatsappQaMentionGatingScenario,
  whatsappQaReplyToMessageScenario,
  whatsappQaReplyToModeBatchedScenario,
  whatsappQaTopLevelReplyShapeScenario,
} from "./whatsapp-live.scenario-implementations.conversation.js";
import {
  whatsappQaApprovalExecDenyNativeScenario,
  whatsappQaApprovalExecGroupReactionNativeScenario,
  whatsappQaApprovalExecNativeScenario,
  whatsappQaApprovalExecReactionNativeScenario,
  whatsappQaApprovalPluginNativeScenario,
  whatsappQaGroupAllowlistBlockScenario,
  whatsappQaReplyDeliveryShapeScenario,
  whatsappQaStatusReactionLifecycleScenario,
  whatsappQaStatusReactionsScenario,
  whatsappQaStreamFinalMessageAccountingScenario,
} from "./whatsapp-live.scenario-implementations.delivery.js";
import {
  whatsappQaAgentMessageActionReactScenario,
  whatsappQaAgentMessageActionUploadFileScenario,
  whatsappQaAudioPreflightScenario,
  whatsappQaGroupAgentMessageActionReactScenario,
  whatsappQaGroupAgentMessageActionUploadFileScenario,
  whatsappQaInboundImageCaptionScenario,
  whatsappQaInboundReactionNoTriggerScenario,
  whatsappQaOutboundMediaMatrixScenario,
  whatsappQaReplyContextIsolationScenario,
} from "./whatsapp-live.scenario-implementations.user-path.js";
import { waitForWhatsAppChannelStable } from "./whatsapp-live.setup.js";

async function runWhatsAppScenarioAttempt(params: {
  environment: WhatsAppQaScenarioEnvironment;
  implementation: WhatsAppQaScenarioImplementation;
  run: WhatsAppQaScenarioRun;
  scenario: WhatsAppQaScenarioMetadata;
}): Promise<WhatsAppQaScenarioResult> {
  const driver = params.environment.getDriver();
  const runtimeEnv = params.environment.runtimeEnv;
  const scenarioRun = params.run;
  const resolvedTarget = resolveWhatsAppQaScenarioTarget({
    groupJid: runtimeEnv.groupJid,
    scenarioId: params.scenario.id,
    target: scenarioRun.kind === "approval" ? (scenarioRun.target ?? "dm") : scenarioRun.target,
  });
  const targets =
    scenarioRun.kind !== "approval"
      ? resolveWhatsAppQaMessageTargets({
          driverPhoneE164: runtimeEnv.driverPhoneE164,
          groupJid: runtimeEnv.groupJid,
          scenarioTarget: scenarioRun.target,
          sutPhoneE164: runtimeEnv.sutPhoneE164,
        })
      : undefined;
  const target = targets?.driverTarget ?? runtimeEnv.sutPhoneE164;
  const approvalTurnSourceTo =
    scenarioRun.kind === "approval" && resolvedTarget.target === "group"
      ? resolvedTarget.groupJid
      : runtimeEnv.driverPhoneE164;
  if (scenarioRun.kind === "approval") {
    const approval = await runWhatsAppApprovalScenario({
      driver,
      gateway: params.environment.gateway as never,
      observedMessages: params.environment.observedMessages,
      run: scenarioRun,
      scenario: params.scenario,
      sutAccountId: params.environment.sutAccountId,
      sutPhoneE164: runtimeEnv.sutPhoneE164,
      turnSourceTo: approvalTurnSourceTo,
    });
    return {
      ...buildWhatsAppQaScenarioResultBase(params.scenario, params.implementation),
      status: "pass",
      details: `${scenarioRun.approvalKind} approval ${approval.approvalId} resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
      rttMs: approval.rttMs,
      requestStartedAt: approval.requestStartedAt.toISOString(),
      responseObservedAt: approval.responseObservedAt.toISOString(),
      rttMeasurement: {
        finalMatchedReplyRttMs: approval.rttMs,
        requestStartedAt: approval.requestStartedAt.toISOString(),
        responseObservedAt: approval.responseObservedAt.toISOString(),
        source: "approval-request-to-resolution",
      },
    };
  }
  if (scenarioRun.quietInput !== undefined) {
    const quietStartedAt = new Date();
    const quietSendMode = scenarioRun.quietSendMode ?? scenarioRun.sendMode;
    if (quietSendMode?.kind === "media") {
      await driver.sendMedia(
        target,
        scenarioRun.quietInput,
        quietSendMode.mediaBuffer,
        quietSendMode.mediaType,
        { fileName: quietSendMode.fileName },
      );
    } else {
      await driver.sendText(target, scenarioRun.quietInput);
    }
    await waitForNoWhatsAppReply({
      ...(scenarioRun.quietMatchText
        ? {
            allowQuietWindowMessage: (message: WhatsAppQaDriverObservedMessage) =>
              !messageMatches(message as WhatsAppObservedMessage, scenarioRun.quietMatchText!),
          }
        : {}),
      driver,
      observedAfter: quietStartedAt,
      sutPhoneE164: runtimeEnv.sutPhoneE164,
      windowMs: scenarioRun.quietWindowMs ?? 5_000,
      ...resolveWhatsAppQaNoReplyTarget({
        groupJid: runtimeEnv.groupJid,
        target: scenarioRun.target,
      }),
    });
    await waitForWhatsAppChannelStable(
      params.environment.gateway as never,
      params.environment.sutAccountId,
    );
  }
  const requestStartedAt = new Date();
  const sent =
    scenarioRun.sendMode?.kind === "media"
      ? await driver.sendMedia(
          target,
          scenarioRun.input,
          scenarioRun.sendMode.mediaBuffer,
          scenarioRun.sendMode.mediaType,
          { fileName: scenarioRun.sendMode.fileName },
        )
      : await driver.sendText(target, scenarioRun.input);
  const scenarioContext: WhatsAppQaMessageScenarioContext = {
    driver,
    driverPhoneE164: runtimeEnv.driverPhoneE164,
    gateway: params.environment.gateway as never,
    gatewayTarget: targets?.gatewayTarget ?? runtimeEnv.driverPhoneE164,
    gatewayWorkspaceDir: params.environment.gateway.workspaceDir,
    recordObservedMessage: (message) => {
      params.environment.observedMessages.push({
        ...message,
        matchedScenario: true,
        scenarioId: params.scenario.id,
        scenarioTitle: params.scenario.title,
      });
    },
    requestStartedAt,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sent,
    sutAccountId: params.environment.sutAccountId,
    sutPhoneE164: runtimeEnv.sutPhoneE164,
    target,
    targetKind: scenarioRun.target,
    waitForReady: async () =>
      await waitForWhatsAppChannelStable(
        params.environment.gateway as never,
        params.environment.sutAccountId,
      ),
  };
  const afterSendDetails = await scenarioRun.afterSend?.(scenarioContext);
  if (!scenarioRun.expectReply) {
    await waitForNoWhatsAppReply({
      allowQuietWindowMessage: (message) =>
        scenarioRun.allowQuietWindowMessage?.(message, scenarioContext) ?? false,
      driver,
      observedAfter: requestStartedAt,
      sutPhoneE164: runtimeEnv.sutPhoneE164,
      windowMs: scenarioRun.quietWindowMs ?? params.scenario.timeoutMs,
      ...resolveWhatsAppQaNoReplyTarget({
        groupJid: runtimeEnv.groupJid,
        target: scenarioRun.target,
      }),
    });
    return {
      ...buildWhatsAppQaScenarioResultBase(params.scenario, params.implementation),
      status: "pass",
      details: ["no reply", afterSendDetails].filter(Boolean).join("; "),
    };
  }
  const reply = await waitForWhatsAppScenarioSutMessage(scenarioContext, {
    observedAfter: requestStartedAt,
    timeoutMs: params.scenario.timeoutMs,
    targetKind: scenarioRun.target,
    match: (message) => messageMatches(message as WhatsAppObservedMessage, scenarioRun.matchText),
  });
  scenarioRun.verify?.(reply, scenarioContext);
  const afterReplyDetails = await scenarioRun.afterReply?.(reply, scenarioContext);
  const batchDetails = await assertWhatsAppScenarioMessageBatch({
    alreadyRecordedMessageIds: new Set(reply.messageId ? [reply.messageId] : []),
    context: scenarioContext,
    observedAfter: requestStartedAt,
    run: scenarioRun,
  });
  const responseObservedAt = new Date(reply.observedAt);
  const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
  return {
    ...buildWhatsAppQaScenarioResultBase(params.scenario, params.implementation),
    status: "pass",
    details: [`reply matched in ${rttMs}ms`, afterSendDetails, afterReplyDetails, batchDetails]
      .filter(Boolean)
      .join("; "),
    rttMs,
    requestStartedAt: requestStartedAt.toISOString(),
    responseObservedAt: responseObservedAt.toISOString(),
    rttMeasurement: {
      finalMatchedReplyRttMs: rttMs,
      requestStartedAt: requestStartedAt.toISOString(),
      responseObservedAt: responseObservedAt.toISOString(),
      source: "request-to-observed-message",
    },
  };
}

async function runWhatsAppScenario(
  environment: WhatsAppQaScenarioEnvironment,
  implementation: WhatsAppQaScenarioImplementation,
) {
  const scenario = environment.scenario;
  const { run } = await environment.configureScenario(implementation);
  for (let attempt = 1; attempt <= WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS; attempt += 1) {
    try {
      const result = await runWhatsAppScenarioAttempt({
        environment,
        implementation,
        run,
        scenario,
      });
      return attempt === 1
        ? result
        : { ...result, details: `${result.details}; driver reconnected ${attempt - 1}x` };
    } catch (error) {
      if (
        attempt >= WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS ||
        !isTransientWhatsAppQaDriverError(error)
      ) {
        throw error;
      }
      const nextDriver = await restartWhatsAppQaDriverSession({
        authDir: environment.driverAuthDir,
        current: environment.getDriver(),
      });
      await environment.replaceDriver(nextDriver);
    }
  }
  throw new Error(`WhatsApp scenario ${scenario.id} exhausted driver retries`);
}

export const runWhatsAppCanaryScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaCanaryScenario);
export const runWhatsAppMentionGatingScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaMentionGatingScenario);
export const runWhatsAppGroupPendingHistoryContextScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaGroupPendingHistoryContextScenario);
export const runWhatsAppBroadcastGroupFanoutScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaBroadcastGroupFanoutScenario);
export const runWhatsAppGroupActivationAlwaysScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupActivationAlwaysScenario);
export const runWhatsAppGroupReplyToBotTriggersScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaGroupReplyToBotTriggersScenario);
export const runWhatsAppTopLevelReplyShapeScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaTopLevelReplyShapeScenario);
export const runWhatsAppReplyToMessageScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaReplyToMessageScenario);
export const runWhatsAppGroupReplyToMessageScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupReplyToMessageScenario);
export const runWhatsAppReplyToModeBatchedScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaReplyToModeBatchedScenario);
export const runWhatsAppAgentMessageActionReactScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaAgentMessageActionReactScenario);
export const runWhatsAppAgentMessageActionUploadFileScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaAgentMessageActionUploadFileScenario);
export const runWhatsAppGroupAgentMessageActionReactScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaGroupAgentMessageActionReactScenario);
export const runWhatsAppGroupAgentMessageActionUploadFileScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaGroupAgentMessageActionUploadFileScenario);
export const runWhatsAppInboundReactionNoTriggerScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaInboundReactionNoTriggerScenario);
export const runWhatsAppReplyContextIsolationScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaReplyContextIsolationScenario);
export const runWhatsAppInboundImageCaptionScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaInboundImageCaptionScenario);
export const runWhatsAppAudioPreflightScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaAudioPreflightScenario);
export const runWhatsAppOutboundMediaMatrixScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaOutboundMediaMatrixScenario);
export const runWhatsAppOutboundDocumentPreservesFilenameScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaOutboundDocumentPreservesFilenameScenario);
export const runWhatsAppOutboundSendSerializationScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaOutboundSendSerializationScenario);
export const runWhatsAppOutboundPollScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaOutboundPollScenario);
export const runWhatsAppGroupOutboundMediaScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupOutboundMediaScenario);
export const runWhatsAppGroupOutboundAudioScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupOutboundAudioScenario);
export const runWhatsAppGroupOutboundPollScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupOutboundPollScenario);
export const runWhatsAppMessageActionsScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaMessageActionsScenario);
export const runWhatsAppInboundStructuredMessagesScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaInboundStructuredMessagesScenario);
export const runWhatsAppGroupAudioGatingScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupAudioGatingScenario);
export const runWhatsAppReplyDeliveryShapeScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaReplyDeliveryShapeScenario);
export const runWhatsAppStreamFinalMessageAccountingScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaStreamFinalMessageAccountingScenario);
export const runWhatsAppApprovalExecDenyNativeScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaApprovalExecDenyNativeScenario);
export const runWhatsAppStatusReactionsScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaStatusReactionsScenario);
export const runWhatsAppStatusReactionLifecycleScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaStatusReactionLifecycleScenario);
export const runWhatsAppGroupAllowlistBlockScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaGroupAllowlistBlockScenario);
export const runWhatsAppApprovalExecNativeScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaApprovalExecNativeScenario);
export const runWhatsAppApprovalExecReactionNativeScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaApprovalExecReactionNativeScenario);
export const runWhatsAppApprovalExecGroupReactionNativeScenario = (
  context: WhatsAppQaScenarioEnvironment,
) => runWhatsAppScenario(context, whatsappQaApprovalExecGroupReactionNativeScenario);
export const runWhatsAppApprovalPluginNativeScenario = (context: WhatsAppQaScenarioEnvironment) =>
  runWhatsAppScenario(context, whatsappQaApprovalPluginNativeScenario);
