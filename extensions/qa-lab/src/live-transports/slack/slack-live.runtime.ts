import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSlackWebClient, createSlackWriteClient } from "@openclaw/slack/api.js";
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { z } from "zod";
import { startQaGatewayChild } from "../../gateway-child.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
  type QaCredentialRole,
} from "../shared/credential-lease.runtime.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import { appendLiveLaneIssue, buildLiveLaneArtifactsError } from "../shared/live-lane-helpers.js";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../shared/live-transport-scenarios.js";

type SlackQaRuntimeEnv = {
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutAppToken: string;
};

type SlackQaScenarioId =
  | "slack-allowlist-block"
  | "slack-canary"
  | "slack-mention-gating"
  | "slack-restart-resume"
  | "slack-thread-follow-up"
  | "slack-thread-isolation"
  | "slack-top-level-reply-shape";

type SlackQaScenarioRun = {
  expectReply: boolean;
  input: string;
  matchText: string;
  verify?: (message: SlackMessage, context: { requestThreadTs: string; sentTs: string }) => void;
  beforeRun?: (context: Omit<SlackQaScenarioContext, "sentTs">) => Promise<SlackQaBeforeRunResult>;
  afterReply?: (message: SlackMessage, context: SlackQaScenarioContext) => Promise<string | void>;
};

type SlackQaBeforeRunResult =
  | string
  | void
  | {
      details?: string;
      inputThreadTs?: string;
    };

type SlackQaConfigOverrides = {
  replyToMode?: "all" | "off";
  users?: string[];
};

type SlackQaScenarioContext = {
  channelId: string;
  driverClient: WebClient;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  postSlackMessage: (params: { text: string; threadTs?: string }) => Promise<{ ts: string }>;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  waitForReady: () => Promise<void>;
};

type SlackQaScenarioDefinition = LiveTransportScenarioDefinition<SlackQaScenarioId> & {
  buildRun: (sutUserId: string) => SlackQaScenarioRun;
  configOverrides?: SlackQaConfigOverrides;
};

type SlackAuthIdentity = {
  botId?: string;
  teamId?: string;
  userId: string;
};

type SlackMessage = {
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

type SlackObservedMessage = {
  botId?: string;
  channelId: string;
  matchedScenario?: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
  text: string;
  threadTs?: string;
  ts: string;
  userId?: string;
};

type SlackObservedMessageArtifact = {
  botId?: string;
  channelId?: string;
  matchedScenario?: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
  text?: string;
  threadTs?: string;
  ts?: string;
  userId?: string;
};

type SlackQaScenarioResult = {
  details: string;
  id: string;
  requestStartedAt?: string;
  responseObservedAt?: string;
  rttMs?: number;
  status: "fail" | "pass";
  title: string;
};

export type SlackQaRunResult = {
  gatewayDebugDirPath?: string;
  observedMessagesPath: string;
  outputDir: string;
  reportPath: string;
  scenarios: SlackQaScenarioResult[];
  summaryPath: string;
};

type SlackQaSummary = {
  channelId: string;
  cleanupIssues: string[];
  counts: {
    failed: number;
    passed: number;
    total: number;
  };
  credentials: {
    credentialId?: string;
    kind: string;
    ownerId?: string;
    role?: QaCredentialRole;
    source: "convex" | "env";
  };
  finishedAt: string;
  scenarios: SlackQaScenarioResult[];
  startedAt: string;
};

type SlackCredentialLease = Awaited<ReturnType<typeof acquireQaCredentialLease<SlackQaRuntimeEnv>>>;
type SlackCredentialHeartbeat = ReturnType<typeof startQaCredentialLeaseHeartbeat>;

const SLACK_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_SLACK_CAPTURE_CONTENT";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";
const SLACK_QA_WEB_API_TIMEOUT_MS = 45_000;
const SLACK_QA_ENV_KEYS = [
  "OPENCLAW_QA_SLACK_CHANNEL_ID",
  "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_APP_TOKEN",
] as const;

const slackQaCredentialPayloadSchema = z.object({
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutAppToken: z.string().trim().min(1),
});

const slackAuthTestSchema = z.object({
  ok: z.boolean().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
  team_id: z.string().optional(),
});

const slackPostMessageSchema = z.object({
  ok: z.boolean().optional(),
  channel: z.string().optional(),
  ts: z.string().min(1),
});

const slackHistoryMessageSchema = z.object({
  bot_id: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string().min(1),
  user: z.string().optional(),
});

const slackHistorySchema = z.object({
  ok: z.boolean().optional(),
  messages: z.array(slackHistoryMessageSchema).optional(),
});

const slackRepliesSchema = z.object({
  ok: z.boolean().optional(),
  messages: z.array(slackHistoryMessageSchema).optional(),
});

const SLACK_QA_SCENARIOS: SlackQaScenarioDefinition[] = [
  {
    id: "slack-canary",
    standardId: "canary",
    title: "Slack canary echo",
    timeoutMs: 45_000,
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
  {
    id: "slack-mention-gating",
    standardId: "mention-gating",
    title: "Slack unmentioned bot message does not trigger",
    timeoutMs: 8_000,
    buildRun: () => {
      const token = `SLACK_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: false,
        input: `reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
  {
    id: "slack-allowlist-block",
    standardId: "allowlist-block",
    title: "Slack non-allowlisted sender does not trigger",
    timeoutMs: 8_000,
    configOverrides: { users: ["U_OPENCLAW_QA_NEVER_ALLOWED"] },
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_BLOCK_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: false,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
  {
    id: "slack-top-level-reply-shape",
    standardId: "top-level-reply-shape",
    title: "Slack top-level reply stays top-level",
    timeoutMs: 45_000,
    configOverrides: { replyToMode: "off" },
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_TOPLEVEL_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
        verify: (message) => {
          if (message.thread_ts) {
            throw new Error(
              `expected top-level Slack reply without thread_ts; got ${message.thread_ts}`,
            );
          }
        },
      };
    },
  },
  {
    id: "slack-restart-resume",
    standardId: "restart-resume",
    title: "Slack replies after gateway restart",
    timeoutMs: 60_000,
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_RESTART_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
        afterReply: async (_message, context) => {
          const secondToken = `SLACK_QA_RESTART_AFTER_${randomUUID().slice(0, 8).toUpperCase()}`;
          await context.gateway.restart();
          await context.waitForReady();
          const sent = await sendSlackChannelMessage({
            channelId: context.channelId,
            client: context.driverClient,
            text: `<@${context.sutIdentity.userId}> reply with only this exact marker: ${secondToken}`,
          });
          await waitForSlackScenarioReply({
            channelId: context.channelId,
            client: context.sutReadClient,
            matchText: secondToken,
            observedMessages: [],
            observationScenarioId: "slack-restart-resume",
            observationScenarioTitle: "Slack replies after gateway restart",
            sentTs: sent.ts,
            sutIdentity: context.sutIdentity,
            timeoutMs: 45_000,
          });
          return `post-restart reply matched marker ${secondToken}`;
        },
      };
    },
  },
  {
    id: "slack-thread-follow-up",
    standardId: "thread-follow-up",
    title: "Slack threaded prompt receives threaded reply",
    timeoutMs: 45_000,
    configOverrides: { replyToMode: "all" },
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_THREAD_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
        beforeRun: async (context) => {
          const parent = await context.postSlackMessage({
            text: `thread-follow-up root for ${token}`,
          });
          return {
            details: `created thread root ${parent.ts}`,
            inputThreadTs: parent.ts,
          };
        },
        verify: (message, context) => {
          if (message.thread_ts !== context.requestThreadTs) {
            throw new Error(
              `expected threaded Slack reply thread_ts=${context.requestThreadTs}; got ${
                message.thread_ts ?? "<none>"
              }`,
            );
          }
        },
      };
    },
  },
  {
    id: "slack-thread-isolation",
    standardId: "thread-isolation",
    title: "Slack fresh top-level prompt stays out of previous thread",
    timeoutMs: 45_000,
    configOverrides: { replyToMode: "off" },
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_ISOLATION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
        beforeRun: async (context) => {
          const priorThreadToken = `SLACK_QA_PRIOR_THREAD_${randomUUID().slice(0, 8).toUpperCase()}`;
          const parent = await context.postSlackMessage({
            text: `prior thread root for ${priorThreadToken}`,
          });
          await context.postSlackMessage({
            text: `prior thread child for ${priorThreadToken}`,
            threadTs: parent.ts,
          });
          return `created unrelated prior thread ${parent.ts}`;
        },
        verify: (message) => {
          if (message.thread_ts) {
            throw new Error(
              `expected isolated top-level Slack reply; got thread_ts=${message.thread_ts}`,
            );
          }
        },
      };
    },
  },
];

const SLACK_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  scenarios: SLACK_QA_SCENARIOS,
});

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof SLACK_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function inferSlackCredentialSource(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "convex" | "env" {
  const normalized =
    value?.trim().toLowerCase() || env.OPENCLAW_QA_CREDENTIAL_SOURCE?.trim().toLowerCase();
  return normalized === "convex" ? "convex" : "env";
}

function inferSlackCredentialRole(value: string | undefined): QaCredentialRole | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "ci" || normalized === "maintainer") {
    return normalized;
  }
  return undefined;
}

function normalizeSlackId(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a Slack id like C123 or U123.`);
  }
  return normalized;
}

function validateSlackQaRuntimeEnv(runtimeEnv: SlackQaRuntimeEnv, label: string) {
  normalizeSlackId(runtimeEnv.channelId, `${label} channelId`);
  return runtimeEnv;
}

function resolveSlackQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): SlackQaRuntimeEnv {
  const runtimeEnv = {
    channelId: resolveEnvValue(env, "OPENCLAW_QA_SLACK_CHANNEL_ID"),
    driverBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN"),
    sutBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN"),
    sutAppToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_APP_TOKEN"),
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_SLACK");
}

function parseSlackQaCredentialPayload(payload: unknown): SlackQaRuntimeEnv {
  const parsed = slackQaCredentialPayloadSchema.parse(payload);
  const runtimeEnv = {
    channelId: parsed.channelId,
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutAppToken: parsed.sutAppToken,
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "Slack credential payload");
}

function findScenario(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Slack",
    scenarios: SLACK_QA_SCENARIOS,
  });
}

function buildSlackQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    channelId: string;
    driverBotUserId: string;
    overrides?: SlackQaConfigOverrides;
    sutAccountId: string;
    sutAppToken: string;
    sutBotToken: string;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "slack"])];
  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        slack: { enabled: true },
      },
    },
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      slack: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            mode: "socket",
            botToken: params.sutBotToken,
            appToken: params.sutAppToken,
            groupPolicy: "allowlist",
            allowBots: true,
            replyToMode: params.overrides?.replyToMode ?? "off",
            channels: {
              [params.channelId]: {
                enabled: true,
                requireMention: true,
                allowBots: true,
                users: params.overrides?.users ?? [params.driverBotUserId],
              },
            },
          },
        },
      },
    },
  };
}

async function getSlackIdentity(token: string): Promise<SlackAuthIdentity> {
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

async function sendSlackChannelMessage(params: {
  channelId: string;
  client: WebClient;
  text: string;
  threadTs?: string;
}) {
  const sendSlackMessage = params.client.chat.postMessage.bind(params.client.chat);
  const sent = slackPostMessageSchema.parse(
    await sendSlackMessage({
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

async function listSlackMessages(params: {
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

async function listSlackThreadMessages(params: {
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

function isSutSlackMessage(message: SlackMessage, sutIdentity: SlackAuthIdentity) {
  return (
    (message.user !== undefined && message.user === sutIdentity.userId) ||
    (message.bot_id !== undefined && message.bot_id === sutIdentity.botId)
  );
}

async function waitForSlackScenarioReply(params: {
  channelId: string;
  client: WebClient;
  matchText: string;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  sentTs: string;
  threadTs?: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  const inspectMessages = (messages: SlackMessage[]) => {
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
      params.observedMessages.push({
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
      if (matchedScenario) {
        return {
          message,
          observedAt: new Date().toISOString(),
        };
      }
    }
    return undefined;
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
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Slack message`);
}

async function waitForSlackNoReply(params: {
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
  while (Date.now() - startedAt < params.timeoutMs) {
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
      params.observedMessages.push({
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
      throw new Error("unexpected Slack SUT reply observed");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function waitForSlackChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
) {
  const startedAt = Date.now();
  let lastStatus:
    | {
        connected?: boolean;
        lastConnectedAt?: number;
        lastDisconnect?: unknown;
        lastError?: string;
        restartPending?: boolean;
        running?: boolean;
      }
    | undefined;
  while (Date.now() - startedAt < 45_000) {
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
            lastError?: string;
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
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `slack account "${accountId}" did not become ready` +
      (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : ""),
  );
}

function toObservedSlackArtifacts(params: {
  includeContent: boolean;
  messages: SlackObservedMessage[];
  redactMetadata: boolean;
}): SlackObservedMessageArtifact[] {
  return params.messages.map((message) => ({
    botId: params.redactMetadata ? undefined : message.botId,
    channelId: params.redactMetadata ? undefined : message.channelId,
    matchedScenario: message.matchedScenario,
    scenarioId: message.scenarioId,
    scenarioTitle: message.scenarioTitle,
    text: params.includeContent ? message.text : undefined,
    threadTs: params.redactMetadata ? undefined : message.threadTs,
    ts: params.redactMetadata ? undefined : message.ts,
    userId: params.redactMetadata ? undefined : message.userId,
  }));
}

function renderSlackQaMarkdown(params: {
  channelId: string;
  cleanupIssues: string[];
  credentialSource: "convex" | "env";
  finishedAt: string;
  gatewayDebugDirPath?: string;
  redactMetadata: boolean;
  scenarios: SlackQaScenarioResult[];
  startedAt: string;
}) {
  const lines = [
    "# Slack QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    `- Channel: \`${params.redactMetadata ? "<redacted>" : params.channelId}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
  ];
  if (params.gatewayDebugDirPath) {
    lines.push(`- Gateway debug artifacts: \`${params.gatewayDebugDirPath}\``);
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("", "## Cleanup issues", "");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`, "");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runSlackQaLive(params: {
  alternateModel?: string;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<SlackQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `slack-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds);
  const requestedCredentialSource = inferSlackCredentialSource(params.credentialSource);
  const requestedCredentialRole = inferSlackCredentialRole(params.credentialRole);
  const redactPublicMetadata = isTruthyOptIn(process.env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const includeObservedMessageContent = isTruthyOptIn(process.env[SLACK_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const observedMessages: SlackObservedMessage[] = [];
  const scenarioResults: SlackQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let credentialLease: SlackCredentialLease | undefined;
  let leaseHeartbeat: SlackCredentialHeartbeat | undefined;
  let runtimeEnv: SlackQaRuntimeEnv | undefined;

  try {
    credentialLease = await acquireQaCredentialLease({
      kind: "slack",
      source: params.credentialSource,
      role: params.credentialRole,
      resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
      parsePayload: parseSlackQaCredentialPayload,
    });
    leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
    const assertLeaseHealthy = () => {
      leaseHeartbeat?.throwIfFailed();
    };
    const activeRuntimeEnv = credentialLease.payload;
    runtimeEnv = activeRuntimeEnv;

    const [driverIdentity, sutIdentity] = await Promise.all([
      getSlackIdentity(activeRuntimeEnv.driverBotToken),
      getSlackIdentity(activeRuntimeEnv.sutBotToken),
    ]);
    if (driverIdentity.userId === sutIdentity.userId) {
      throw new Error("Slack QA requires two distinct bots for driver and SUT.");
    }

    const driverClient = createSlackWriteClient(activeRuntimeEnv.driverBotToken, {
      timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
    });
    const sutReadClient = createSlackWebClient(activeRuntimeEnv.sutBotToken, {
      timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
    });
    for (const scenario of scenarios) {
      let gatewayHarness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | undefined;
      try {
        assertLeaseHealthy();
        gatewayHarness = await startQaLiveLaneGateway({
          repoRoot,
          transport: {
            requiredPluginIds: [],
            createGatewayConfig: () => ({}),
          },
          transportBaseUrl: "http://127.0.0.1:0",
          providerMode,
          primaryModel,
          alternateModel,
          fastMode: params.fastMode,
          controlUiEnabled: false,
          mutateConfig: (cfg) =>
            buildSlackQaConfig(cfg, {
              channelId: activeRuntimeEnv.channelId,
              driverBotUserId: driverIdentity.userId,
              overrides: scenario.configOverrides,
              sutAccountId,
              sutAppToken: activeRuntimeEnv.sutAppToken,
              sutBotToken: activeRuntimeEnv.sutBotToken,
            }),
        });
        const activeGatewayHarness = gatewayHarness;
        await waitForSlackChannelRunning(activeGatewayHarness.gateway, sutAccountId);
        const scenarioRun = scenario.buildRun(sutIdentity.userId);
        const baseScenarioContext = {
          channelId: activeRuntimeEnv.channelId,
          driverClient,
          gateway: activeGatewayHarness.gateway,
          postSlackMessage: async (message: { text: string; threadTs?: string }) =>
            await sendSlackChannelMessage({
              channelId: activeRuntimeEnv.channelId,
              client: driverClient,
              text: message.text,
              threadTs: message.threadTs,
            }),
          sutIdentity,
          sutReadClient,
          waitForReady: async () =>
            await waitForSlackChannelRunning(activeGatewayHarness.gateway, sutAccountId),
        };
        const beforeRunResult = await scenarioRun.beforeRun?.(baseScenarioContext);
        const beforeRunDetails =
          typeof beforeRunResult === "string" ? beforeRunResult : beforeRunResult?.details;
        const requestStartedAt = new Date();
        const sent = await sendSlackChannelMessage({
          channelId: activeRuntimeEnv.channelId,
          client: driverClient,
          text: scenarioRun.input,
          threadTs:
            typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined,
        });
        const requestThreadTs =
          (typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined) ??
          sent.ts;
        if (scenarioRun.expectReply) {
          const reply = await waitForSlackScenarioReply({
            channelId: activeRuntimeEnv.channelId,
            client: sutReadClient,
            matchText: scenarioRun.matchText,
            observedMessages,
            observationScenarioId: scenario.id,
            observationScenarioTitle: scenario.title,
            sentTs: sent.ts,
            threadTs: requestThreadTs,
            sutIdentity,
            timeoutMs: scenario.timeoutMs,
          });
          scenarioRun.verify?.(reply.message, { requestThreadTs, sentTs: sent.ts });
          const responseObservedAt = new Date(reply.observedAt);
          const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
          const afterReplyDetails = await scenarioRun.afterReply?.(reply.message, {
            ...baseScenarioContext,
            sentTs: sent.ts,
          });
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: [`reply matched in ${rttMs}ms`, beforeRunDetails, afterReplyDetails]
              .filter(Boolean)
              .join("; "),
            rttMs,
            requestStartedAt: requestStartedAt.toISOString(),
            responseObservedAt: responseObservedAt.toISOString(),
          });
        } else {
          await waitForSlackNoReply({
            channelId: activeRuntimeEnv.channelId,
            client: sutReadClient,
            matchText: scenarioRun.matchText,
            observedMessages,
            observationScenarioId: scenario.id,
            observationScenarioTitle: scenario.title,
            sentTs: sent.ts,
            sutIdentity,
            timeoutMs: scenario.timeoutMs,
          });
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: "no reply",
          });
        }
      } catch (error) {
        scenarioResults.push({
          id: scenario.id,
          title: scenario.title,
          status: "fail",
          details: formatErrorMessage(error),
        });
        preservedGatewayDebugArtifacts = true;
        if (gatewayHarness) {
          await gatewayHarness
            .stop({ keepTemp: true, preserveToDir: gatewayDebugDirPath })
            .catch((stopError) => {
              appendLiveLaneIssue(cleanupIssues, "gateway debug preservation failed", stopError);
            });
        }
        break;
      } finally {
        if (!preservedGatewayDebugArtifacts && gatewayHarness) {
          await gatewayHarness.stop().catch((error) => {
            appendLiveLaneIssue(cleanupIssues, "gateway stop failed", error);
          });
        }
      }
    }
  } catch (error) {
    cleanupIssues.push(
      buildLiveLaneArtifactsError({
        heading: "Slack QA failed before scenario completion.",
        details: [formatErrorMessage(error)],
        artifacts: {
          gatewayDebug: gatewayDebugDirPath,
        },
      }),
    );
    preservedGatewayDebugArtifacts = true;
    await fs.mkdir(gatewayDebugDirPath, { recursive: true }).catch(() => {});
    scenarioResults.push({
      id: "slack-canary",
      title: "Slack canary echo",
      status: "fail",
      details: formatErrorMessage(error),
    });
  } finally {
    if (leaseHeartbeat) {
      try {
        await leaseHeartbeat.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential heartbeat stop failed", error);
      }
    }
    if (credentialLease) {
      try {
        await credentialLease.release();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential release failed", error);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "slack-qa-report.md");
  const summaryPath = path.join(outputDir, "slack-qa-summary.json");
  const observedMessagesPath = path.join(outputDir, "slack-qa-observed-messages.json");
  const passed = scenarioResults.filter((entry) => entry.status === "pass").length;
  const failed = scenarioResults.filter((entry) => entry.status === "fail").length;
  const summary: SlackQaSummary = {
    credentials: credentialLease
      ? {
          source: credentialLease.source,
          kind: credentialLease.kind,
          role: credentialLease.role,
          credentialId: redactPublicMetadata ? undefined : credentialLease.credentialId,
          ownerId: redactPublicMetadata ? undefined : credentialLease.ownerId,
        }
      : {
          source: requestedCredentialSource,
          kind: "slack",
          role: requestedCredentialRole,
        },
    channelId: runtimeEnv
      ? redactPublicMetadata
        ? "<redacted>"
        : runtimeEnv.channelId
      : "<unavailable>",
    startedAt,
    finishedAt,
    cleanupIssues,
    counts: {
      total: scenarioResults.length,
      passed,
      failed,
    },
    scenarios: scenarioResults,
  };
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      toObservedSlackArtifacts({
        messages: observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(
    reportPath,
    `${renderSlackQaMarkdown({
      channelId: runtimeEnv?.channelId ?? "<unavailable>",
      cleanupIssues,
      credentialSource: credentialLease?.source ?? requestedCredentialSource,
      finishedAt,
      gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
      redactMetadata: redactPublicMetadata,
      scenarios: scenarioResults,
      startedAt,
    })}\n`,
  );
  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
    scenarios: scenarioResults,
  };
}

export const __testing = {
  findScenario,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
  SLACK_QA_STANDARD_SCENARIO_IDS,
  waitForSlackNoReply,
};
