// QA Lab Slack scenario reply observation and channel readiness.
import type { WebClient } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { startQaGatewayChild } from "../../gateway-child.js";
import {
  type SlackChannelStatus,
  type SlackChannelReadinessMode,
  SLACK_QA_DEFAULT_READY_TIMEOUT_MS,
  SLACK_QA_READY_STABILITY_MS,
  type SlackAuthIdentity,
  type SlackObservedMessage,
  type SlackMessage,
} from "./slack-live.contracts.js";
import {
  listSlackMessages,
  listSlackThreadMessages,
  collectSlackBlockText,
  collectSlackActionValues,
  isSutSlackMessage,
} from "./slack-live.observations.js";

type SlackScenarioObservationContext = {
  channelId: string;
  matchText: string;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
};

function recordSlackScenarioMessages(
  params: SlackScenarioObservationContext & { messages: SlackMessage[] },
) {
  let matchedMessage: SlackMessage | undefined;
  for (const message of params.messages) {
    const text = message.text ?? "";
    if (
      !message.ts ||
      message.ts === params.sentTs ||
      !isSutSlackMessage(message, params.sutIdentity)
    ) {
      continue;
    }
    const matchedScenario = text.includes(params.matchText);
    params.observedMessages.push({
      actionValues: collectSlackActionValues(message.blocks),
      blockText: collectSlackBlockText(message.blocks),
      botId: message.bot_id,
      channelId: params.channelId,
      matchedScenario,
      scenarioId: params.observationScenarioId,
      scenarioTitle: params.observationScenarioTitle,
      text,
      threadTs: message.thread_ts,
      ts: message.ts,
      userId: message.user,
    });
    if (matchedScenario && !matchedMessage) {
      matchedMessage = message;
    }
  }
  return matchedMessage;
}

export async function waitForSlackScenarioReply(
  params: SlackScenarioObservationContext & {
    client: WebClient;
    threadTs?: string;
    timeoutMs: number;
  },
) {
  const observationContext: SlackScenarioObservationContext = params;
  const startedAt = Date.now();
  const inspectMessages = (messages: SlackMessage[]) => {
    const matchedMessage = recordSlackScenarioMessages({ ...observationContext, messages });
    return matchedMessage
      ? { message: matchedMessage, observedAt: new Date().toISOString() }
      : undefined;
  };

  while (Date.now() - startedAt < params.timeoutMs) {
    const channelMessages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.sentTs,
    });
    const channelReply = inspectMessages(channelMessages);
    if (channelReply) {
      return channelReply;
    }

    try {
      const threadMessages = await listSlackThreadMessages({
        channelId: params.channelId,
        client: params.client,
        threadTs: params.threadTs ?? params.sentTs,
      });
      const threadReply = inspectMessages(threadMessages);
      if (threadReply) {
        return threadReply;
      }
    } catch (error) {
      throw new Error(
        `Slack conversations.replies failed while waiting for ${params.observationScenarioId}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Slack message`);
}

export async function observeSlackScenarioMessages(
  params: SlackScenarioObservationContext & {
    client: WebClient;
    settleMs: number;
    threadTs?: string;
  },
) {
  const observationContext: SlackScenarioObservationContext = params;
  const startedAt = Date.now();

  while (true) {
    recordSlackScenarioMessages({
      ...observationContext,
      messages: await listSlackMessages({
        channelId: params.channelId,
        client: params.client,
        oldestTs: params.sentTs,
      }),
    });
    try {
      recordSlackScenarioMessages({
        ...observationContext,
        messages: await listSlackThreadMessages({
          channelId: params.channelId,
          client: params.client,
          threadTs: params.threadTs ?? params.sentTs,
        }),
      });
    } catch (error) {
      throw new Error(
        `Slack conversations.replies failed while settling ${params.observationScenarioId}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    const remainingMs = params.settleMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(1_000, remainingMs));
    });
  }
}

export async function waitForSlackNoReply(params: {
  channelId: string;
  client: WebClient;
  matchText: string;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  const observedKeys = new Set(
    params.observedMessages
      .map((message) => `${message.channelId ?? params.channelId}:${message.ts ?? ""}`)
      .filter((key) => !key.endsWith(":")),
  );
  let elapsedMs = Date.now() - startedAt;
  while (elapsedMs < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.sentTs,
    });
    for (const message of messages) {
      const text = message.text ?? "";
      if (
        !message.ts ||
        message.ts === params.sentTs ||
        !isSutSlackMessage(message, params.sutIdentity)
      ) {
        continue;
      }
      const matchedScenario = text.includes(params.matchText);
      const observedKey = `${params.channelId}:${message.ts}`;
      if (!observedKeys.has(observedKey)) {
        observedKeys.add(observedKey);
        params.observedMessages.push({
          actionValues: collectSlackActionValues(message.blocks),
          blockText: collectSlackBlockText(message.blocks),
          botId: message.bot_id,
          channelId: params.channelId,
          matchedScenario,
          scenarioId: params.observationScenarioId,
          scenarioTitle: params.observationScenarioTitle,
          text,
          threadTs: message.thread_ts,
          ts: message.ts,
          userId: message.user,
        });
      }
      if (matchedScenario) {
        throw new Error("unexpected Slack SUT reply observed");
      }
    }
    elapsedMs = Date.now() - startedAt;
    const remainingMs = params.timeoutMs - elapsedMs;
    if (remainingMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(1_000, remainingMs));
      });
    }
    elapsedMs = Date.now() - startedAt;
  }
}

async function waitForSlackChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
  mode: SlackChannelReadinessMode,
): Promise<SlackChannelStatus> {
  const startedAt = Date.now();
  const timeoutMs = resolveSlackQaReadyTimeoutMs();
  let lastStatus: SlackChannelStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string | null;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.slack ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            connected: match.connected,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
            restartPending: match.restartPending,
            running: match.running,
          }
        : undefined;
      if (isSlackChannelReadyForQa(lastStatus, mode)) {
        if (!lastStatus) {
          throw new Error(`slack account "${accountId}" status disappeared after readiness check`);
        }
        return lastStatus;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(
    `slack account "${accountId}" did not become ready` +
      (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : ""),
  );
}

export async function waitForSlackChannelStable(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
  mode: SlackChannelReadinessMode,
) {
  const startedAt = Date.now();
  const timeoutMs = resolveSlackQaReadyTimeoutMs();
  let readySince: number | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const status = await waitForSlackChannelRunning(gateway, accountId, mode);
    const observedAt = Date.now();
    readySince = resolveSlackChannelReadySince({
      observedAt,
      previousReadySince: readySince,
      status,
    });
    const readyForMs = observedAt - readySince;
    if (readyForMs >= SLACK_QA_READY_STABILITY_MS) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(500, SLACK_QA_READY_STABILITY_MS - readyForMs));
    });
  }
  throw new Error(
    `slack account "${accountId}" did not remain ready for ${SLACK_QA_READY_STABILITY_MS}ms`,
  );
}

function isSlackChannelReadyForQa(
  status: SlackChannelStatus | undefined,
  mode: SlackChannelReadinessMode,
): boolean {
  if (
    !status?.running ||
    status.restartPending === true ||
    status.lastError != null ||
    status.connected === false
  ) {
    return false;
  }
  return mode === "started" || status.connected === true;
}

function resolveSlackChannelReadySince(params: {
  observedAt: number;
  previousReadySince: number | undefined;
  status: SlackChannelStatus;
}): number {
  if (typeof params.status.lastConnectedAt === "number" && params.status.lastConnectedAt > 0) {
    return params.status.lastConnectedAt;
  }
  return params.previousReadySince ?? params.observedAt;
}

function resolveSlackQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  if (!raw) {
    return SLACK_QA_DEFAULT_READY_TIMEOUT_MS;
  }
  return parseStrictPositiveInteger(raw) ?? SLACK_QA_DEFAULT_READY_TIMEOUT_MS;
}
