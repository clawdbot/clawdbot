// QA Lab Slack approval checkpoint and gateway decision RPC.
import fs from "node:fs/promises";
import path from "node:path";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  formatApprovalResultValue,
  readAcceptedApprovalRequestId,
} from "../shared/live-approval-result.js";
import {
  SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
  SLACK_QA_APPROVAL_CHECKPOINT_DEFAULT_TIMEOUT_MS,
  type SlackQaScenarioId,
  type SlackQaApprovalKind,
  type SlackQaApprovalDecision,
  type SlackQaApprovalScenarioRun,
  type SlackQaScenarioContext,
  type SlackApprovalCheckpointState,
  type SlackApprovalCheckpointAck,
  SLACK_QA_APPROVAL_CHECKPOINT_DIR_ENV,
  SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV,
  type SlackMessage,
} from "./slack-live.contracts.js";
import { buildSlackApprovalCheckpointMessage } from "./slack-live.observations.js";

function resolveSlackApprovalCheckpointConfig(env: NodeJS.ProcessEnv = process.env) {
  const checkpointDir = env[SLACK_QA_APPROVAL_CHECKPOINT_DIR_ENV]?.trim();
  if (!checkpointDir) {
    return undefined;
  }
  const rawTimeout = env[SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV]?.trim();
  const timeoutMs = rawTimeout
    ? parseStrictPositiveInteger(rawTimeout)
    : SLACK_QA_APPROVAL_CHECKPOINT_DEFAULT_TIMEOUT_MS;
  if (timeoutMs === undefined) {
    throw new Error(`${SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV} must be a positive integer.`);
  }
  return {
    checkpointDir,
    timeoutMs,
  };
}

async function waitForSlackApprovalCheckpointAck(params: {
  ackPath: string;
  timeoutMs: number;
}): Promise<SlackApprovalCheckpointAck> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const parsed = JSON.parse(await fs.readFile(params.ackPath, "utf8")) as {
        capturedAt?: unknown;
        error?: unknown;
        screenshotPath?: unknown;
      };
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
        throw new Error(`Slack approval checkpoint watcher failed: ${parsed.error}`);
      }
      return {
        capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : undefined,
        screenshotPath:
          typeof parsed.screenshotPath === "string" ? parsed.screenshotPath : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for ${params.ackPath}`);
}

export async function writeSlackApprovalCheckpoint(params: {
  approvalId: string;
  approvalKind: SlackQaApprovalKind;
  channelId: string;
  decision?: SlackQaApprovalDecision;
  message: SlackMessage;
  observedAt: string;
  scenarioId: SlackQaScenarioId;
  state: SlackApprovalCheckpointState;
}) {
  const config = resolveSlackApprovalCheckpointConfig();
  if (!config) {
    return undefined;
  }
  await fs.mkdir(config.checkpointDir, { recursive: true });
  const checkpointPath = path.join(
    config.checkpointDir,
    `${params.scenarioId}.${params.state}.json`,
  );
  const ackPath = path.join(config.checkpointDir, `${params.scenarioId}.${params.state}.ack.json`);
  await fs.rm(ackPath, { force: true }).catch(() => {});
  await fs.writeFile(
    checkpointPath,
    `${JSON.stringify(
      {
        version: 1,
        scenarioId: params.scenarioId,
        approvalKind: params.approvalKind,
        state: params.state,
        approvalId: params.approvalId,
        channelId: params.channelId,
        messageTs: params.message.ts,
        threadTs: params.message.thread_ts ?? null,
        decision: params.decision ?? null,
        observedAt: params.observedAt,
        message: buildSlackApprovalCheckpointMessage(params.message),
      },
      null,
      2,
    )}\n`,
  );
  const ack = await waitForSlackApprovalCheckpointAck({
    ackPath,
    timeoutMs: config.timeoutMs,
  });
  return {
    ackPath,
    checkpointPath,
    screenshotPath: ack.screenshotPath,
  };
}

export async function requestSlackApproval(params: {
  approvalId: string;
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  run: SlackQaApprovalScenarioRun;
  sutAccountId: string;
}) {
  const commonParams = {
    timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
    turnSourceAccountId: params.sutAccountId,
    turnSourceChannel: "slack",
    turnSourceTo: `channel:${params.channelId}`,
    twoPhase: true,
  };
  if (params.run.approvalKind === "exec") {
    const result = await params.context.gateway.call(
      "exec.approval.request",
      {
        ...commonParams,
        ask: "always",
        command: `printf '%s\\n' '${params.run.token}'`,
        host: "gateway",
        id: params.approvalId,
        security: "full",
      },
      {
        expectFinal: false,
        timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
      },
    );
    const acceptedId = readAcceptedApprovalRequestId(result);
    if (acceptedId !== params.approvalId) {
      throw new Error(
        `accepted exec approval id was ${formatApprovalResultValue(
          acceptedId,
        )} instead of ${params.approvalId}`,
      );
    }
    return acceptedId;
  }
  const result = await params.context.gateway.call(
    "plugin.approval.request",
    {
      ...commonParams,
      agentId: "qa",
      description: `Slack plugin approval QA request ${params.run.token}`,
      pluginId: "qa-slack-plugin",
      severity: "warning",
      title: `Slack plugin approval QA ${params.run.token}`,
      toolName: "slack_qa_tool",
    },
    {
      expectFinal: false,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
  return readAcceptedApprovalRequestId(result);
}

export async function waitForApprovalDecision(params: {
  approvalId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  kind: SlackQaApprovalKind;
}) {
  const method =
    params.kind === "exec" ? "exec.approval.waitDecision" : "plugin.approval.waitDecision";
  return await params.context.gateway.call(
    method,
    { id: params.approvalId },
    {
      expectFinal: true,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}
