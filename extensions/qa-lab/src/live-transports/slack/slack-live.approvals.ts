// QA Lab Slack native approval observation and resolution.
import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { assertApprovalDecisionResult } from "../shared/live-approval-result.js";
import {
  writeSlackApprovalCheckpoint,
  requestSlackApproval,
  waitForApprovalDecision,
} from "./slack-live.approval-checkpoint.js";
import {
  SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
  type SlackQaApprovalKind,
  type SlackQaApprovalDecision,
  type SlackQaApprovalScenarioRun,
  type SlackQaScenarioContext,
  type SlackQaScenarioDefinition,
  type SlackAuthIdentity,
  type SlackObservedMessage,
  type SlackApprovalArtifact,
  type SlackMessage,
} from "./slack-live.contracts.js";
import {
  listSlackMessages,
  collectSlackBlockText,
  collectSlackActionValues,
  parseSlackNativeApprovalAction,
  hasSlackNativeApprovalActions,
  extractSlackNativeApprovalId,
  isSutSlackMessage,
} from "./slack-live.observations.js";

function resolveApprovalDecisionLabel(decision: SlackQaApprovalDecision) {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function resolveApprovalHeading(params: {
  approvalKind: SlackQaApprovalKind;
  state: "pending" | "resolved";
  decision?: SlackQaApprovalDecision;
}) {
  if (params.state === "pending") {
    return params.approvalKind === "exec" ? "Exec approval required" : "Plugin approval required";
  }
  const label = resolveApprovalDecisionLabel(params.decision ?? "allow-once");
  return params.approvalKind === "exec" ? `Exec approval: ${label}` : `Plugin approval: ${label}`;
}

function getSlackMessageSearchText(message: SlackMessage) {
  return [message.text ?? "", ...collectSlackBlockText(message.blocks)].join("\n");
}

function pushObservedApprovalMessage(params: {
  channelId: string;
  matchedScenario: boolean;
  message: SlackMessage;
  observedMessages: SlackObservedMessage[];
  scenarioId: string;
  scenarioTitle: string;
}) {
  if (!params.message.ts) {
    return;
  }
  params.observedMessages.push({
    actionValues: collectSlackActionValues(params.message.blocks),
    blockText: collectSlackBlockText(params.message.blocks),
    botId: params.message.bot_id,
    channelId: params.channelId,
    matchedScenario: params.matchedScenario,
    scenarioId: params.scenarioId,
    scenarioTitle: params.scenarioTitle,
    text: params.message.text ?? "",
    threadTs: params.message.thread_ts,
    ts: params.message.ts,
    userId: params.message.user,
  });
}

export async function waitForSlackApprovalPrompt(params: {
  approvalId?: string;
  approvalKind: SlackQaApprovalKind;
  channelId: string;
  client: WebClient;
  decision: SlackQaApprovalDecision;
  observedMessages: SlackObservedMessage[];
  oldestTs: string;
  scenarioId: string;
  scenarioTitle: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
  token?: string;
  extraTextMatches?: string[];
}) {
  const startedAt = Date.now();
  const seenObservedMessages = new Set<string>();
  let lastMatchedWithoutActions = "";
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.oldestTs,
    });
    for (const message of messages) {
      if (!message.ts || !isSutSlackMessage(message, params.sutIdentity)) {
        continue;
      }
      const text = getSlackMessageSearchText(message);
      const actionValues = collectSlackActionValues(message.blocks);
      const matchedScenario = matchesSlackApprovalPromptText({
        approvalKind: params.approvalKind,
        extraTextMatches: params.extraTextMatches,
        text,
        token: params.token,
      });
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (matchedScenario || hasSlackNativeApprovalActions({ ...params, actionValues })) {
        if (!seenObservedMessages.has(observedKey)) {
          seenObservedMessages.add(observedKey);
          pushObservedApprovalMessage({
            channelId: params.channelId,
            matchedScenario,
            message,
            observedMessages: params.observedMessages,
            scenarioId: params.scenarioId,
            scenarioTitle: params.scenarioTitle,
          });
        }
      }
      if (!matchedScenario) {
        continue;
      }
      if (
        !hasSlackNativeApprovalActions({
          actionValues,
          approvalId: params.approvalId,
          decision: params.decision,
        })
      ) {
        lastMatchedWithoutActions = `message ${message.ts} matched approval text but did not expose native approval button values`;
        continue;
      }
      return {
        actionValues,
        approvalId:
          params.approvalId ??
          extractSlackNativeApprovalId({
            actionValues,
            decision: params.decision,
          }),
        message,
        observedAt: new Date().toISOString(),
      };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    [
      `timed out after ${params.timeoutMs}ms waiting for Slack ${params.approvalKind} approval prompt`,
      lastMatchedWithoutActions,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

function matchesSlackApprovalPromptText(params: {
  approvalKind: SlackQaApprovalKind;
  extraTextMatches?: string[];
  text: string;
  token?: string;
}) {
  return (
    params.text.includes(
      resolveApprovalHeading({ approvalKind: params.approvalKind, state: "pending" }),
    ) &&
    (!params.token || params.text.includes(params.token)) &&
    (params.extraTextMatches ?? []).every((match) => params.text.includes(match))
  );
}

export async function waitForSlackApprovalResolvedUpdate(params: {
  approvalKind: SlackQaApprovalKind;
  channelId: string;
  client: WebClient;
  decision: SlackQaApprovalDecision;
  messageTs: string;
  observedMessages: SlackObservedMessage[];
  oldestTs: string;
  scenarioId: string;
  scenarioTitle: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
  token?: string;
  extraTextMatches?: string[];
}) {
  const startedAt = Date.now();
  const seenObservedMessages = new Set<string>();
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.oldestTs,
    });
    const message = messages.find((entry) => entry.ts === params.messageTs);
    if (message && isSutSlackMessage(message, params.sutIdentity)) {
      const text = getSlackMessageSearchText(message);
      const actionValues = collectSlackActionValues(message.blocks);
      const matchedScenario = matchesSlackApprovalResolvedUpdate({
        actionValues,
        approvalKind: params.approvalKind,
        decision: params.decision,
        extraTextMatches: params.extraTextMatches,
        text,
        token: params.token,
      });
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (!seenObservedMessages.has(observedKey)) {
        seenObservedMessages.add(observedKey);
        pushObservedApprovalMessage({
          channelId: params.channelId,
          matchedScenario,
          message,
          observedMessages: params.observedMessages,
          scenarioId: params.scenarioId,
          scenarioTitle: params.scenarioTitle,
        });
      }
      if (matchedScenario) {
        return {
          actionValues,
          message,
          observedAt: new Date().toISOString(),
        };
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    `timed out after ${params.timeoutMs}ms waiting for Slack ${params.approvalKind} approval resolution update`,
  );
}

function matchesSlackApprovalResolvedUpdate(params: {
  actionValues: string[];
  approvalKind: SlackQaApprovalKind;
  decision: SlackQaApprovalDecision;
  extraTextMatches?: string[];
  text: string;
  token?: string;
}) {
  return (
    params.text.includes(
      resolveApprovalHeading({
        approvalKind: params.approvalKind,
        decision: params.decision,
        state: "resolved",
      }),
    ) &&
    (!params.token || params.text.includes(params.token)) &&
    (params.extraTextMatches ?? []).every((match) => params.text.includes(match)) &&
    !params.actionValues.some((value) => parseSlackNativeApprovalAction(value))
  );
}

export async function resolveApprovalDecision(params: {
  approvalId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  decision: SlackQaApprovalDecision;
  kind: SlackQaApprovalKind;
}) {
  const method = params.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
  return await params.context.gateway.call(
    method,
    { decision: params.decision, id: params.approvalId },
    {
      expectFinal: false,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

export async function runSlackApprovalScenario(params: {
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  observedMessages: SlackObservedMessage[];
  run: SlackQaApprovalScenarioRun;
  scenario: SlackQaScenarioDefinition;
  sutAccountId: string;
}) {
  const requestStartedAt = new Date();
  const oldestTs = ((requestStartedAt.getTime() - 5_000) / 1_000).toFixed(6);
  const requestedApprovalId =
    params.run.approvalKind === "exec"
      ? `slack-qa-exec-${randomUUID()}`
      : `slack-qa-plugin-${randomUUID()}`;
  const approvalId = await requestSlackApproval({
    approvalId: requestedApprovalId,
    channelId: params.channelId,
    context: params.context,
    run: params.run,
    sutAccountId: params.sutAccountId,
  });
  const pending = await waitForSlackApprovalPrompt({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
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
  assertApprovalDecisionResult({
    decision: params.run.decision,
    result: await waitForApprovalDecision({
      approvalId,
      context: params.context,
      kind: params.run.approvalKind,
    }),
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
    token: params.run.token,
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
      channelId: params.channelId,
      decision: params.run.decision,
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
