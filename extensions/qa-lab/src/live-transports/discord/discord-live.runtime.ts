import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
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

type DiscordQaRuntimeEnv = {
  guildId: string;
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutApplicationId: string;
};

type DiscordQaScenarioId =
  | "discord-canary"
  | "discord-mention-gating"
  | "discord-native-help-command-registration";

type DiscordQaScenarioRun =
  | {
      kind: "channel-message";
      expectReply: boolean;
      input: string;
      expectedTextIncludes?: string[];
      matchText?: string;
    }
  | {
      kind: "application-command-registration";
      expectedCommandNames: string[];
    };

type DiscordQaScenarioDefinition = LiveTransportScenarioDefinition<DiscordQaScenarioId> & {
  buildRun: (sutApplicationId: string) => DiscordQaScenarioRun;
};

type DiscordUser = {
  id: string;
  username?: string;
  bot?: boolean;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp?: string;
  author?: DiscordUser;
  referenced_message?: { id?: string } | null;
};

type DiscordApplicationCommand = {
  id: string;
  name?: string;
};

type DiscordObservedMessage = {
  messageId: string;
  channelId: string;
  guildId?: string;
  senderId: string;
  senderIsBot: boolean;
  senderUsername?: string;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text: string;
  replyToMessageId?: string;
  timestamp?: string;
};

type DiscordObservedMessageArtifact = {
  messageId?: string;
  channelId?: string;
  guildId?: string;
  senderId?: string;
  senderIsBot: boolean;
  senderUsername?: string;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text?: string;
  replyToMessageId?: string;
  timestamp?: string;
};

type DiscordQaScenarioResult = {
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
};

type DiscordQaRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  observedMessagesPath: string;
  gatewayDebugDirPath?: string;
  scenarios: DiscordQaScenarioResult[];
};

type DiscordQaSummary = {
  credentials: {
    credentialId?: string;
    kind: string;
    ownerId?: string;
    role?: QaCredentialRole;
    source: "convex" | "env";
  };
  guildId: string;
  channelId: string;
  startedAt: string;
  finishedAt: string;
  cleanupIssues: string[];
  counts: {
    total: number;
    passed: number;
    failed: number;
  };
  scenarios: DiscordQaScenarioResult[];
};

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_DISCORD_CAPTURE_CONTENT";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";
const DISCORD_QA_ENV_KEYS = [
  "OPENCLAW_QA_DISCORD_GUILD_ID",
  "OPENCLAW_QA_DISCORD_CHANNEL_ID",
  "OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN",
  "OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID",
] as const;

const DISCORD_QA_SCENARIOS: DiscordQaScenarioDefinition[] = [
  {
    id: "discord-canary",
    standardId: "canary",
    title: "Discord canary echo",
    timeoutMs: 45_000,
    buildRun: (sutApplicationId) => {
      const token = `DISCORD_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        kind: "channel-message",
        expectReply: true,
        input: `<@${sutApplicationId}> reply with only this exact marker: ${token}`,
        expectedTextIncludes: [token],
        matchText: token,
      };
    },
  },
  {
    id: "discord-mention-gating",
    standardId: "mention-gating",
    title: "Discord unmentioned message does not trigger",
    timeoutMs: 8_000,
    buildRun: () => {
      const token = `DISCORD_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        kind: "channel-message",
        expectReply: false,
        input: `reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
  {
    id: "discord-native-help-command-registration",
    title: "Discord native help command is registered",
    timeoutMs: 45_000,
    buildRun: () => ({
      kind: "application-command-registration",
      expectedCommandNames: ["help"],
    }),
  },
];

const DISCORD_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  scenarios: DISCORD_QA_SCENARIOS,
});

const discordQaCredentialPayloadSchema = z.object({
  guildId: z.string().trim().min(1),
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutApplicationId: z.string().trim().min(1),
});

function isDiscordSnowflake(value: string) {
  return /^\d{17,20}$/u.test(value);
}

function assertDiscordSnowflake(value: string, label: string) {
  if (!isDiscordSnowflake(value)) {
    throw new Error(`${label} must be a Discord snowflake.`);
  }
}

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof DISCORD_QA_ENV_KEYS)[number]) {
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

function resolveDiscordQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): DiscordQaRuntimeEnv {
  const runtimeEnv = {
    guildId: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_GUILD_ID"),
    channelId: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_CHANNEL_ID"),
    driverBotToken: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN"),
    sutBotToken: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN"),
    sutApplicationId: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID"),
  };
  validateDiscordQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_DISCORD");
  return runtimeEnv;
}

function validateDiscordQaRuntimeEnv(runtimeEnv: DiscordQaRuntimeEnv, prefix: string) {
  assertDiscordSnowflake(runtimeEnv.guildId, `${prefix}_GUILD_ID`);
  assertDiscordSnowflake(runtimeEnv.channelId, `${prefix}_CHANNEL_ID`);
  assertDiscordSnowflake(runtimeEnv.sutApplicationId, `${prefix}_SUT_APPLICATION_ID`);
}

function parseDiscordQaCredentialPayload(payload: unknown): DiscordQaRuntimeEnv {
  const parsed = discordQaCredentialPayloadSchema.parse(payload);
  const runtimeEnv = {
    guildId: parsed.guildId,
    channelId: parsed.channelId,
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutApplicationId: parsed.sutApplicationId,
  };
  validateDiscordQaRuntimeEnv(runtimeEnv, "Discord credential payload");
  return runtimeEnv;
}

function buildDiscordQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    guildId: string;
    channelId: string;
    driverBotId: string;
    sutAccountId: string;
    sutBotToken: string;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "discord"])];
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    discord: { enabled: true },
  };
  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
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
      discord: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            token: params.sutBotToken,
            allowBots: "mentions",
            groupPolicy: "allowlist",
            guilds: {
              [params.guildId]: {
                requireMention: true,
                users: [params.driverBotId],
                channels: {
                  [params.channelId]: {
                    enabled: true,
                    requireMention: true,
                    users: [params.driverBotId],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

async function callDiscordApi<T>(params: {
  token: string;
  path: string;
  init?: RequestInit;
  timeoutMs?: number;
}): Promise<T> {
  const headers = new Headers(params.init?.headers);
  headers.set("authorization", `Bot ${params.token}`);
  if (params.init?.body) {
    headers.set("content-type", "application/json");
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${DISCORD_API_BASE_URL}${params.path}`,
    init: {
      ...params.init,
      headers,
    },
    signal: AbortSignal.timeout(params.timeoutMs ?? 15_000),
    policy: { hostnameAllowlist: ["discord.com"] },
    auditContext: "qa-lab-discord-live",
  });
  try {
    const text = await response.text();
    const payload = text.trim() ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const message =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message
          : text.trim();
      throw new Error(
        message || `Discord API ${params.path} failed with status ${response.status}`,
      );
    }
    return payload as T;
  } finally {
    await release();
  }
}

async function getCurrentDiscordUser(token: string) {
  return await callDiscordApi<DiscordUser>({
    token,
    path: "/users/@me",
  });
}

async function sendChannelMessage(token: string, channelId: string, content: string) {
  return await callDiscordApi<DiscordMessage>({
    token,
    path: `/channels/${channelId}/messages`,
    init: {
      method: "POST",
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: ["users"],
        },
      }),
    },
  });
}

async function listChannelMessagesAfter(params: {
  token: string;
  channelId: string;
  afterSnowflake: string;
}) {
  const query = new URLSearchParams({
    after: params.afterSnowflake,
    limit: "50",
  });
  return await callDiscordApi<DiscordMessage[]>({
    token: params.token,
    path: `/channels/${params.channelId}/messages?${query.toString()}`,
  });
}

async function listApplicationCommands(params: { token: string; applicationId: string }) {
  return await callDiscordApi<DiscordApplicationCommand[]>({
    token: params.token,
    path: `/applications/${params.applicationId}/commands`,
  });
}

function compareDiscordSnowflakes(a: string, b: string) {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDiscordObservedMessage(message: DiscordMessage): DiscordObservedMessage | null {
  if (!message.author?.id) {
    return null;
  }
  return {
    messageId: message.id,
    channelId: message.channel_id,
    guildId: message.guild_id,
    senderId: message.author.id,
    senderIsBot: message.author.bot === true,
    senderUsername: message.author.username,
    text: message.content ?? "",
    replyToMessageId: message.referenced_message?.id,
    timestamp: message.timestamp,
  };
}

async function pollChannelMessages(params: {
  token: string;
  channelId: string;
  afterSnowflake: string;
  timeoutMs: number;
  predicate: (message: DiscordObservedMessage) => boolean;
  observedMessages: DiscordObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
}) {
  const startedAt = Date.now();
  let afterSnowflake = params.afterSnowflake;
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listChannelMessagesAfter({
      token: params.token,
      channelId: params.channelId,
      afterSnowflake,
    });
    const sorted = messages
      .filter((message) => isDiscordSnowflake(message.id))
      .toSorted((a, b) => compareDiscordSnowflakes(a.id, b.id));
    for (const message of sorted) {
      afterSnowflake = message.id;
      const normalized = normalizeDiscordObservedMessage(message);
      if (!normalized) {
        continue;
      }
      const matchedScenario = params.predicate(normalized);
      const observedMessage: DiscordObservedMessage = {
        ...normalized,
        scenarioId: params.observationScenarioId,
        scenarioTitle: params.observationScenarioTitle,
        matchedScenario,
      };
      params.observedMessages.push(observedMessage);
      if (matchedScenario) {
        return { message: observedMessage, afterSnowflake };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Discord message`);
}

async function waitForDiscordChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
) {
  const startedAt = Date.now();
  let lastStatus:
    | {
        running?: boolean;
        connected?: boolean;
        restartPending?: boolean;
        lastConnectedAt?: number;
        lastDisconnect?: unknown;
        lastError?: string;
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
            running?: boolean;
            connected?: boolean;
            restartPending?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.discord ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            running: match.running,
            connected: match.connected,
            restartPending: match.restartPending,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
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
  const details = lastStatus
    ? ` (last status: running=${String(lastStatus.running)} connected=${String(lastStatus.connected)} restartPending=${String(lastStatus.restartPending)} lastConnectedAt=${String(lastStatus.lastConnectedAt)} lastError=${lastStatus.lastError ?? "null"} lastDisconnect=${JSON.stringify(lastStatus.lastDisconnect)})`
    : "";
  throw new Error(`discord account "${accountId}" did not become connected${details}`);
}

function renderDiscordQaMarkdown(params: {
  cleanupIssues: string[];
  credentialSource: "convex" | "env";
  redactMetadata: boolean;
  guildId: string;
  channelId: string;
  gatewayDebugDirPath?: string;
  startedAt: string;
  finishedAt: string;
  scenarios: DiscordQaScenarioResult[];
}) {
  const lines = [
    "# Discord QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    `- Guild: \`${params.guildId}\``,
    `- Channel: \`${params.channelId}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
    "",
    "## Scenarios",
    "",
  ];
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`);
    lines.push("");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    lines.push("");
  }
  if (params.gatewayDebugDirPath) {
    lines.push("## Gateway Debug Logs");
    lines.push("");
    lines.push(`- Preserved at: \`${params.gatewayDebugDirPath}\``);
    lines.push("");
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("## Cleanup");
    lines.push("");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildObservedMessagesArtifact(params: {
  observedMessages: DiscordObservedMessage[];
  includeContent: boolean;
  redactMetadata: boolean;
}) {
  return params.observedMessages.map<DiscordObservedMessageArtifact>((message) => {
    const scenarioContext = {
      ...(message.scenarioId ? { scenarioId: message.scenarioId } : {}),
      ...(message.scenarioTitle ? { scenarioTitle: message.scenarioTitle } : {}),
      ...(typeof message.matchedScenario === "boolean"
        ? { matchedScenario: message.matchedScenario }
        : {}),
    };
    const base = params.redactMetadata
      ? {
          ...scenarioContext,
          senderIsBot: message.senderIsBot,
        }
      : {
          ...scenarioContext,
          messageId: message.messageId,
          channelId: message.channelId,
          guildId: message.guildId,
          senderId: message.senderId,
          senderIsBot: message.senderIsBot,
          senderUsername: message.senderUsername,
          replyToMessageId: message.replyToMessageId,
          timestamp: message.timestamp,
        };
    if (!params.includeContent) {
      return base;
    }
    return {
      ...base,
      text: message.text,
    };
  });
}

function findScenario(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Discord",
    scenarios: DISCORD_QA_SCENARIOS,
  });
}

function matchesDiscordScenarioReply(params: {
  channelId: string;
  message: DiscordObservedMessage;
  matchText?: string;
  sutBotId: string;
}) {
  return (
    params.message.channelId === params.channelId &&
    params.message.senderId === params.sutBotId &&
    Boolean(params.matchText && params.message.text.includes(params.matchText))
  );
}

function assertDiscordScenarioReply(params: {
  expectedTextIncludes?: string[];
  message: DiscordObservedMessage;
}) {
  if (!params.message.text.trim()) {
    throw new Error(`reply message ${params.message.messageId} was empty`);
  }
  for (const expected of params.expectedTextIncludes ?? []) {
    if (!params.message.text.includes(expected)) {
      throw new Error(
        `reply message ${params.message.messageId} missing expected text: ${expected}`,
      );
    }
  }
}

async function assertDiscordApplicationCommandsRegistered(params: {
  applicationId: string;
  expectedCommandNames: string[];
  timeoutMs: number;
  token: string;
}) {
  const startedAt = Date.now();
  let lastNames: string[] = [];
  while (Date.now() - startedAt < params.timeoutMs) {
    const commands = await listApplicationCommands({
      token: params.token,
      applicationId: params.applicationId,
    });
    lastNames = commands
      .map((command) => command.name ?? "")
      .filter(Boolean)
      .toSorted();
    const nameSet = new Set(lastNames);
    const missing = params.expectedCommandNames.filter((name) => !nameSet.has(name));
    if (missing.length === 0) {
      return { commandNames: lastNames };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `missing Discord native command(s): ${params.expectedCommandNames
      .filter((name) => !lastNames.includes(name))
      .join(", ")} (registered: ${lastNames.join(", ") || "none"})`,
  );
}

export async function runDiscordQaLive(params: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
}): Promise<DiscordQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `discord-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds);

  const credentialLease = await acquireQaCredentialLease({
    kind: "discord",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveDiscordQaRuntimeEnv(),
    parsePayload: parseDiscordQaCredentialPayload,
  });
  const leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const assertLeaseHealthy = () => {
    leaseHeartbeat.throwIfFailed();
  };

  const runtimeEnv = credentialLease.payload;
  const observedMessages: DiscordObservedMessage[] = [];
  const redactPublicMetadata = isTruthyOptIn(process.env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const includeObservedMessageContent = isTruthyOptIn(process.env[DISCORD_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const scenarioResults: DiscordQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  try {
    const [driverIdentity, sutIdentity] = await Promise.all([
      getCurrentDiscordUser(runtimeEnv.driverBotToken),
      getCurrentDiscordUser(runtimeEnv.sutBotToken),
    ]);
    if (driverIdentity.id === sutIdentity.id) {
      throw new Error("Discord QA requires two distinct bots for driver and SUT.");
    }
    if (sutIdentity.id !== runtimeEnv.sutApplicationId) {
      throw new Error(
        "Discord QA SUT application id must match the SUT bot user id returned by Discord.",
      );
    }

    const gatewayHarness = await startQaLiveLaneGateway({
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
        buildDiscordQaConfig(cfg, {
          guildId: runtimeEnv.guildId,
          channelId: runtimeEnv.channelId,
          driverBotId: driverIdentity.id,
          sutAccountId,
          sutBotToken: runtimeEnv.sutBotToken,
        }),
    });
    try {
      await waitForDiscordChannelRunning(gatewayHarness.gateway, sutAccountId);
      assertLeaseHealthy();
      for (const scenario of scenarios) {
        assertLeaseHealthy();
        const scenarioRun = scenario.buildRun(runtimeEnv.sutApplicationId);
        try {
          if (scenarioRun.kind === "application-command-registration") {
            const registered = await assertDiscordApplicationCommandsRegistered({
              token: runtimeEnv.sutBotToken,
              applicationId: runtimeEnv.sutApplicationId,
              expectedCommandNames: scenarioRun.expectedCommandNames,
              timeoutMs: scenario.timeoutMs,
            });
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: redactPublicMetadata
                ? "native command registered"
                : `native command registered (${registered.commandNames.join(", ")})`,
            });
            continue;
          }
          const sent = await sendChannelMessage(
            runtimeEnv.driverBotToken,
            runtimeEnv.channelId,
            scenarioRun.input,
          );
          const matched = await pollChannelMessages({
            token: runtimeEnv.driverBotToken,
            channelId: runtimeEnv.channelId,
            afterSnowflake: sent.id,
            timeoutMs: scenario.timeoutMs,
            observedMessages,
            observationScenarioId: scenario.id,
            observationScenarioTitle: scenario.title,
            predicate: (message) =>
              matchesDiscordScenarioReply({
                channelId: runtimeEnv.channelId,
                matchText: scenarioRun.matchText,
                message,
                sutBotId: sutIdentity.id,
              }),
          });
          if (!scenarioRun.expectReply) {
            throw new Error(`unexpected reply message ${matched.message.messageId} matched`);
          }
          assertDiscordScenarioReply({
            expectedTextIncludes: scenarioRun.expectedTextIncludes,
            message: matched.message,
          });
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: redactPublicMetadata
              ? "reply matched"
              : `reply message ${matched.message.messageId} matched`,
          });
        } catch (error) {
          if (scenarioRun.kind === "channel-message" && !scenarioRun.expectReply) {
            const details = formatErrorMessage(error);
            if (details === `timed out after ${scenario.timeoutMs}ms waiting for Discord message`) {
              scenarioResults.push({
                id: scenario.id,
                title: scenario.title,
                status: "pass",
                details: "no reply",
              });
              continue;
            }
          }
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "fail",
            details: formatErrorMessage(error),
          });
        }
        assertLeaseHealthy();
      }
    } finally {
      try {
        const shouldPreserveGatewayDebugArtifacts = scenarioResults.some(
          (scenario) => scenario.status === "fail",
        );
        await gatewayHarness.stop(
          shouldPreserveGatewayDebugArtifacts ? { preserveToDir: gatewayDebugDirPath } : undefined,
        );
        preservedGatewayDebugArtifacts = shouldPreserveGatewayDebugArtifacts;
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "live gateway cleanup", error);
      }
    }
  } finally {
    await leaseHeartbeat.stop();
    try {
      await credentialLease.release();
    } catch (error) {
      appendLiveLaneIssue(cleanupIssues, "credential lease release", error);
    }
  }

  const finishedAt = new Date().toISOString();
  const publishedCleanupIssues = redactPublicMetadata
    ? cleanupIssues.map(() => "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)")
    : cleanupIssues;
  const passedCount = scenarioResults.filter((entry) => entry.status === "pass").length;
  const failedCount = scenarioResults.filter((entry) => entry.status === "fail").length;
  const summary: DiscordQaSummary = {
    credentials: {
      source: credentialLease.source,
      kind: credentialLease.kind,
      role: credentialLease.role,
      ownerId: redactPublicMetadata ? undefined : credentialLease.ownerId,
      credentialId: redactPublicMetadata ? undefined : credentialLease.credentialId,
    },
    guildId: redactPublicMetadata ? "<redacted>" : runtimeEnv.guildId,
    channelId: redactPublicMetadata ? "<redacted>" : runtimeEnv.channelId,
    startedAt,
    finishedAt,
    cleanupIssues: publishedCleanupIssues,
    counts: {
      total: scenarioResults.length,
      passed: passedCount,
      failed: failedCount,
    },
    scenarios: scenarioResults,
  };
  const reportPath = path.join(outputDir, "discord-qa-report.md");
  const summaryPath = path.join(outputDir, "discord-qa-summary.json");
  const observedMessagesPath = path.join(outputDir, "discord-qa-observed-messages.json");
  await fs.writeFile(
    reportPath,
    `${renderDiscordQaMarkdown({
      cleanupIssues: publishedCleanupIssues,
      credentialSource: credentialLease.source,
      redactMetadata: redactPublicMetadata,
      guildId: redactPublicMetadata ? "<redacted>" : runtimeEnv.guildId,
      channelId: redactPublicMetadata ? "<redacted>" : runtimeEnv.channelId,
      gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
      startedAt,
      finishedAt,
      scenarios: scenarioResults,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      buildObservedMessagesArtifact({
        observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const artifactPaths = {
    report: reportPath,
    summary: summaryPath,
    observedMessages: observedMessagesPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebug: gatewayDebugDirPath } : {}),
  };
  if (cleanupIssues.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Discord QA cleanup failed after artifacts were written.",
        details: publishedCleanupIssues,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebugDirPath } : {}),
    scenarios: scenarioResults,
  };
}

export const __testing = {
  DISCORD_QA_SCENARIOS,
  DISCORD_QA_STANDARD_SCENARIO_IDS,
  assertDiscordScenarioReply,
  assertDiscordApplicationCommandsRegistered,
  buildDiscordQaConfig,
  buildObservedMessagesArtifact,
  callDiscordApi,
  findScenario,
  listApplicationCommands,
  matchesDiscordScenarioReply,
  normalizeDiscordObservedMessage,
  parseDiscordQaCredentialPayload,
  resolveDiscordQaRuntimeEnv,
  waitForDiscordChannelRunning,
};
