import type { SlackQaScenarioEnvironment } from "./scenario-environment.js";
import { runSlackApprovalScenario } from "./slack-live.approvals.js";
import { runSlackCodexApprovalScenario } from "./slack-live.codex-approval-runner.js";
import type { SlackQaMessageScenarioRun } from "./slack-live.contracts.js";
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
import { getSlackQaScenarioDefinition } from "./slack-live.scenarios.js";

async function runSlackMessageScenario(params: {
  environment: SlackQaScenarioEnvironment;
  run: SlackQaMessageScenarioRun;
  scenarioId: string;
  scenarioTitle: string;
  timeoutMs: number;
}) {
  const beforeRunResult = await params.run.beforeRun?.(params.environment.context);
  const beforeRunDetails =
    typeof beforeRunResult === "string" ? beforeRunResult : beforeRunResult?.details;
  const observedMessageStartIndex = params.environment.observedMessages.length;
  const requestStartedAt = new Date();
  const sent = await sendSlackChannelMessage({
    channelId: params.environment.channelId,
    client: params.environment.context.driverClient,
    text: params.run.input,
    threadTs: typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined,
  });
  const requestThreadTs =
    (typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined) ?? sent.ts;
  if (!params.run.expectReply) {
    await waitForSlackNoReply({
      channelId: params.environment.channelId,
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
      ...params.environment.context,
      sentTs: sent.ts,
    });
    return {
      details: ["no reply", beforeRunDetails, afterNoReplyDetails].filter(Boolean).join("; "),
    };
  }
  const reply = await waitForSlackScenarioReply({
    channelId: params.environment.channelId,
    client: params.environment.context.sutReadClient,
    matchText: params.run.matchText,
    observedMessages: params.environment.observedMessages,
    observationScenarioId: params.scenarioId,
    observationScenarioTitle: params.scenarioTitle,
    sentTs: sent.ts,
    threadTs: requestThreadTs,
    sutIdentity: params.environment.sutIdentity,
    timeoutMs: params.timeoutMs,
  });
  params.run.verify?.(reply.message, { requestThreadTs, sentTs: sent.ts });
  if (params.run.settleObservedMs) {
    await observeSlackScenarioMessages({
      channelId: params.environment.channelId,
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
  const observedDetails = params.run.verifyObserved?.({
    finalMessage: reply.message,
    messages: params.environment.observedMessages.slice(observedMessageStartIndex),
  });
  const afterReplyDetails = await params.run.afterReply?.(reply.message, {
    ...params.environment.context,
    sentTs: sent.ts,
  });
  const responseObservedAt = new Date(reply.observedAt);
  const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
  return {
    details: [`reply matched in ${rttMs}ms`, beforeRunDetails, observedDetails, afterReplyDetails]
      .filter(Boolean)
      .join("; "),
  };
}

async function runSlackScenario(environment: SlackQaScenarioEnvironment, scenarioId: string) {
  const scenario = getSlackQaScenarioDefinition(scenarioId);
  const run = scenario.buildRun(environment.sutIdentity.userId);
  if (run.kind === "direct-transport") {
    const result = await run.execute({
      cfg: environment.cfg,
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
      primaryModel: environment.primaryModel,
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

export const runSlackCanaryScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-canary");
export const runSlackMentionGatingScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-mention-gating");
export const runSlackAllowlistBlockScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-allowlist-block");
export const runSlackChannelDisabledWarningScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-channel-disabled-warning");
export const runSlackTopLevelReplyShapeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-top-level-reply-shape");
export const runSlackProgressCommentaryTrueScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-progress-commentary-true");
export const runSlackProgressCommentaryFalseScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-progress-commentary-false");
export const runSlackProgressCommentaryOmittedScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-progress-commentary-omitted");
export const runSlackProgressCommentaryVerboseDedupeScenario = (
  context: SlackQaScenarioEnvironment,
) => runSlackScenario(context, "slack-progress-commentary-verbose-dedupe");
export const runSlackChartPresentationNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-chart-presentation-native");
export const runSlackTablePresentationNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-table-presentation-native");
export const runSlackTableInvalidBlocksFallbackScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-table-invalid-blocks-fallback");
export const runSlackReactionGlyphNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-reaction-glyph-native");
export const runSlackApprovalExecNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-approval-exec-native");
export const runSlackApprovalPluginNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-approval-plugin-native");
export const runSlackCodexApprovalExecNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-codex-approval-exec-native");
export const runSlackCodexApprovalPluginNativeScenario = (context: SlackQaScenarioEnvironment) =>
  runSlackScenario(context, "slack-codex-approval-plugin-native");
