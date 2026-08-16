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

const SLACK_QA_TEXT_DIAGNOSTIC_MAX_CHARS = 500;

function describeSlackObservedText(value: string) {
  const preview = value.slice(0, SLACK_QA_TEXT_DIAGNOSTIC_MAX_CHARS);
  return `${value.length} characters; actual=${JSON.stringify(preview)}${
    preview.length < value.length ? "…" : ""
  }`;
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

async function waitForSlackStoredMessages(params: {
  channelId: string;
  client: WebClient;
  description: string;
  messageIds: readonly string[];
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
    const messagesById = new Map(
      messages
        .filter((message) => message.ts && isSutSlackMessage(message, params.sutIdentity))
        .map((message) => [message.ts as string, message]),
    );
    if (params.messageIds.every((messageId) => messagesById.has(messageId))) {
      return params.messageIds.map((messageId) => messagesById.get(messageId) as SlackMessage);
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
  const originalPostMessage = context.sutWriteClient.chat.postMessage;
  let rejectedNativeData = false;
  context.sutWriteClient.chat.postMessage = (async (payload) => {
    const payloadRecord = payload as { blocks?: unknown };
    if (!rejectedNativeData && countSlackNativeDataBlocks(payloadRecord.blocks) > 0) {
      rejectedNativeData = true;
      throw Object.assign(new Error("Slack API error: invalid_blocks"), {
        data: { error: "invalid_blocks", ok: false },
      });
    }
    return originalPostMessage.call(context.sutWriteClient.chat, payload);
  }) as typeof context.sutWriteClient.chat.postMessage;
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
      const [nativeAttempt, ...fallbackAttempts] = instrumentation.attempts;
      if (nativeAttempt?.failureCode !== "invalid_blocks") {
        throw new Error(
          `expected first Slack API failure code invalid_blocks; observed ${nativeAttempt?.failureCode ?? "none"}`,
        );
      }
      const failedPartIndex = fallbackAttempts.findIndex((attempt) => attempt.status === "failed");
      const failedAttempt = failedPartIndex >= 0 ? fallbackAttempts[failedPartIndex] : undefined;
      const failedPart = failedPartIndex >= 0 ? String(failedPartIndex + 1) : "unknown";
      throw new Error(
        `Slack fallback part ${failedPart} failed after invalid_blocks; observed ${failedAttempt?.failureCode ?? "no fallback API failure code"}`,
      );
    }
  } finally {
    instrumentation.restore();
    context.sutWriteClient.chat.postMessage = originalPostMessage;
  }

  const [nativeAttempt, ...fallbackAttempts] = instrumentation.attempts;
  const receiptMessageIds = sent.receipt.platformMessageIds;
  if (receiptMessageIds.length < 2) {
    throw new Error(
      "Slack oversized fallback receipt did not retain multiple platform message IDs",
    );
  }
  if (new Set(receiptMessageIds).size !== receiptMessageIds.length) {
    throw new Error("Slack fallback receipt retained duplicate platform message IDs");
  }
  if (
    sent.receipt.primaryPlatformMessageId !== receiptMessageIds[0] ||
    sent.messageId !== receiptMessageIds.at(-1)
  ) {
    throw new Error("Slack fallback receipt did not preserve first-primary and final-message IDs");
  }
  if (instrumentation.attempts.length !== receiptMessageIds.length + 1) {
    throw new Error(
      `expected one rejected native attempt plus ${receiptMessageIds.length} fallback receipt parts; observed ${instrumentation.attempts.length} Slack API attempts`,
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
    fallbackAttempts.some(
      (attempt) =>
        attempt.status !== "sent" ||
        attempt.nativeDataBlockCount !== 0 ||
        !attempt.formattingDisabled,
    )
  ) {
    throw new Error("Slack fallback did not use formatting-disabled blockless API requests");
  }
  const attemptedFallbackText = fallbackAttempts.map((attempt) => attempt.text).join("");
  if (attemptedFallbackText !== probe.fallbackText) {
    throw new Error(
      `Slack fallback API requests were incomplete: expected ${probe.fallbackText.length} characters, observed ${describeSlackObservedText(attemptedFallbackText)}`,
    );
  }

  const messages = await waitForSlackStoredMessages({
    channelId: context.channelId,
    client: context.sutReadClient,
    description: "stored invalid_blocks fallback messages",
    messageIds: receiptMessageIds,
    oldestTs,
    sutIdentity: context.sutIdentity,
    timeoutMs: context.timeoutMs,
  });
  if (messages.some((message) => countSlackNativeDataBlocks(message.blocks) !== 0)) {
    throw new Error("stored Slack fallback retained a native data block");
  }
  const storedText = messages.map((message) => message.text ?? "").join("");
  const normalizedStoredText = normalizeSlackAccessibleText(storedText);
  if (!normalizedStoredText.includes(normalizeSlackAccessibleText(probe.firstRowText))) {
    throw new Error(
      `stored Slack fallback omitted the first data row: ${describeSlackObservedText(storedText)}`,
    );
  }
  if (!normalizedStoredText.includes(normalizeSlackAccessibleText(probe.finalRowText))) {
    throw new Error(
      `stored Slack fallback omitted the final data row: ${describeSlackObservedText(storedText)}`,
    );
  }
  if (normalizedStoredText !== normalizeSlackAccessibleText(probe.fallbackText)) {
    throw new Error(
      `stored Slack fallback was incomplete: expected ${probe.fallbackText.length} characters, observed ${describeSlackObservedText(storedText)}`,
    );
  }
  const message = messages.at(-1);
  if (!message) {
    throw new Error("Slack fallback receipt had no stored message");
  }
  return {
    details: [
      "direct transport",
      "first API failure=invalid_blocks",
      `API attempts=${instrumentation.attempts.length}`,
      `fallback chunks=${receiptMessageIds.length}`,
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
