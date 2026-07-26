// QA Lab Slack Web API and stored-message observations.
import { isDeepStrictEqual } from "node:util";
import { createSlackWebClient, sendSlackMessage } from "@openclaw/slack/api.js";
import type { WebClient } from "@slack/web-api";
import {
  asPlainRecord,
  countSlackNativeDataBlocks,
  instrumentSlackPostMessage,
} from "./slack-live.config.js";
import {
  SLACK_QA_NATIVE_CHART,
  SLACK_QA_NATIVE_TABLE,
  type SlackQaApprovalDecision,
  SLACK_QA_APPROVAL_ACTION_PREFIX,
  SlackQaApprovalActionValueSchema,
  type SlackQaDirectTransportScenarioContext,
  type SlackQaDirectTransportScenarioResult,
  type SlackAuthIdentity,
  type SlackApprovalCheckpointMessage,
  SLACK_QA_WEB_API_TIMEOUT_MS,
  slackAuthTestSchema,
  slackPostMessageSchema,
  type SlackMessage,
  slackHistorySchema,
  slackRepliesSchema,
} from "./slack-live.contracts.js";
import { buildSlackInvalidBlocksTableProbe } from "./slack-live.invalid-blocks.js";

export async function getSlackIdentity(token: string): Promise<SlackAuthIdentity> {
  const client = createSlackWebClient(token, { timeout: SLACK_QA_WEB_API_TIMEOUT_MS });
  const auth = slackAuthTestSchema.parse(await client.auth.test());
  if (!auth.user_id) {
    throw new Error("Slack auth.test did not return user_id.");
  }
  return {
    userId: auth.user_id,
    botId: auth.bot_id,
    teamId: auth.team_id,
  };
}

export async function sendSlackChannelMessage(params: {
  channelId: string;
  client: WebClient;
  text: string;
  threadTs?: string;
}) {
  const postSlackMessage = params.client.chat.postMessage.bind(params.client.chat);
  const sent = slackPostMessageSchema.parse(
    await postSlackMessage({
      channel: params.channelId,
      text: params.text,
      thread_ts: params.threadTs,
      unfurl_links: false,
      unfurl_media: false,
    }),
  );
  return {
    channelId: sent.channel ?? params.channelId,
    ts: sent.ts,
  };
}

export async function listSlackMessages(params: {
  channelId: string;
  client: WebClient;
  oldestTs: string;
}) {
  const history = slackHistorySchema.parse(
    await params.client.conversations.history({
      channel: params.channelId,
      inclusive: true,
      limit: 50,
      oldest: params.oldestTs,
    }),
  );
  return history.messages ?? [];
}

export async function listSlackThreadMessages(params: {
  channelId: string;
  client: WebClient;
  threadTs: string;
}) {
  const replies = slackRepliesSchema.parse(
    await params.client.conversations.replies({
      channel: params.channelId,
      inclusive: true,
      limit: 50,
      ts: params.threadTs,
    }),
  );
  return replies.messages ?? [];
}

function collectSlackBlockStringFields(
  value: unknown,
  fieldName: string,
  values: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSlackBlockStringFields(entry, fieldName, values);
    }
    return values;
  }
  if (!value || typeof value !== "object") {
    return values;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === fieldName && typeof entry === "string" && entry.trim().length > 0) {
      values.push(entry);
      continue;
    }
    collectSlackBlockStringFields(entry, fieldName, values);
  }
  return values;
}

export function collectSlackBlockText(blocks?: unknown[]) {
  return collectSlackBlockStringFields(blocks ?? [], "text");
}

export function collectSlackActionValues(blocks?: unknown[]) {
  return collectSlackBlockStringFields(blocks ?? [], "value");
}

export function parseSlackNativeApprovalAction(value: string) {
  if (!value.startsWith(SLACK_QA_APPROVAL_ACTION_PREFIX)) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(value.slice(SLACK_QA_APPROVAL_ACTION_PREFIX.length));
    const parsed = SlackQaApprovalActionValueSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function collectSlackButtonLabels(blocks?: unknown[]) {
  const labels: string[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.type === "button") {
      const text = candidate.text;
      if (text && typeof text === "object") {
        const label = (text as { text?: unknown }).text;
        if (typeof label === "string" && label.trim().length > 0) {
          labels.push(label);
        }
      }
    }
    for (const entry of Object.values(candidate)) {
      visit(entry);
    }
  }
  visit(blocks ?? []);
  return labels;
}

export function buildSlackApprovalCheckpointMessage(
  message: SlackMessage,
): SlackApprovalCheckpointMessage {
  const actionValues = collectSlackActionValues(message.blocks);
  return {
    actionLabels: collectSlackButtonLabels(message.blocks),
    blockText: collectSlackBlockText(message.blocks),
    hasNativeActions: actionValues.some((value) => parseSlackNativeApprovalAction(value)),
    text: message.text ?? "",
  };
}

export function hasSlackNativeApprovalActions(params: {
  actionValues: string[];
  approvalId?: string;
  decision: SlackQaApprovalDecision;
}) {
  return params.actionValues.some((value) => {
    const action = parseSlackNativeApprovalAction(value);
    return (
      action?.decision === params.decision &&
      (!params.approvalId || action.approvalId === params.approvalId)
    );
  });
}

export function extractSlackNativeApprovalId(params: {
  actionValues: string[];
  decision: SlackQaApprovalDecision;
}) {
  for (const value of params.actionValues) {
    const action = parseSlackNativeApprovalAction(value);
    if (action?.decision === params.decision) {
      return action.approvalId;
    }
  }
  return undefined;
}

export function isSutSlackMessage(message: SlackMessage, sutIdentity: SlackAuthIdentity) {
  return (
    (message.user !== undefined && message.user === sutIdentity.userId) ||
    (message.bot_id !== undefined && message.bot_id === sutIdentity.botId)
  );
}

// Slack history can flatten top-level accessibility newlines on readback.
// Normalize only whitespace; the native chart structure stays byte-for-byte strict below.
function normalizeSlackAccessibleText(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

export function isExpectedSlackNativeChartMessage(
  message: SlackMessage,
  expectedAccessibleText: string,
) {
  if (
    normalizeSlackAccessibleText(message.text ?? "") !==
    normalizeSlackAccessibleText(expectedAccessibleText)
  ) {
    return false;
  }
  return (message.blocks ?? []).some((value) => {
    const block = asPlainRecord(value);
    return isDeepStrictEqual(
      { type: block.type, title: block.title, chart: block.chart },
      SLACK_QA_NATIVE_CHART,
    );
  });
}

export async function waitForSlackStoredMessage(params: {
  channelId: string;
  client: WebClient;
  description: string;
  matchesMessage: (message: SlackMessage) => boolean;
  oldestTs: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (true) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.oldestTs,
    });
    const message = messages.find(
      (entry) =>
        entry.ts !== params.oldestTs &&
        isSutSlackMessage(entry, params.sutIdentity) &&
        params.matchesMessage(entry),
    );
    if (message) {
      return message;
    }
    const remainingMs = params.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(1_000, remainingMs));
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Slack ${params.description}`);
}

export function isExpectedSlackNativeTableMessage(
  message: SlackMessage,
  expectedAccessibleText: string,
) {
  if (
    normalizeSlackAccessibleText(message.text ?? "") !==
    normalizeSlackAccessibleText(expectedAccessibleText)
  ) {
    return false;
  }
  return (message.blocks ?? []).some((value) => {
    const block = asPlainRecord(value);
    return isDeepStrictEqual(
      {
        type: block.type,
        caption: block.caption,
        rows: block.rows,
        row_header_column_index: block.row_header_column_index,
      },
      SLACK_QA_NATIVE_TABLE,
    );
  });
}

export async function runSlackTableInvalidBlocksFallbackScenario(
  context: SlackQaDirectTransportScenarioContext,
): Promise<SlackQaDirectTransportScenarioResult> {
  const probe = buildSlackInvalidBlocksTableProbe();
  const oldestTs = ((Date.now() - 5_000) / 1_000).toFixed(6);
  const instrumentation = instrumentSlackPostMessage(context.sutWriteClient);
  let sent: Awaited<ReturnType<typeof sendSlackMessage>>;
  try {
    try {
      sent = await sendSlackMessage(`channel:${context.channelId}`, probe.summaryText, {
        accountId: context.sutAccountId,
        blocks: [probe.block] as never,
        cfg: context.cfg,
        client: context.sutWriteClient,
        nativeDataFallbackBaseText: probe.summaryText,
      });
    } catch {
      const [nativeAttempt, fallbackAttempt] = instrumentation.attempts;
      if (nativeAttempt?.failureCode !== "invalid_blocks") {
        throw new Error(
          `expected first Slack API failure code invalid_blocks; observed ${nativeAttempt?.failureCode ?? "none"}`,
        );
      }
      throw new Error(
        `Slack fallback failed after invalid_blocks; observed ${fallbackAttempt?.failureCode ?? "no fallback API failure code"}`,
      );
    }
  } finally {
    instrumentation.restore();
  }

  const [nativeAttempt, fallbackAttempt] = instrumentation.attempts;
  if (instrumentation.attempts.length !== 2) {
    throw new Error(
      `expected exactly two Slack API attempts; observed ${instrumentation.attempts.length}`,
    );
  }
  if (
    nativeAttempt?.status !== "failed" ||
    nativeAttempt.failureCode !== "invalid_blocks" ||
    nativeAttempt.nativeDataBlockCount !== 1
  ) {
    throw new Error(
      `expected first Slack API attempt to fail with invalid_blocks for one native data block; observed ${nativeAttempt?.failureCode ?? "none"}`,
    );
  }
  if (
    fallbackAttempt?.status !== "sent" ||
    fallbackAttempt.nativeDataBlockCount !== 0 ||
    !fallbackAttempt.formattingDisabled
  ) {
    throw new Error("Slack fallback did not use one formatting-disabled blockless API request");
  }

  const message = await waitForSlackStoredMessage({
    channelId: context.channelId,
    client: context.sutReadClient,
    description: "stored invalid_blocks fallback message",
    matchesMessage: (candidate) => candidate.ts === sent.messageId,
    oldestTs,
    sutIdentity: context.sutIdentity,
    timeoutMs: context.timeoutMs,
  });
  const storedText = message.text ?? "";
  if (countSlackNativeDataBlocks(message.blocks) !== 0) {
    throw new Error("stored Slack fallback retained a native data block");
  }
  const storedLines = storedText.split("\n");
  if (!storedLines.includes(probe.firstRowText)) {
    throw new Error("stored Slack fallback omitted the exact first data row");
  }
  if (!storedLines.includes(probe.finalRowText)) {
    throw new Error("stored Slack fallback omitted the exact final data row");
  }
  if (storedText !== probe.fallbackText) {
    throw new Error(
      `stored Slack fallback was incomplete: expected ${probe.fallbackText.length} characters, observed ${storedText.length}`,
    );
  }
  return {
    details: [
      "direct transport",
      "first API failure=invalid_blocks",
      "API attempts=2",
      `data rows=${probe.dataRowCount}`,
      "fallback formatting disabled=true",
      "stored native data blocks=0",
      "first row=present",
      "final row=present",
      "complete delivery=true",
    ].join("; "),
    message,
  };
}
