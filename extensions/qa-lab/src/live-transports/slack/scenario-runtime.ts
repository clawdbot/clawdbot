import type { SlackQaScenarioEnvironment } from "./scenario-environment.js";
import { runSlackApprovalScenario } from "./slack-live.approvals.js";
import { runSlackCodexApprovalScenario } from "./slack-live.codex-approval-runner.js";
import type {
  SlackQaMessageScenarioRun,
  SlackQaScenarioImplementation,
} from "./slack-live.contracts.js";
import {
  observeSlackScenarioMessages,
  waitForSlackNoReply,
  waitForSlackScenarioReply,
} from "./slack-live.message-observations.js";
import {
  collectSlackActionValues,
  collectSlackBlockText,
  sendSlackChannelMessage,
} from "./slack-live.observations.js";

export {
  slackQaAllowlistBlockScenario,
  slackQaApprovalExecNativeScenario,
  slackQaApprovalPluginNativeScenario,
  slackQaCanaryScenario,
  slackQaChannelDisabledWarningScenario,
  slackQaChartPresentationNativeScenario,
  slackQaCodexApprovalExecNativeScenario,
  slackQaCodexApprovalPluginNativeScenario,
  slackQaMentionGatingScenario,
  slackQaMpimAppMentionDedupeScenario,
  slackQaProgressCommentaryFalseScenario,
  slackQaProgressCommentaryOmittedScenario,
  slackQaProgressCommentaryTrueScenario,
  slackQaProgressCommentaryVerboseDedupeScenario,
  slackQaReactionGlyphNativeScenario,
  slackQaTableInvalidBlocksFallbackScenario,
  slackQaTablePresentationNativeScenario,
  slackQaTopLevelReplyShapeScenario,
} from "./slack-live.scenario-implementations.js";

async function runSlackMessageScenario(params: {
  environment: SlackQaScenarioEnvironment;
  run: SlackQaMessageScenarioRun;
  scenarioId: string;
  scenarioTitle: string;
  timeoutMs: number;
}) {
  let scenarioContext = params.environment.context;
  try {
    const beforeRunResult = await params.run.beforeRun?.(params.environment.context);
    const beforeRunDetails =
      typeof beforeRunResult === "string" ? beforeRunResult : beforeRunResult?.details;
    const channelId =
      typeof beforeRunResult === "object" && beforeRunResult.inputChannelId?.trim()
        ? beforeRunResult.inputChannelId.trim()
        : params.environment.channelId;
    scenarioContext = { ...params.environment.context, channelId };
    const observedMessageStartIndex = params.environment.observedMessages.length;
    const messageWriteCursor = params.environment.getMessageWriteCursor();
    const requestStartedAt = new Date();
    const sent = await sendSlackChannelMessage({
      channelId,
      client: params.environment.context.driverClient,
      text: params.run.input,
      threadTs: typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined,
    });
    const requestThreadTs =
      (typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined) ?? sent.ts;
    if (!params.run.expectReply) {
      await waitForSlackNoReply({
        channelId,
        client: params.environment.context.sutReadClient,
        matchText: params.run.matchText,
        observedMessages: params.environment.observedMessages,
        observationScenarioId: params.scenarioId,
        observationScenarioTitle: params.scenarioTitle,
        sentTs: sent.ts,
        sutIdentity: params.environment.sutIdentity,
        timeoutMs: params.timeoutMs,
      });
      const afterNoReplyDetails = await params.run.afterNoReply?.({
        ...scenarioContext,
        sentTs: sent.ts,
      });
      return {
        details: ["no reply", beforeRunDetails, afterNoReplyDetails].filter(Boolean).join("; "),
      };
    }
    const reply = await waitForSlackScenarioReply({
      channelId,
      client: params.environment.context.sutReadClient,
      matchText: params.run.matchText,
      observedMessages: params.environment.observedMessages,
      observationScenarioId: params.scenarioId,
      observationScenarioTitle: params.scenarioTitle,
      sentTs: sent.ts,
      sutIdentity: params.environment.sutIdentity,
      threadTs: requestThreadTs,
      timeoutMs: params.timeoutMs,
    });
    params.run.verify?.(reply.message, { requestThreadTs, sentTs: sent.ts });
    if (params.run.settleObservedMs) {
      await observeSlackScenarioMessages({
        channelId,
        client: params.environment.context.sutReadClient,
        matchText: params.run.matchText,
        observedMessages: params.environment.observedMessages,
        observationScenarioId: params.scenarioId,
        observationScenarioTitle: params.scenarioTitle,
        sentTs: sent.ts,
        settleMs: params.run.settleObservedMs,
        sutIdentity: params.environment.sutIdentity,
        threadTs: requestThreadTs,
      });
    }
    const capturedMessages = await params.environment.readMessageWrites(messageWriteCursor);
    const observedDetails = params.run.verifyObserved?.({
      finalMessage: reply.message,
      messages: [
        ...params.environment.observedMessages.slice(observedMessageStartIndex),
        ...capturedMessages.filter((message) => message.channelId === channelId),
      ],
    });
    const afterReplyDetails = await params.run.afterReply?.(reply.message, {
      ...scenarioContext,
      sentTs: sent.ts,
    });
    const responseObservedAt = new Date(reply.observedAt);
    const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
    return {
      details: [`reply matched in ${rttMs}ms`, beforeRunDetails, observedDetails, afterReplyDetails]
        .filter(Boolean)
        .join("; "),
    };
  } finally {
    await params.run.cleanup?.(scenarioContext);
  }
}

export async function runSlackScenario(
  environment: SlackQaScenarioEnvironment,
  implementation: SlackQaScenarioImplementation,
) {
  const scenario = environment.scenario;
  const { cfg, primaryModel, run } = await environment.configureScenario(implementation);
  if (run.kind === "direct-transport") {
    const result = await run.execute({
      cfg,
      channelId: environment.channelId,
      sutAccountId: environment.sutAccountId,
      sutIdentity: environment.sutIdentity,
      sutReadClient: environment.context.sutReadClient,
      sutWriteClient: environment.sutWriteClient,
      timeoutMs: scenario.timeoutMs,
    });
    const message = result.message;
    if (!message.ts) {
      throw new Error("direct Slack transport scenario returned no stored message id");
    }
    environment.observedMessages.push({
      actionValues: collectSlackActionValues(message.blocks),
      blockText: collectSlackBlockText(message.blocks),
      botId: message.bot_id,
      channelId: environment.channelId,
      matchedScenario: true,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      text: message.text ?? "",
      threadTs: message.thread_ts,
      ts: message.ts,
      userId: message.user,
    });
    return { details: result.details };
  }
  if (run.kind === "approval") {
    const approval = await runSlackApprovalScenario({
      channelId: environment.channelId,
      context: environment.context,
      observedMessages: environment.observedMessages,
      run,
      scenario,
      sutAccountId: environment.sutAccountId,
    });
    return {
      details: `${run.approvalKind} approval resolved ${run.decision} in ${approval.rttMs}ms`,
      artifacts: { approval: approval.artifact },
    };
  }
  if (run.kind === "codex-approval") {
    const approval = await runSlackCodexApprovalScenario({
      channelId: environment.channelId,
      context: environment.context,
      observedMessages: environment.observedMessages,
      primaryModel,
      run,
      scenario,
      stopGateway: environment.stopGateway,
      sutAccountId: environment.sutAccountId,
    });
    return {
      details: `Codex ${run.appServerMethod} approval resolved ${run.decision} in ${approval.rttMs}ms`,
      artifacts: { approval: approval.artifact },
    };
  }
  return await runSlackMessageScenario({
    environment,
    run,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    timeoutMs: scenario.timeoutMs,
  });
}
