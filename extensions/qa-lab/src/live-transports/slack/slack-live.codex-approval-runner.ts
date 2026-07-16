// QA Lab Slack Codex approval scenario orchestration.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { writeSlackApprovalCheckpoint } from "./slack-live.approval-checkpoint.js";
import {
  waitForSlackApprovalPrompt,
  waitForSlackApprovalResolvedUpdate,
  resolveApprovalDecision,
} from "./slack-live.approvals.js";
import {
  assertCodexApprovalOperationSucceeded,
  assertPendingCodexPluginApproval,
  startCodexApprovalAgentRun,
  buildCodexApprovalSessionKey,
  waitForCodexApprovalAgentRun,
  quiesceCodexApprovalAgentRun,
  resolveCodexFileApprovalTargetPath,
} from "./slack-live.codex-approval.js";
import type {
  SlackQaCodexApprovalScenarioRun,
  SlackQaScenarioContext,
  SlackQaScenarioDefinition,
  SlackObservedMessage,
  SlackApprovalArtifact,
} from "./slack-live.contracts.js";

export async function runSlackCodexApprovalScenario(params: {
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  observedMessages: SlackObservedMessage[];
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  scenario: SlackQaScenarioDefinition;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
  sutAccountId: string;
}) {
  const codexRun = {
    runId: `slack-qa-codex-approval-${randomUUID()}`,
    sessionKey: buildCodexApprovalSessionKey({
      scenario: params.scenario,
      token: params.run.token,
    }),
  };
  const targetPath =
    params.run.appServerMethod === "item/fileChange/requestApproval"
      ? resolveCodexFileApprovalTargetPath(params.run.token)
      : undefined;
  if (targetPath) {
    await fs.rm(targetPath, { force: true });
  }
  const outcome = await runSlackCodexApprovalScenarioInner({ ...params, codexRun }).then(
    (result) => ({ kind: "success", result }) as const,
    (error: unknown) => ({ error, kind: "failure" }) as const,
  );
  // Kill the gateway process tree before deleting the probe. Agent completion
  // does not prove the native Codex turn has stopped writing after an interrupt.
  const cleanupErrors: unknown[] = [];
  try {
    await quiesceCodexApprovalAgentRun({
      context: params.context,
      preserveDebugArtifacts: outcome.kind === "failure",
      stopGateway: params.stopGateway,
      ...codexRun,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 0 && targetPath) {
    try {
      await fs.rm(targetPath, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanupSummary = cleanupErrors.map(formatErrorMessage).join("; ");
    if (outcome.kind === "failure") {
      throw new AggregateError(
        [outcome.error, ...cleanupErrors],
        `Codex approval scenario failed: ${formatErrorMessage(outcome.error)}; cleanup also failed: ${cleanupSummary}`,
        { cause: outcome.error },
      );
    }
    throw new AggregateError(cleanupErrors, `Codex approval cleanup failed: ${cleanupSummary}`);
  }
  if (outcome.kind === "failure") {
    throw outcome.error;
  }
  return outcome.result;
}

async function runSlackCodexApprovalScenarioInner(params: {
  channelId: string;
  codexRun: { runId: string; sessionKey: string };
  context: Omit<SlackQaScenarioContext, "sentTs">;
  observedMessages: SlackObservedMessage[];
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  scenario: SlackQaScenarioDefinition;
  sutAccountId: string;
}) {
  const requestStartedAt = new Date();
  const oldestTs = ((requestStartedAt.getTime() - 5_000) / 1_000).toFixed(6);
  await startCodexApprovalAgentRun({
    channelId: params.channelId,
    context: params.context,
    primaryModel: params.primaryModel,
    run: params.run,
    runId: params.codexRun.runId,
    scenario: params.scenario,
    sessionKey: params.codexRun.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  const expectedTitle =
    params.run.appServerMethod === "item/commandExecution/requestApproval"
      ? "Codex app-server command approval"
      : "Codex app-server file approval";
  const pending = await waitForSlackApprovalPrompt({
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    extraTextMatches: ["openclaw-codex-app-server", expectedTitle],
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
  });
  const approvalId = pending.approvalId;
  if (!approvalId) {
    throw new Error(
      "Codex Slack approval prompt exposed native actions but no plugin approval id.",
    );
  }
  await assertPendingCodexPluginApproval({
    approvalId,
    appServerMethod: params.run.appServerMethod,
    channelId: params.channelId,
    context: params.context,
    sessionKey: params.codexRun.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  const pendingCheckpoint = await writeSlackApprovalCheckpoint({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    message: pending.message,
    observedAt: pending.observedAt,
    scenarioId: params.scenario.id,
    state: "pending",
  });
  await resolveApprovalDecision({
    approvalId,
    context: params.context,
    decision: params.run.decision,
    kind: params.run.approvalKind,
  });
  const finalCodexTurnStatus = await waitForCodexApprovalAgentRun({
    context: params.context,
    runId: params.codexRun.runId,
    timeoutMs: params.scenario.timeoutMs,
  });
  if (finalCodexTurnStatus !== "ok") {
    throw new Error(
      `Codex approval run ${params.codexRun.runId} finished with status ${finalCodexTurnStatus}`,
    );
  }
  await assertCodexApprovalOperationSucceeded({
    context: params.context,
    run: params.run,
    sessionKey: params.codexRun.sessionKey,
  });
  const resolved = await waitForSlackApprovalResolvedUpdate({
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    messageTs: pending.message.ts,
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
    extraTextMatches: ["openclaw-codex-app-server", expectedTitle],
  });
  const resolvedCheckpoint = await writeSlackApprovalCheckpoint({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    decision: params.run.decision,
    message: resolved.message,
    observedAt: resolved.observedAt,
    scenarioId: params.scenario.id,
    state: "resolved",
  });
  const responseObservedAt = new Date(resolved.observedAt);
  return {
    artifact: {
      approvalId,
      approvalKind: params.run.approvalKind,
      appServerMethod: params.run.appServerMethod,
      channelId: params.channelId,
      codexModelKey: params.primaryModel,
      decision: params.run.decision,
      finalCodexTurnStatus,
      operationVerified: true,
      pendingActionValues: pending.actionValues,
      pendingCheckpointPath: pendingCheckpoint?.checkpointPath,
      pendingMessageTs: pending.message.ts,
      pendingScreenshotPath: pendingCheckpoint?.screenshotPath,
      pendingText: pending.message.text,
      resolvedActionValues: resolved.actionValues,
      resolvedCheckpointPath: resolvedCheckpoint?.checkpointPath,
      resolvedMessageTs: resolved.message.ts,
      resolvedScreenshotPath: resolvedCheckpoint?.screenshotPath,
      resolvedText: resolved.message.text,
      threadTs: pending.message.thread_ts,
    } satisfies SlackApprovalArtifact,
    requestStartedAt,
    responseObservedAt,
    rttMs: responseObservedAt.getTime() - requestStartedAt.getTime(),
  };
}
