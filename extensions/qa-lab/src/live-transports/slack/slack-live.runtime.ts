import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSlackWebClient, createSlackWriteClient } from "@openclaw/slack/api.js";
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
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
import {
  appendQaLiveLaneIssue as appendLiveLaneIssue,
  buildQaLiveLaneArtifactsError as buildLiveLaneArtifactsError,
} from "../shared/live-artifacts.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
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

type SlackChannelStatus = {
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string | null;
  restartPending?: boolean;
  running?: boolean;
};

type SlackChannelReadinessMode = "connected" | "started";

const SLACK_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;
const SLACK_QA_READY_STABILITY_MS = 3_000;
const SLACK_QA_GATEWAY_STOP_SETTLE_MS = 3_000;
const SLACK_QA_RETRYABLE_SCENARIO_ATTEMPTS = 2;
const SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS = 30_000;
const SLACK_QA_APPROVAL_CHECKPOINT_DEFAULT_TIMEOUT_MS = 120_000;

type SlackQaScenarioId =
  | "slack-allowlist-block"
  | "slack-approval-exec-native"
  | "slack-approval-plugin-native"
  | "slack-canary"
  | "slack-mention-gating"
  | "slack-restart-resume"
  | "slack-thread-follow-up"
  | "slack-thread-isolation"
  | "slack-top-level-reply-shape";

type SlackQaApprovalKind = "exec" | "plugin";
type SlackQaApprovalDecision = "allow-always" | "allow-once" | "deny";

type SlackQaMessageScenarioRun = {
  kind?: "message";
  expectReply: boolean;
  input: string;
  matchText: string;
  verify?: (message: SlackMessage, context: { requestThreadTs: string; sentTs: string }) => void;
  beforeRun?: (context: Omit<SlackQaScenarioContext, "sentTs">) => Promise<SlackQaBeforeRunResult>;
  afterReply?: (message: SlackMessage, context: SlackQaScenarioContext) => Promise<string | void>;
};

type SlackQaApprovalScenarioRun = {
  approvalKind: SlackQaApprovalKind;
  decision: SlackQaApprovalDecision;
  kind: "approval";
  token: string;
};

type SlackQaScenarioRun = SlackQaApprovalScenarioRun | SlackQaMessageScenarioRun;

type SlackQaBeforeRunResult =
  | string
  | void
  | {
      details?: string;
      inputThreadTs?: string;
    };

type SlackQaConfigOverrides = {
  allowFrom?: string[];
  approvals?: {
    exec?: boolean;
    plugin?: boolean;
    target?: "both" | "channel" | "dm";
  };
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

type SlackQaGatewayHarness = Awaited<ReturnType<typeof startQaLiveLaneGateway>>;

type SlackAuthIdentity = {
  botId?: string;
  teamId?: string;
  userId: string;
};

type SlackMessage = {
  bot_id?: string;
  blocks?: unknown[];
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
  actionValues?: string[];
  blockText?: string[];
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
  actionValues?: string[];
  blockText?: string[];
  threadTs?: string;
  ts?: string;
  userId?: string;
};

type SlackApprovalArtifact = {
  approvalId: string;
  approvalKind: SlackQaApprovalKind;
  channelId?: string;
  decision: SlackQaApprovalDecision;
  pendingActionValues?: string[];
  pendingCheckpointPath?: string;
  pendingMessageTs?: string;
  pendingScreenshotPath?: string;
  pendingText?: string;
  resolvedActionValues?: string[];
  resolvedCheckpointPath?: string;
  resolvedMessageTs?: string;
  resolvedScreenshotPath?: string;
  resolvedText?: string;
  threadTs?: string;
};

type SlackApprovalCheckpointState = "pending" | "resolved";

type SlackApprovalCheckpointAck = {
  capturedAt?: string;
  screenshotPath?: string;
};

type SlackApprovalCheckpointMessage = {
  actionLabels: string[];
  blockText: string[];
  hasNativeActions: boolean;
  text: string;
};

type SlackQaScenarioResult = {
  approval?: SlackApprovalArtifact;
  details: string;
  id: string;
  requestStartedAt?: string;
  responseObservedAt?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs: number;
    requestStartedAt: string;
    responseObservedAt: string;
    source: "approval-request-to-resolution" | "request-to-observed-message";
  };
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
const SLACK_QA_APPROVAL_CHECKPOINT_DIR_ENV = "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR";
const SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV =
  "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS";
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
  blocks: z.array(z.unknown()).optional(),
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
    configOverrides: {
      allowFrom: ["U_OPENCLAW_QA_NEVER_ALLOWED"],
      users: ["U_OPENCLAW_QA_NEVER_ALLOWED"],
    },
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
    id: "slack-approval-exec-native",
    title: "Slack native exec approval prompt resolves",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
        target: "channel",
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      kind: "approval",
      token: `SLACK_QA_EXEC_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "slack-approval-plugin-native",
    title: "Slack native plugin approval prompt resolves with exec approvals enabled",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
        plugin: true,
        target: "channel",
      },
    },
    buildRun: () => ({
      approvalKind: "plugin",
      decision: "allow-once",
      kind: "approval",
      token: `SLACK_QA_PLUGIN_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
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
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "slack"]);
  const approvalOverrides = params.overrides?.approvals;
  const approvalForwardingConfig =
    approvalOverrides?.exec || approvalOverrides?.plugin
      ? {
          approvals: {
            ...baseCfg.approvals,
            ...(approvalOverrides.exec
              ? {
                  exec: {
                    ...baseCfg.approvals?.exec,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
            ...(approvalOverrides.plugin
              ? {
                  plugin: {
                    ...baseCfg.approvals?.plugin,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
          },
        }
      : {};
  const execApprovalsConfig = approvalOverrides
    ? {
        enabled: true,
        approvers: [params.driverBotUserId],
        target: approvalOverrides.target ?? ("channel" as const),
      }
    : undefined;
  return {
    ...baseCfg,
    ...approvalForwardingConfig,
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
            allowFrom: params.overrides?.allowFrom ?? [params.driverBotUserId],
            groupPolicy: "allowlist",
            allowBots: true,
            replyToMode: params.overrides?.replyToMode ?? "off",
            ...(execApprovalsConfig ? { execApprovals: execApprovalsConfig } : {}),
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

function formatApprovalResultValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "<missing>";
  }
  return JSON.stringify(value) ?? "<unserializable>";
}

function readAcceptedApprovalRequest(result: unknown) {
  const accepted =
    typeof result === "object" && result !== null
      ? (result as { id?: unknown; status?: unknown })
      : null;
  if (accepted?.status !== "accepted") {
    throw new Error(
      `approval request status was ${formatApprovalResultValue(
        accepted?.status,
      )} instead of accepted`,
    );
  }
  return accepted;
}

function readAcceptedApprovalRequestId(result: unknown) {
  const id = readAcceptedApprovalRequest(result).id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`approval request id was ${formatApprovalResultValue(id)}`);
  }
  return id;
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

function collectSlackBlockText(blocks?: unknown[]) {
  return collectSlackBlockStringFields(blocks ?? [], "text");
}

function collectSlackActionValues(blocks?: unknown[]) {
  return collectSlackBlockStringFields(blocks ?? [], "value");
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

function buildSlackApprovalCheckpointMessage(
  message: SlackMessage,
): SlackApprovalCheckpointMessage {
  const actionValues = collectSlackActionValues(message.blocks);
  return {
    actionLabels: collectSlackButtonLabels(message.blocks),
    blockText: collectSlackBlockText(message.blocks),
    hasNativeActions: actionValues.some((value) => value.includes("/approve")),
    text: message.text ?? "",
  };
}

function hasSlackNativeApprovalActions(params: {
  actionValues: string[];
  approvalId: string;
  decision: SlackQaApprovalDecision;
}) {
  return params.actionValues.some(
    (value) =>
      value.includes("/approve") &&
      value.includes(params.approvalId) &&
      value.includes(params.decision),
  );
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
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
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

async function waitForSlackApprovalPrompt(params: {
  approvalId: string;
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
  token: string;
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
      const hasHeading = text.includes(
        resolveApprovalHeading({ approvalKind: params.approvalKind, state: "pending" }),
      );
      const hasToken = text.includes(params.token);
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (hasHeading || hasToken || hasSlackNativeApprovalActions({ ...params, actionValues })) {
        if (!seenObservedMessages.has(observedKey)) {
          seenObservedMessages.add(observedKey);
          pushObservedApprovalMessage({
            channelId: params.channelId,
            matchedScenario: hasHeading && hasToken,
            message,
            observedMessages: params.observedMessages,
            scenarioId: params.scenarioId,
            scenarioTitle: params.scenarioTitle,
          });
        }
      }
      if (!hasHeading || !hasToken) {
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

async function waitForSlackApprovalResolvedUpdate(params: {
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
  token: string;
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
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (!seenObservedMessages.has(observedKey)) {
        seenObservedMessages.add(observedKey);
        pushObservedApprovalMessage({
          channelId: params.channelId,
          matchedScenario: text.includes(params.token),
          message,
          observedMessages: params.observedMessages,
          scenarioId: params.scenarioId,
          scenarioTitle: params.scenarioTitle,
        });
      }
      if (
        text.includes(
          resolveApprovalHeading({
            approvalKind: params.approvalKind,
            decision: params.decision,
            state: "resolved",
          }),
        ) &&
        text.includes(params.token) &&
        !actionValues.some((value) => value.includes("/approve"))
      ) {
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

async function writeSlackApprovalCheckpoint(params: {
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

async function requestSlackApproval(params: {
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

async function waitForApprovalDecision(params: {
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

async function resolveApprovalDecision(params: {
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

function assertApprovalDecisionResult(params: {
  decision: SlackQaApprovalDecision;
  result: unknown;
}) {
  const resultDecision =
    typeof params.result === "object" && params.result !== null
      ? (params.result as { decision?: unknown }).decision
      : undefined;
  if (resultDecision !== params.decision) {
    throw new Error(
      `approval decision was ${formatApprovalResultValue(resultDecision)} instead of ${params.decision}`,
    );
  }
}

async function runSlackApprovalScenario(params: {
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

async function waitForSlackChannelStable(
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

function isRetryableSlackQaScenarioError(error: unknown) {
  return /timed out after \d+ms waiting for Slack message/iu.test(formatErrorMessage(error));
}

function toObservedSlackArtifacts(params: {
  includeContent: boolean;
  messages: SlackObservedMessage[];
  redactMetadata: boolean;
}): SlackObservedMessageArtifact[] {
  return params.messages.map((message) => ({
    actionValues: params.includeContent ? message.actionValues : undefined,
    blockText: params.includeContent ? message.blockText : undefined,
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

function toSlackQaScenarioArtifactResults(params: {
  includeContent: boolean;
  redactMetadata: boolean;
  scenarios: SlackQaScenarioResult[];
}): SlackQaScenarioResult[] {
  return params.scenarios.map((scenario) => {
    if (!scenario.approval) {
      return scenario;
    }
    const approval = scenario.approval;
    return {
      ...scenario,
      approval: {
        approvalId: params.redactMetadata ? "<redacted>" : approval.approvalId,
        approvalKind: approval.approvalKind,
        channelId: params.redactMetadata ? undefined : approval.channelId,
        decision: approval.decision,
        pendingActionValues: params.includeContent ? approval.pendingActionValues : undefined,
        pendingCheckpointPath: approval.pendingCheckpointPath,
        pendingMessageTs: params.redactMetadata ? undefined : approval.pendingMessageTs,
        pendingScreenshotPath: approval.pendingScreenshotPath,
        pendingText: params.includeContent ? approval.pendingText : undefined,
        resolvedActionValues: params.includeContent ? approval.resolvedActionValues : undefined,
        resolvedCheckpointPath: approval.resolvedCheckpointPath,
        resolvedMessageTs: params.redactMetadata ? undefined : approval.resolvedMessageTs,
        resolvedScreenshotPath: approval.resolvedScreenshotPath,
        resolvedText: params.includeContent ? approval.resolvedText : undefined,
        threadTs: params.redactMetadata ? undefined : approval.threadTs,
      },
    };
  });
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
    if (scenario.approval) {
      lines.push(`- Approval kind: ${scenario.approval.approvalKind}`);
      lines.push(`- Approval ID: \`${scenario.approval.approvalId}\``);
      lines.push(`- Decision: ${scenario.approval.decision}`);
      if (scenario.approval.pendingScreenshotPath) {
        lines.push(`- Pending screenshot: \`${scenario.approval.pendingScreenshotPath}\``);
      }
      if (scenario.approval.resolvedScreenshotPath) {
        lines.push(`- Resolved screenshot: \`${scenario.approval.resolvedScreenshotPath}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function preserveSlackGatewayDebugArtifacts(params: {
  cleanupIssues: string[];
  gatewayDebugDirPath: string;
  gatewayHarness: SlackQaGatewayHarness;
}) {
  await params.gatewayHarness
    .stop({ preserveToDir: params.gatewayDebugDirPath })
    .catch((error: unknown) => {
      appendLiveLaneIssue(params.cleanupIssues, "gateway debug preservation failed", error);
    });
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
      let scenarioAttempt = 1;
      while (true) {
        let gatewayHarness: SlackQaGatewayHarness | undefined;
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
          const scenarioRun = scenario.buildRun(sutIdentity.userId);
          const readinessMode: SlackChannelReadinessMode =
            scenarioRun.kind === "approval" ? "started" : "connected";
          await waitForSlackChannelStable(
            activeGatewayHarness.gateway,
            sutAccountId,
            readinessMode,
          );
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
              await waitForSlackChannelStable(
                activeGatewayHarness.gateway,
                sutAccountId,
                "connected",
              ),
          };
          if (scenarioRun.kind === "approval") {
            const approval = await runSlackApprovalScenario({
              channelId: activeRuntimeEnv.channelId,
              context: baseScenarioContext,
              observedMessages,
              run: scenarioRun,
              scenario,
              sutAccountId,
            });
            scenarioResults.push({
              approval: approval.artifact,
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: [
                `${scenarioRun.approvalKind} approval resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs: approval.rttMs,
              requestStartedAt: approval.requestStartedAt.toISOString(),
              responseObservedAt: approval.responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: approval.rttMs,
                requestStartedAt: approval.requestStartedAt.toISOString(),
                responseObservedAt: approval.responseObservedAt.toISOString(),
                source: "approval-request-to-resolution",
              },
            });
            break;
          }
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
              details: [
                `reply matched in ${rttMs}ms`,
                beforeRunDetails,
                afterReplyDetails,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs,
              requestStartedAt: requestStartedAt.toISOString(),
              responseObservedAt: responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: rttMs,
                requestStartedAt: requestStartedAt.toISOString(),
                responseObservedAt: responseObservedAt.toISOString(),
                source: "request-to-observed-message",
              },
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
              details:
                scenarioAttempt > 1 ? `no reply; retried ${scenarioAttempt - 1}x` : "no reply",
            });
          }
          break;
        } catch (error) {
          if (
            scenarioAttempt < SLACK_QA_RETRYABLE_SCENARIO_ATTEMPTS &&
            isRetryableSlackQaScenarioError(error)
          ) {
            scenarioAttempt += 1;
            continue;
          }
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "fail",
            details:
              scenarioAttempt > 1
                ? `${formatErrorMessage(error)}; retried ${scenarioAttempt - 1}x`
                : formatErrorMessage(error),
          });
          preservedGatewayDebugArtifacts = true;
          if (gatewayHarness) {
            await preserveSlackGatewayDebugArtifacts({
              cleanupIssues,
              gatewayDebugDirPath,
              gatewayHarness,
            });
          }
          break;
        } finally {
          if (!preservedGatewayDebugArtifacts && gatewayHarness) {
            await gatewayHarness.stop().catch((error: unknown) => {
              appendLiveLaneIssue(cleanupIssues, "gateway stop failed", error);
            });
            await new Promise((resolve) => {
              setTimeout(resolve, SLACK_QA_GATEWAY_STOP_SETTLE_MS);
            });
          }
        }
        if (scenarioResults.at(-1)?.id === scenario.id) {
          break;
        }
      }
      if (scenarioResults.at(-1)?.status === "fail") {
        break;
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
  const artifactScenarioResults = toSlackQaScenarioArtifactResults({
    scenarios: scenarioResults,
    includeContent: includeObservedMessageContent,
    redactMetadata: redactPublicMetadata,
  });
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
    scenarios: artifactScenarioResults,
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
      scenarios: artifactScenarioResults,
      startedAt,
    })}\n`,
  );
  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
    scenarios: artifactScenarioResults,
  };
}

export const testing = {
  buildSlackApprovalCheckpointMessage,
  buildSlackQaConfig,
  collectSlackActionValues,
  collectSlackButtonLabels,
  collectSlackBlockText,
  findScenario,
  isSlackChannelReadyForQa,
  parseSlackQaCredentialPayload,
  preserveSlackGatewayDebugArtifacts,
  resolveSlackChannelReadySince,
  resolveSlackQaReadyTimeoutMs,
  resolveSlackApprovalCheckpointConfig,
  resolveApprovalDecision,
  resolveSlackQaRuntimeEnv,
  SLACK_QA_STANDARD_SCENARIO_IDS,
  toSlackQaScenarioArtifactResults,
  waitForSlackNoReply,
};
export { testing as __testing };
