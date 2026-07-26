// QA Lab Slack Codex approval helpers and transcript validation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listSlackReactions } from "@openclaw/slack/api.js";
import type { WebClient } from "@slack/web-api";
import { extractGatewayMessageText } from "../../gateway-log-sentinel.js";
import { formatApprovalResultValue } from "../shared/live-approval-result.js";
import { asPlainRecord } from "./slack-live.config.js";
import {
  SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
  type SlackQaCodexApprovalMethod,
  type SlackQaCodexApprovalScenarioRun,
  type SlackQaScenarioContext,
  type SlackQaScenarioDefinition,
} from "./slack-live.contracts.js";

export function resolveCodexFileApprovalTargetPath(token: string) {
  return path.join(os.homedir(), `.openclaw-qa-codex-file-approval-${token.toLowerCase()}.txt`);
}

function buildCodexApprovalInstruction(params: {
  appServerMethod: SlackQaCodexApprovalMethod;
  token: string;
}) {
  if (params.appServerMethod === "item/commandExecution/requestApproval") {
    return [
      "Slack QA Codex command approval scenario.",
      `Marker: ${params.token}`,
      "Use the shell tool exactly once and request approval before running it.",
      `Run exactly: printf '${params.token}\\n'`,
      `After the command succeeds, reply exactly ${params.token} and nothing else.`,
    ].join("\n");
  }
  const targetPath = resolveCodexFileApprovalTargetPath(params.token);
  return [
    "Slack QA Codex file approval scenario.",
    `Marker: ${params.token}`,
    "Use apply_patch exactly once to create this file outside the workspace.",
    `Target file: ${targetPath}`,
    `File contents: ${params.token}`,
    "Invoke apply_patch now. Do not ask for approval in chat; the harness will resolve the native tool approval.",
    `After the file change succeeds, reply exactly ${params.token} and nothing else.`,
  ].join("\n");
}

function readAcceptedAgentRunId(result: unknown) {
  const started =
    typeof result === "object" && result !== null
      ? (result as { runId?: unknown; status?: unknown })
      : null;
  if (started?.status !== "accepted") {
    throw new Error(
      `Codex agent run status was ${formatApprovalResultValue(started?.status)} instead of accepted`,
    );
  }
  if (typeof started.runId !== "string" || started.runId.trim().length === 0) {
    throw new Error(`Codex agent run id was ${formatApprovalResultValue(started.runId)}`);
  }
  return started.runId;
}

function readAgentWaitStatus(result: unknown) {
  if (typeof result !== "object" || result === null) {
    return "unknown";
  }
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" && status.trim() ? status : "unknown";
}

export async function waitForSlackReaction(params: {
  channelId: string;
  client: WebClient;
  expectedReactionName: string;
  messageId: string;
  sutUserId: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (true) {
    const reactions = await listSlackReactions(params.channelId, params.messageId, {
      client: params.client,
    });
    const reaction = reactions?.find(
      (entry) =>
        entry.name === params.expectedReactionName && entry.users?.includes(params.sutUserId),
    );
    if (reaction) {
      return reaction;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    `Slack message ${params.messageId} did not receive ${params.expectedReactionName} from ${params.sutUserId}`,
  );
}

function assertCodexApprovalTranscriptSucceeded(
  messages: unknown,
  run: SlackQaCodexApprovalScenarioRun,
) {
  const records = Array.isArray(messages) ? messages.map(asPlainRecord) : [];
  const assistantReply = records
    .toReversed()
    .find((message) => message.role === "assistant" && extractGatewayMessageText(message));
  if (!assistantReply || extractGatewayMessageText(assistantReply) !== run.token) {
    throw new Error(`Codex approval run did not finish with assistant marker ${run.token}`);
  }
  if (run.appServerMethod !== "item/commandExecution/requestApproval") {
    return;
  }
  const commandSucceeded = records.some((message) => {
    if (message.role !== "toolResult" || message.isError === true) {
      return false;
    }
    return extractGatewayMessageText(message)
      .split(/\r?\n/u)
      .some((line) => line.trim() === run.token);
  });
  if (!commandSucceeded) {
    throw new Error(`Codex command result did not contain marker ${run.token}`);
  }
}

export async function assertCodexApprovalOperationSucceeded(params: {
  context: Omit<SlackQaScenarioContext, "sentTs">;
  run: SlackQaCodexApprovalScenarioRun;
  sessionKey: string;
}) {
  const history = asPlainRecord(
    await params.context.gateway.call(
      "chat.history",
      { sessionKey: params.sessionKey, limit: 24 },
      { timeoutMs: 10_000 },
    ),
  );
  assertCodexApprovalTranscriptSucceeded(history.messages, params.run);
  if (params.run.appServerMethod !== "item/fileChange/requestApproval") {
    return;
  }
  const targetPath = resolveCodexFileApprovalTargetPath(params.run.token);
  const contents = await fs.readFile(targetPath, "utf8");
  if (contents.trim() !== params.run.token) {
    throw new Error(`Codex file result at ${targetPath} did not contain the expected marker`);
  }
}

function findPendingCodexPluginApprovalRecord(params: {
  approvalId: string;
  appServerMethod: SlackQaCodexApprovalMethod;
  channelId: string;
  records: unknown;
  sessionKey: string;
  sutAccountId: string;
}) {
  const list = Array.isArray(params.records) ? params.records : [];
  const expectedTitle =
    params.appServerMethod === "item/commandExecution/requestApproval"
      ? "Codex app-server command approval"
      : "Codex app-server file approval";
  const expectedToolName =
    params.appServerMethod === "item/commandExecution/requestApproval"
      ? "codex_command_approval"
      : "codex_file_approval";
  for (const entry of list) {
    const record = asPlainRecord(entry);
    if (record.id !== params.approvalId) {
      continue;
    }
    const request = asPlainRecord(record.request);
    if (
      request.pluginId === "openclaw-codex-app-server" &&
      request.title === expectedTitle &&
      request.toolName === expectedToolName &&
      request.sessionKey === params.sessionKey &&
      request.turnSourceChannel === "slack" &&
      request.turnSourceTo === `channel:${params.channelId}` &&
      request.turnSourceAccountId === params.sutAccountId
    ) {
      return record;
    }
  }
  return undefined;
}

export async function assertPendingCodexPluginApproval(params: {
  approvalId: string;
  appServerMethod: SlackQaCodexApprovalMethod;
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  sessionKey: string;
  sutAccountId: string;
}) {
  const records = await params.context.gateway.call(
    "plugin.approval.list",
    {},
    {
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
    },
  );
  const record = findPendingCodexPluginApprovalRecord({
    approvalId: params.approvalId,
    appServerMethod: params.appServerMethod,
    channelId: params.channelId,
    records,
    sessionKey: params.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  if (!record) {
    throw new Error(
      `Pending Codex plugin approval ${params.approvalId} did not match the expected app-server route and Slack turn source.`,
    );
  }
}

export async function startCodexApprovalAgentRun(params: {
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  runId: string;
  scenario: SlackQaScenarioDefinition;
  sessionKey: string;
  sutAccountId: string;
}) {
  const result = await params.context.gateway.call(
    "agent",
    {
      accountId: params.sutAccountId,
      agentId: "qa",
      channel: "slack",
      cleanupBundleMcpOnRunEnd: true,
      deliver: false,
      idempotencyKey: params.runId,
      message: buildCodexApprovalInstruction({
        appServerMethod: params.run.appServerMethod,
        token: params.run.token,
      }),
      model: params.primaryModel,
      sessionKey: params.sessionKey,
      thinking: "low",
      timeout: Math.ceil(params.scenario.timeoutMs / 1_000),
      to: `channel:${params.channelId}`,
    },
    {
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
  const acceptedRunId = readAcceptedAgentRunId(result);
  if (acceptedRunId !== params.runId) {
    throw new Error(`Codex agent run id was ${acceptedRunId} instead of ${params.runId}`);
  }
}

export function buildCodexApprovalSessionKey(params: {
  scenario: SlackQaScenarioDefinition;
  token: string;
}) {
  return `agent:qa:${params.scenario.id}-${params.token.toLowerCase()}`;
}

export async function waitForCodexApprovalAgentRun(params: {
  context: Omit<SlackQaScenarioContext, "sentTs">;
  runId: string;
  timeoutMs: number;
}) {
  const result = await params.context.gateway.call(
    "agent.wait",
    {
      runId: params.runId,
      timeoutMs: params.timeoutMs,
    },
    {
      timeoutMs: params.timeoutMs + 5_000,
    },
  );
  return readAgentWaitStatus(result);
}

export async function quiesceCodexApprovalAgentRun(params: {
  context: Omit<SlackQaScenarioContext, "sentTs">;
  preserveDebugArtifacts: boolean;
  runId: string;
  sessionKey: string;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
}) {
  try {
    await params.context.gateway.call(
      "chat.abort",
      { runId: params.runId, sessionKey: params.sessionKey },
      { timeoutMs: 10_000 },
    );
  } catch {
    // The bounded terminal wait and gateway process-group teardown do not depend on this ack.
  }
  try {
    await params.context.gateway.call(
      "agent.wait",
      { runId: params.runId, timeoutMs: 10_000 },
      { timeoutMs: 15_000 },
    );
  } catch {
    // QA-owned Codex app-server processes inherit the gateway cleanup process group.
  }
  await params.stopGateway(params.preserveDebugArtifacts);
}
