import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requestDiscord } from "@openclaw/discord/api.js";
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { chromium } from "playwright-core";
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
  | "discord-native-help-command-registration"
  | "discord-status-reactions-tool-only";

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
    }
  | {
      kind: "status-reactions-tool-only";
      expectedSequence: string[];
      input: string;
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
  reactions?: DiscordReaction[];
  timestamp?: string;
  author?: DiscordUser;
  referenced_message?: { id?: string } | null;
};

type DiscordReaction = {
  count?: number;
  emoji?: {
    id?: string | null;
    name?: string | null;
  };
  me?: boolean;
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
  artifactPaths?: Record<string, string>;
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
};

type DiscordQaRunResult = {
  outputDir: string;
  reportPath: string;
  reactionTimelinesPath?: string;
  summaryPath: string;
  observedMessagesPath: string;
  gatewayDebugDirPath?: string;
  scenarios: DiscordQaScenarioResult[];
};

type DiscordQaSummary = {
  artifacts: {
    observedMessagesPath: string;
    reactionTimelinesPath?: string;
    reportPath: string;
    summaryPath: string;
  };
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

type DiscordReactionSnapshot = {
  elapsedMs: number;
  observedAt: string;
  reactions: Array<{
    count: number;
    emoji: string;
    me: boolean;
  }>;
};

type DiscordStatusReactionTimeline = {
  expectedSequence: string[];
  htmlPath?: string;
  scenarioId: DiscordQaScenarioId;
  scenarioTitle: string;
  screenshotPath?: string;
  screenshotWarning?: string;
  seenSequence: string[];
  snapshots: DiscordReactionSnapshot[];
  triggerMessageId: string;
};

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
  {
    id: "discord-status-reactions-tool-only",
    title: "Discord explicit status reactions run in tool-only reply mode",
    timeoutMs: 75_000,
    buildRun: () => {
      const token = `DISCORD_QA_STATUS_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        kind: "status-reactions-tool-only",
        input: [
          `Mantis status reaction QA marker ${token}.`,
          "Think briefly, then reply with only this exact marker:",
          token,
        ].join(" "),
        expectedSequence: ["👀", DEFAULT_EMOJIS.thinking, DEFAULT_EMOJIS.done],
      };
    },
  },
];

const DISCORD_QA_DEFAULT_SCENARIOS = DISCORD_QA_SCENARIOS.filter(
  (scenario) => scenario.id !== "discord-status-reactions-tool-only",
);

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
  options: {
    statusReactionsToolOnly?: boolean;
  } = {},
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "discord"])];
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    discord: { enabled: true },
  };
  const requireMention = !options.statusReactionsToolOnly;
  const messages = options.statusReactionsToolOnly
    ? {
        ...baseCfg.messages,
        ackReaction: "👀",
        ackReactionScope: "all" as const,
        groupChat: {
          ...baseCfg.messages?.groupChat,
          visibleReplies: "message_tool" as const,
        },
        statusReactions: {
          ...baseCfg.messages?.statusReactions,
          enabled: true,
          timing: {
            ...baseCfg.messages?.statusReactions?.timing,
            debounceMs: 0,
          },
        },
      }
    : {
        ...baseCfg.messages,
        groupChat: {
          ...baseCfg.messages?.groupChat,
          visibleReplies: "automatic" as const,
        },
      };
  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
    },
    messages,
    channels: {
      ...baseCfg.channels,
      discord: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            token: params.sutBotToken,
            allowBots: options.statusReactionsToolOnly ? true : "mentions",
            groupPolicy: "allowlist",
            guilds: {
              [params.guildId]: {
                requireMention,
                users: [params.driverBotId],
                channels: {
                  [params.channelId]: {
                    enabled: true,
                    requireMention,
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

async function getCurrentDiscordUser(token: string) {
  return await requestDiscord<DiscordUser>("/users/@me", token, {
    timeoutMs: 15_000,
  });
}

async function sendChannelMessage(token: string, channelId: string, content: string) {
  return await requestDiscord<DiscordMessage>(`/channels/${channelId}/messages`, token, {
    body: {
      content,
      allowed_mentions: {
        parse: ["users"],
      },
    },
    timeoutMs: 15_000,
  });
}

async function getChannelMessage(params: { token: string; channelId: string; messageId: string }) {
  return await requestDiscord<DiscordMessage>(
    `/channels/${params.channelId}/messages/${params.messageId}`,
    params.token,
    {
      timeoutMs: 15_000,
    },
  );
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
  return await requestDiscord<DiscordMessage[]>(
    `/channels/${params.channelId}/messages?${query.toString()}`,
    params.token,
    {
      timeoutMs: 15_000,
    },
  );
}

function reactionEmojiName(reaction: DiscordReaction) {
  return reaction.emoji?.name?.trim() || reaction.emoji?.id?.trim() || "";
}

function normalizeDiscordReactionSnapshot(params: {
  message: DiscordMessage;
  observedAt: Date;
  startedAtMs: number;
}): DiscordReactionSnapshot {
  return {
    elapsedMs: Math.max(0, params.observedAt.getTime() - params.startedAtMs),
    observedAt: params.observedAt.toISOString(),
    reactions: (params.message.reactions ?? [])
      .map((reaction) => ({
        emoji: reactionEmojiName(reaction),
        count: Math.max(0, Math.floor(reaction.count ?? 0)),
        me: reaction.me === true,
      }))
      .filter((reaction) => reaction.emoji.length > 0)
      .toSorted((a, b) => a.emoji.localeCompare(b.emoji)),
  };
}

function collectSeenReactionSequence(
  snapshots: readonly DiscordReactionSnapshot[],
  expectedSequence: readonly string[],
) {
  const seen = new Set<string>();
  const sequence: string[] = [];
  for (const snapshot of snapshots) {
    const snapshotEmojis = new Set(snapshot.reactions.map((reaction) => reaction.emoji));
    for (const emoji of expectedSequence) {
      if (snapshotEmojis.has(emoji) && !seen.has(emoji)) {
        seen.add(emoji);
        sequence.push(emoji);
      }
    }
  }
  return sequence;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function renderDiscordStatusReactionHtml(params: {
  expectedSequence: readonly string[];
  scenarioTitle: string;
  seenSequence: readonly string[];
  snapshots: readonly DiscordReactionSnapshot[];
}) {
  const rows = params.snapshots
    .map((snapshot) => {
      const reactions = snapshot.reactions
        .map(
          (reaction) =>
            `<span class="pill"><span class="emoji">${escapeHtml(reaction.emoji)}</span><span class="count">${reaction.count}</span></span>`,
        )
        .join("");
      return `<tr><td>${snapshot.elapsedMs}ms</td><td>${escapeHtml(snapshot.observedAt)}</td><td>${reactions || '<span class="muted">none</span>'}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(params.scenarioTitle)}</title>
  <style>
    body { margin: 0; background: #313338; color: #f2f3f5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: 1040px; padding: 32px; }
    h1 { font-size: 26px; margin: 0 0 8px; font-weight: 700; letter-spacing: 0; }
    .sub { color: #b5bac1; margin-bottom: 24px; }
    .message { background: #2b2d31; border-left: 4px solid #5865f2; padding: 20px; border-radius: 8px; margin-bottom: 24px; }
    .author { color: #f2f3f5; font-weight: 700; margin-bottom: 8px; }
    .content { color: #dbdee1; line-height: 1.45; }
    .sequence { display: flex; gap: 12px; margin-top: 18px; align-items: center; }
    .step { background: #404249; border: 1px solid #4e5058; border-radius: 18px; padding: 7px 12px; font-size: 20px; min-width: 42px; text-align: center; }
    .step.seen { background: #1f3b2d; border-color: #2d7d46; }
    table { width: 100%; border-collapse: collapse; background: #2b2d31; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #404249; vertical-align: top; }
    th { color: #b5bac1; font-size: 13px; text-transform: uppercase; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #4e5058; border-radius: 14px; padding: 4px 9px; margin: 0 8px 8px 0; background: #383a40; }
    .emoji { font-size: 18px; }
    .count { color: #b5bac1; font-size: 13px; }
    .muted { color: #949ba4; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.scenarioTitle)}</h1>
    <div class="sub">Expected: ${params.expectedSequence.map(escapeHtml).join(" → ")} · Seen: ${params.seenSequence.map(escapeHtml).join(" → ") || "none"}</div>
    <section class="message">
      <div class="author">Mantis Discord QA</div>
      <div class="content">Reaction timeline captured from the real Discord triggering message via REST polling.</div>
      <div class="sequence">
        ${params.expectedSequence
          .map(
            (emoji) =>
              `<span class="step ${params.seenSequence.includes(emoji) ? "seen" : ""}">${escapeHtml(emoji)}</span>`,
          )
          .join("")}
      </div>
    </section>
    <table>
      <thead><tr><th>Elapsed</th><th>Observed At</th><th>Reactions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

async function writeDiscordStatusReactionEvidence(params: {
  outputDir: string;
  timeline: DiscordStatusReactionTimeline;
}) {
  const htmlPath = path.join(params.outputDir, `${params.timeline.scenarioId}-timeline.html`);
  const screenshotPath = path.join(params.outputDir, `${params.timeline.scenarioId}-timeline.png`);
  const html = renderDiscordStatusReactionHtml({
    expectedSequence: params.timeline.expectedSequence,
    scenarioTitle: params.timeline.scenarioTitle,
    seenSequence: params.timeline.seenSequence,
    snapshots: params.timeline.snapshots,
  });
  await fs.writeFile(htmlPath, html, { encoding: "utf8", mode: 0o600 });
  try {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1104, height: 760 } });
      await page.goto(pathToFileURL(htmlPath).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      return { htmlPath, screenshotPath };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { htmlPath, screenshotWarning: formatErrorMessage(error) };
  }
}

async function observeStatusReactionTimeline(params: {
  channelId: string;
  expectedSequence: string[];
  messageId: string;
  scenarioId: DiscordQaScenarioId;
  scenarioTitle: string;
  timeoutMs: number;
  token: string;
}) {
  const startedAtMs = Date.now();
  const snapshots: DiscordReactionSnapshot[] = [];
  let seenSequence: string[] = [];
  while (Date.now() - startedAtMs < params.timeoutMs) {
    const observedAt = new Date();
    const message = await getChannelMessage({
      token: params.token,
      channelId: params.channelId,
      messageId: params.messageId,
    });
    snapshots.push(
      normalizeDiscordReactionSnapshot({
        message,
        observedAt,
        startedAtMs,
      }),
    );
    seenSequence = collectSeenReactionSequence(snapshots, params.expectedSequence);
    if (params.expectedSequence.every((emoji) => seenSequence.includes(emoji))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    expectedSequence: params.expectedSequence,
    scenarioId: params.scenarioId,
    scenarioTitle: params.scenarioTitle,
    seenSequence,
    snapshots,
    triggerMessageId: params.messageId,
  } satisfies DiscordStatusReactionTimeline;
}

async function listApplicationCommands(params: { token: string; applicationId: string }) {
  return await requestDiscord<DiscordApplicationCommand[]>(
    `/applications/${params.applicationId}/commands`,
    params.token,
    {
      timeoutMs: 15_000,
    },
  );
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
    if (scenario.artifactPaths && Object.keys(scenario.artifactPaths).length > 0) {
      for (const [label, artifactPath] of Object.entries(scenario.artifactPaths)) {
        lines.push(`- ${label}: \`${artifactPath}\``);
      }
    }
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
  const scenarios = ids && ids.length > 0 ? DISCORD_QA_SCENARIOS : DISCORD_QA_DEFAULT_SCENARIOS;
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Discord",
    scenarios,
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
  const statusReactionScenarioRequested = scenarios.some(
    (scenario) => scenario.id === "discord-status-reactions-tool-only",
  );
  if (statusReactionScenarioRequested && scenarios.length > 1) {
    throw new Error(
      "discord-status-reactions-tool-only must run by itself because it changes Discord tool-only reply config.",
    );
  }

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
  const reactionTimelines: DiscordStatusReactionTimeline[] = [];
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
        buildDiscordQaConfig(
          cfg,
          {
            guildId: runtimeEnv.guildId,
            channelId: runtimeEnv.channelId,
            driverBotId: driverIdentity.id,
            sutAccountId,
            sutBotToken: runtimeEnv.sutBotToken,
          },
          { statusReactionsToolOnly: statusReactionScenarioRequested },
        ),
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
          if (scenarioRun.kind === "status-reactions-tool-only") {
            const timeline = await observeStatusReactionTimeline({
              token: runtimeEnv.driverBotToken,
              channelId: runtimeEnv.channelId,
              expectedSequence: scenarioRun.expectedSequence,
              messageId: sent.id,
              scenarioId: scenario.id,
              scenarioTitle: scenario.title,
              timeoutMs: scenario.timeoutMs,
            });
            const evidence = await writeDiscordStatusReactionEvidence({ outputDir, timeline });
            const enrichedTimeline = { ...timeline, ...evidence };
            reactionTimelines.push(enrichedTimeline);
            const missing = scenarioRun.expectedSequence.filter(
              (emoji) => !timeline.seenSequence.includes(emoji),
            );
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              status: missing.length === 0 ? "pass" : "fail",
              details:
                missing.length === 0
                  ? `reaction timeline matched ${timeline.seenSequence.join(" -> ")}`
                  : `reaction timeline missing ${missing.join(", ")}; saw ${timeline.seenSequence.join(" -> ") || "none"}`,
              artifactPaths: {
                ...(enrichedTimeline.htmlPath ? { html: enrichedTimeline.htmlPath } : {}),
                ...(enrichedTimeline.screenshotPath
                  ? { screenshot: enrichedTimeline.screenshotPath }
                  : {}),
              },
            });
            continue;
          }
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
    artifacts: {
      reportPath: path.join(outputDir, "discord-qa-report.md"),
      summaryPath: path.join(outputDir, "discord-qa-summary.json"),
      observedMessagesPath: path.join(outputDir, "discord-qa-observed-messages.json"),
      ...(reactionTimelines.length > 0
        ? { reactionTimelinesPath: path.join(outputDir, "discord-qa-reaction-timelines.json") }
        : {}),
    },
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
  const reactionTimelinesPath = path.join(outputDir, "discord-qa-reaction-timelines.json");
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
  if (reactionTimelines.length > 0) {
    await fs.writeFile(reactionTimelinesPath, `${JSON.stringify(reactionTimelines, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const artifactPaths = {
    report: reportPath,
    summary: summaryPath,
    observedMessages: observedMessagesPath,
    ...(reactionTimelines.length > 0 ? { reactionTimelines: reactionTimelinesPath } : {}),
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
    ...(reactionTimelines.length > 0 ? { reactionTimelinesPath } : {}),
    summaryPath,
    observedMessagesPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebugDirPath } : {}),
    scenarios: scenarioResults,
  };
}

export const __testing = {
  DISCORD_QA_SCENARIOS,
  DISCORD_QA_STANDARD_SCENARIO_IDS,
  collectSeenReactionSequence,
  assertDiscordScenarioReply,
  assertDiscordApplicationCommandsRegistered,
  buildDiscordQaConfig,
  buildObservedMessagesArtifact,
  findScenario,
  getCurrentDiscordUser,
  getChannelMessage,
  listApplicationCommands,
  matchesDiscordScenarioReply,
  normalizeDiscordReactionSnapshot,
  normalizeDiscordObservedMessage,
  parseDiscordQaCredentialPayload,
  renderDiscordStatusReactionHtml,
  resolveDiscordQaRuntimeEnv,
  waitForDiscordChannelRunning,
};
