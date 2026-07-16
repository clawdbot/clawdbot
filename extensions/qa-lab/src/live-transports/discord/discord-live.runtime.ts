// QA Lab plugin module implements Discord scenario support helpers.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DiscordApiError,
  handleDiscordMessageAction,
  requestDiscord,
} from "@openclaw/discord/api.js";
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { chromium } from "playwright-core";
import { z } from "zod";
import { startQaGatewayChild } from "../../gateway-child.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import { listQaScenariosForExecutionProfile } from "../../scenario-catalog.js";
import { assertLiveScenarioReply as assertDiscordScenarioReply } from "../shared/live-scenario-reply.js";

type DiscordQaRuntimeEnv = {
  guildId: string;
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutApplicationId: string;
  voiceChannelId?: string;
};

type DiscordQaScenarioId =
  | "discord-canary"
  | "discord-mention-gating"
  | "discord-native-help-command-registration"
  | "discord-voice-autojoin"
  | "discord-thread-reply-filepath-attachment"
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
      kind: "voice-autojoin";
    }
  | {
      kind: "status-reactions-tool-only";
      expectedSequence: string[];
      input: string;
    }
  | {
      kind: "thread-reply-filepath-attachment";
      expectedAttachmentFilename: string;
      input: string;
      replyContent: string;
    };

type DiscordQaScenarioDefinition = {
  id: DiscordQaScenarioId;
  title: string;
  timeoutMs: number;
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
  attachments?: DiscordAttachment[];
  content?: string;
  reactions?: DiscordReaction[];
  timestamp?: string;
  author?: DiscordUser;
  referenced_message?: { id?: string } | null;
};

type DiscordAttachment = {
  id?: string;
  filename?: string;
  size?: number;
  url?: string;
};

type DiscordThread = {
  id: string;
  name?: string;
  parent_id?: string;
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

type DiscordChannel = {
  id: string;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
  position?: number;
  type: number;
};

type DiscordVoiceState = {
  channel_id?: string | null;
  guild_id?: string;
  user_id?: string;
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
  triggerMessageId?: string;
  triggerTimestamp?: string;
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
  triggerMessageId?: string;
  triggerTimestamp?: string;
  replyToMessageId?: string;
  timestamp?: string;
};

type DiscordQaScenarioResult = {
  artifactPaths?: Record<string, string>;
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
  requestStartedAt?: string;
  responseObservedAt?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs: number;
    requestStartedAt: string;
    responseObservedAt: string;
    source: "request-to-observed-message";
  };
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

type DiscordThreadReplyAttachmentEvidence = {
  attachmentFilenames: string[];
  channelId?: string;
  discordWebUrl?: string;
  expectedAttachmentFilename: string;
  guildId?: string;
  htmlPath?: string;
  messageContent?: string;
  messageId?: string;
  parentMessageId?: string;
  scenarioId: DiscordQaScenarioId;
  scenarioTitle: string;
  screenshotPath?: string;
  screenshotWarning?: string;
  status: "pass" | "fail";
  threadId: string;
  threadName: string;
};

const DISCORD_QA_CAPTURE_UI_METADATA_ENV = "OPENCLAW_QA_DISCORD_CAPTURE_UI_METADATA";
const DISCORD_QA_KEEP_THREADS_ENV = "OPENCLAW_QA_DISCORD_KEEP_THREADS";
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
    id: "discord-voice-autojoin",
    title: "Discord voice auto-join connects",
    timeoutMs: 60_000,
    buildRun: () => ({
      kind: "voice-autojoin",
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
  {
    id: "discord-thread-reply-filepath-attachment",
    title: "Discord thread reply preserves filePath attachment",
    timeoutMs: 45_000,
    buildRun: () => {
      const token = `DISCORD_QA_THREAD_FILE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        kind: "thread-reply-filepath-attachment",
        input: `Mantis Discord thread attachment parent ${token}`,
        replyContent: `Mantis thread attachment reply ${token}`,
        expectedAttachmentFilename: "mantis-thread-report.md",
      };
    },
  },
];

const discordQaCredentialPayloadSchema = z.object({
  guildId: z.string().trim().min(1),
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutApplicationId: z.string().trim().min(1),
  voiceChannelId: z.string().trim().min(1).optional(),
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

function resolveDiscordQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): DiscordQaRuntimeEnv {
  const voiceChannelId = env.OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID?.trim();
  const runtimeEnv = {
    guildId: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_GUILD_ID"),
    channelId: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_CHANNEL_ID"),
    driverBotToken: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN"),
    sutBotToken: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN"),
    sutApplicationId: resolveEnvValue(env, "OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID"),
    ...(voiceChannelId ? { voiceChannelId } : {}),
  };
  validateDiscordQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_DISCORD");
  return runtimeEnv;
}

function validateDiscordQaRuntimeEnv(runtimeEnv: DiscordQaRuntimeEnv, prefix: string) {
  assertDiscordSnowflake(runtimeEnv.guildId, `${prefix}_GUILD_ID`);
  assertDiscordSnowflake(runtimeEnv.channelId, `${prefix}_CHANNEL_ID`);
  assertDiscordSnowflake(runtimeEnv.sutApplicationId, `${prefix}_SUT_APPLICATION_ID`);
  if (runtimeEnv.voiceChannelId) {
    assertDiscordSnowflake(runtimeEnv.voiceChannelId, `${prefix}_VOICE_CHANNEL_ID`);
  }
}

function parseDiscordQaCredentialPayload(payload: unknown): DiscordQaRuntimeEnv {
  const parsed = discordQaCredentialPayloadSchema.parse(payload);
  const runtimeEnv = {
    guildId: parsed.guildId,
    channelId: parsed.channelId,
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutApplicationId: parsed.sutApplicationId,
    ...(parsed.voiceChannelId ? { voiceChannelId: parsed.voiceChannelId } : {}),
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
    voiceAutoJoin?: {
      channelId: string;
      guildId: string;
    };
  } = {},
): OpenClawConfig {
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "discord"]);
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    discord: { enabled: true },
  };
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
  const voiceConfig = options.voiceAutoJoin
    ? {
        ...baseCfg.channels?.discord?.voice,
        enabled: true,
        mode: "stt-tts" as const,
        autoJoin: [options.voiceAutoJoin],
      }
    : undefined;
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
        ...(voiceConfig ? { voice: voiceConfig } : {}),
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            token: params.sutBotToken,
            allowBots: options.statusReactionsToolOnly ? true : "mentions",
            groupPolicy: "allowlist",
            guilds: {
              [params.guildId]: {
                requireMention: !options.statusReactionsToolOnly,
                users: [params.driverBotId],
                channels: {
                  [params.channelId]: {
                    enabled: true,
                    requireMention: !options.statusReactionsToolOnly,
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

async function listGuildChannels(params: { token: string; guildId: string }) {
  return await requestDiscord<DiscordChannel[]>(
    `/guilds/${params.guildId}/channels`,
    params.token,
    {
      timeoutMs: 15_000,
    },
  );
}

async function getDiscordChannel(params: { token: string; channelId: string }) {
  return await requestDiscord<DiscordChannel>(`/channels/${params.channelId}`, params.token, {
    timeoutMs: 15_000,
  });
}

function isDiscordVoiceChannel(channel: DiscordChannel) {
  return channel.type === 2 || channel.type === 13;
}

async function resolveDiscordQaVoiceChannel(params: {
  guildId: string;
  token: string;
  voiceChannelId?: string;
}) {
  if (params.voiceChannelId) {
    const channel = await getDiscordChannel({
      token: params.token,
      channelId: params.voiceChannelId,
    });
    if (!isDiscordVoiceChannel(channel)) {
      throw new Error(`Discord voiceChannelId ${params.voiceChannelId} is not a voice channel.`);
    }
    if (channel.guild_id && channel.guild_id !== params.guildId) {
      throw new Error(
        `Discord voiceChannelId ${params.voiceChannelId} belongs to guild ${channel.guild_id}, not ${params.guildId}.`,
      );
    }
    return channel;
  }

  const channels = await listGuildChannels({ token: params.token, guildId: params.guildId });
  const voiceChannels = channels
    .filter(isDiscordVoiceChannel)
    .toSorted(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id.localeCompare(b.id),
    );
  const first = voiceChannels[0];
  if (!first) {
    throw new Error(
      "Discord voice auto-join scenario could not find a visible voice/stage channel for the SUT bot. Add voiceChannelId to the Convex discord credential payload or set OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID.",
    );
  }
  return first;
}

async function getCurrentDiscordVoiceState(params: { token: string; guildId: string }) {
  try {
    return await requestDiscord<DiscordVoiceState>(
      `/guilds/${params.guildId}/voice-states/@me`,
      params.token,
      {
        timeoutMs: 15_000,
      },
    );
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function waitForDiscordVoiceState(params: {
  channelId: string;
  guildId: string;
  sutBotId: string;
  timeoutMs: number;
  token: string;
}) {
  const startedAt = Date.now();
  let lastState: DiscordVoiceState | null = null;
  let lastError: string | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const state = await getCurrentDiscordVoiceState({
        token: params.token,
        guildId: params.guildId,
      });
      lastState = state;
      lastError = undefined;
      if (
        state?.channel_id === params.channelId &&
        (!state.user_id || state.user_id === params.sutBotId)
      ) {
        return state;
      }
    } catch (error) {
      lastError = formatErrorMessage(error);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  const stateDetails = lastState
    ? `last voice state channel=${lastState.channel_id ?? "none"} user=${lastState.user_id ?? "unknown"}`
    : "no current voice state";
  throw new Error(
    `SUT bot did not join Discord voice channel ${params.channelId} (${stateDetails}${
      lastError ? `; last error: ${lastError}` : ""
    })`,
  );
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

async function createThreadFromMessage(params: {
  token: string;
  channelId: string;
  messageId: string;
  name: string;
}) {
  return await requestDiscord<DiscordThread>(
    `/channels/${params.channelId}/messages/${params.messageId}/threads`,
    params.token,
    {
      body: {
        name: params.name,
        auto_archive_duration: 60,
      },
      timeoutMs: 15_000,
    },
  );
}

async function archiveDiscordThread(params: { token: string; threadId: string }) {
  await requestDiscord<DiscordThread>(`/channels/${params.threadId}`, params.token, {
    body: {
      archived: true,
    },
    method: "PATCH",
    timeoutMs: 15_000,
  });
}

async function joinDiscordThread(params: { token: string; threadId: string }) {
  await requestDiscord<void>(`/channels/${params.threadId}/thread-members/@me`, params.token, {
    method: "PUT",
    timeoutMs: 15_000,
  });
}

async function listThreadMessages(params: { token: string; threadId: string }) {
  return await requestDiscord<DiscordMessage[]>(
    `/channels/${params.threadId}/messages?limit=50`,
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

function computeDiscordRttMs(triggerTimestamp?: string, replyTimestamp?: string) {
  if (!triggerTimestamp || !replyTimestamp) {
    return undefined;
  }
  const triggerAtMs = Date.parse(triggerTimestamp);
  const replyAtMs = Date.parse(replyTimestamp);
  if (!Number.isFinite(triggerAtMs) || !Number.isFinite(replyAtMs)) {
    return undefined;
  }
  return Math.max(0, Math.round(replyAtMs - triggerAtMs));
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
  const screenshot = await writeHtmlScreenshot({ htmlPath, screenshotPath });
  return { htmlPath, ...screenshot };
}

async function writeHtmlScreenshot(params: { htmlPath: string; screenshotPath: string }) {
  try {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1104, height: 760 } });
      await page.goto(pathToFileURL(params.htmlPath).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await fs.mkdir(path.dirname(params.screenshotPath), { recursive: true });
      await writeExternalFileWithinRoot({
        rootDir: path.dirname(params.screenshotPath),
        path: path.basename(params.screenshotPath),
        write: async (tempPath) => {
          await page.screenshot({ path: tempPath, fullPage: true });
        },
      });
      return { screenshotPath: params.screenshotPath };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { screenshotWarning: formatErrorMessage(error) };
  }
}

function renderDiscordThreadReplyAttachmentHtml(params: {
  attachmentFilenames: readonly string[];
  expectedAttachmentFilename: string;
  messageContent?: string;
  scenarioTitle: string;
  status: "pass" | "fail";
  threadName: string;
}) {
  const hasAttachment = params.attachmentFilenames.includes(params.expectedAttachmentFilename);
  const attachmentRows =
    params.attachmentFilenames.length > 0
      ? params.attachmentFilenames
          .map((filename) => `<span class="attachment">${escapeHtml(filename)}</span>`)
          .join("")
      : '<span class="missing">No attachments on the SUT thread reply</span>';
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
    .message { background: #2b2d31; border-left: 4px solid ${hasAttachment ? "#23a55a" : "#da373c"}; padding: 20px; border-radius: 8px; }
    .author { color: #f2f3f5; font-weight: 700; margin-bottom: 8px; }
    .content { color: #dbdee1; line-height: 1.45; margin-bottom: 16px; }
    .badge { display: inline-flex; align-items: center; border-radius: 16px; padding: 6px 10px; font-size: 13px; font-weight: 700; background: ${hasAttachment ? "#1f3b2d" : "#4a2527"}; border: 1px solid ${hasAttachment ? "#2d7d46" : "#a1282e"}; color: #f2f3f5; margin-bottom: 18px; }
    .attachments { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
    .attachment { display: inline-flex; align-items: center; gap: 8px; border: 1px solid #5865f2; background: #202136; color: #cfd4ff; border-radius: 6px; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .attachment::before { content: "file"; color: #b5bac1; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 12px; text-transform: uppercase; }
    .missing { color: #ffb4b4; border: 1px solid #a1282e; background: #3a2023; border-radius: 6px; padding: 10px 12px; }
    .expected { color: #b5bac1; margin-top: 18px; font-size: 14px; }
    code { color: #f2f3f5; background: #1e1f22; border-radius: 4px; padding: 2px 5px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.scenarioTitle)}</h1>
    <div class="sub">Thread: ${escapeHtml(params.threadName)}</div>
    <section class="message">
      <div class="author">OpenClaw Discord SUT</div>
      <div class="badge">${params.status === "pass" ? "Attachment found" : "Attachment missing"}</div>
      <div class="content">${escapeHtml(params.messageContent ?? "No SUT reply content captured")}</div>
      <div class="attachments">${attachmentRows}</div>
      <div class="expected">Expected attachment: <code>${escapeHtml(params.expectedAttachmentFilename)}</code></div>
    </section>
  </main>
</body>
</html>`;
}

async function writeDiscordThreadReplyAttachmentEvidence(params: {
  evidence: DiscordThreadReplyAttachmentEvidence;
  outputDir: string;
}) {
  const htmlPath = path.join(params.outputDir, `${params.evidence.scenarioId}-attachment.html`);
  const uiPath = params.evidence.discordWebUrl
    ? path.join(params.outputDir, `${params.evidence.scenarioId}-ui.json`)
    : undefined;
  const screenshotPath = path.join(
    params.outputDir,
    `${params.evidence.scenarioId}-attachment.png`,
  );
  const html = renderDiscordThreadReplyAttachmentHtml({
    attachmentFilenames: params.evidence.attachmentFilenames,
    expectedAttachmentFilename: params.evidence.expectedAttachmentFilename,
    messageContent: params.evidence.messageContent,
    scenarioTitle: params.evidence.scenarioTitle,
    status: params.evidence.status,
    threadName: params.evidence.threadName,
  });
  await fs.writeFile(htmlPath, html, { encoding: "utf8", mode: 0o600 });
  if (uiPath) {
    await fs.writeFile(
      uiPath,
      `${JSON.stringify(
        {
          attachmentFilenames: params.evidence.attachmentFilenames,
          channelId: params.evidence.channelId,
          discordWebUrl: params.evidence.discordWebUrl,
          expectedAttachmentFilename: params.evidence.expectedAttachmentFilename,
          guildId: params.evidence.guildId,
          messageContent: params.evidence.messageContent,
          messageId: params.evidence.messageId,
          parentMessageId: params.evidence.parentMessageId,
          scenarioId: params.evidence.scenarioId,
          scenarioTitle: params.evidence.scenarioTitle,
          status: params.evidence.status,
          threadId: params.evidence.threadId,
          threadName: params.evidence.threadName,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const screenshot = await writeHtmlScreenshot({ htmlPath, screenshotPath });
  return { htmlPath, ...(uiPath ? { uiPath } : {}), ...screenshot };
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
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
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

function buildDiscordWebMessageUrl(params: {
  guildId: string;
  messageId?: string;
  threadId: string;
}) {
  return `https://discord.com/channels/${params.guildId}/${params.threadId}${
    params.messageId ? `/${params.messageId}` : ""
  }`;
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
  triggerMessageId?: string;
  triggerTimestamp?: string;
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
        triggerMessageId: params.triggerMessageId,
        triggerTimestamp: params.triggerTimestamp,
      };
      params.observedMessages.push(observedMessage);
      if (matchedScenario) {
        return { message: observedMessage, afterSnowflake };
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Discord message`);
}

async function pollThreadReplyMessage(params: {
  token: string;
  threadId: string;
  replyContent: string;
  sutBotId: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listThreadMessages({
      token: params.token,
      threadId: params.threadId,
    });
    const match = messages.find(
      (message) =>
        message.author?.id === params.sutBotId &&
        Boolean(message.content?.includes(params.replyContent)),
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  return undefined;
}

async function runDiscordThreadReplyFilePathAttachmentScenario(params: {
  cfg: OpenClawConfig;
  driverBotId: string;
  outputDir: string;
  runtimeEnv: DiscordQaRuntimeEnv;
  scenario: DiscordQaScenarioDefinition;
  scenarioRun: Extract<DiscordQaScenarioRun, { kind: "thread-reply-filepath-attachment" }>;
  sutAccountId: string;
  sutBotId: string;
}) {
  const captureUiMetadata = isTruthyOptIn(process.env[DISCORD_QA_CAPTURE_UI_METADATA_ENV]);
  const keepThread = isTruthyOptIn(process.env[DISCORD_QA_KEEP_THREADS_ENV]);
  const threadName = `mantis-thread-filepath-${randomUUID().slice(0, 8)}`;
  const parent = await sendChannelMessage(
    params.runtimeEnv.driverBotToken,
    params.runtimeEnv.channelId,
    params.scenarioRun.input,
  );
  const thread = await createThreadFromMessage({
    token: params.runtimeEnv.driverBotToken,
    channelId: params.runtimeEnv.channelId,
    messageId: parent.id,
    name: threadName,
  });
  const attachmentPath = path.join(params.outputDir, params.scenarioRun.expectedAttachmentFilename);
  await fs.writeFile(
    attachmentPath,
    [
      "# Mantis Discord Thread Attachment",
      "",
      `Parent message: ${parent.id}`,
      `Thread: ${thread.id}`,
      `Marker: ${params.scenarioRun.replyContent}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    await joinDiscordThread({
      token: params.runtimeEnv.sutBotToken,
      threadId: thread.id,
    });
    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        threadId: thread.id,
        message: params.scenarioRun.replyContent,
        filePath: attachmentPath,
      },
      cfg: params.cfg,
      accountId: params.sutAccountId,
      requesterSenderId: params.driverBotId,
      mediaLocalRoots: [params.outputDir],
      mediaReadFile: async (filePath) => await fs.readFile(filePath),
    });

    const reply = await pollThreadReplyMessage({
      token: params.runtimeEnv.driverBotToken,
      threadId: thread.id,
      replyContent: params.scenarioRun.replyContent,
      sutBotId: params.sutBotId,
      timeoutMs: params.scenario.timeoutMs,
    });
    const attachmentFilenames = (reply?.attachments ?? [])
      .map((attachment) => attachment.filename?.trim() ?? "")
      .filter(Boolean)
      .toSorted();
    const status = attachmentFilenames.includes(params.scenarioRun.expectedAttachmentFilename)
      ? "pass"
      : "fail";
    const discordWebUrl = buildDiscordWebMessageUrl({
      guildId: params.runtimeEnv.guildId,
      messageId: reply?.id,
      threadId: thread.id,
    });
    const evidence: DiscordThreadReplyAttachmentEvidence = {
      attachmentFilenames,
      ...(captureUiMetadata
        ? {
            channelId: params.runtimeEnv.channelId,
            discordWebUrl,
            guildId: params.runtimeEnv.guildId,
            parentMessageId: parent.id,
          }
        : {}),
      expectedAttachmentFilename: params.scenarioRun.expectedAttachmentFilename,
      messageContent: reply?.content,
      messageId: reply?.id,
      scenarioId: params.scenario.id,
      scenarioTitle: params.scenario.title,
      status,
      threadId: thread.id,
      threadName,
    };
    const artifactEvidence = await writeDiscordThreadReplyAttachmentEvidence({
      evidence,
      outputDir: params.outputDir,
    });
    return {
      id: params.scenario.id,
      title: params.scenario.title,
      status,
      details:
        status === "pass"
          ? `thread reply attached ${params.scenarioRun.expectedAttachmentFilename}`
          : reply
            ? `thread reply omitted ${params.scenarioRun.expectedAttachmentFilename}; saw ${attachmentFilenames.join(", ") || "no attachments"}`
            : "thread reply was not observed",
      artifactPaths: {
        attachmentSource: attachmentPath,
        html: artifactEvidence.htmlPath,
        ...(artifactEvidence.screenshotPath ? { screenshot: artifactEvidence.screenshotPath } : {}),
        ...(artifactEvidence.uiPath ? { ui: artifactEvidence.uiPath } : {}),
      },
    } satisfies DiscordQaScenarioResult;
  } finally {
    if (!keepThread) {
      await archiveDiscordThread({
        token: params.runtimeEnv.driverBotToken,
        threadId: thread.id,
      }).catch(() => {});
    }
  }
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
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  const details = lastStatus
    ? ` (last status: running=${String(lastStatus.running)} connected=${String(lastStatus.connected)} restartPending=${String(lastStatus.restartPending)} lastConnectedAt=${String(lastStatus.lastConnectedAt)} lastError=${lastStatus.lastError ?? "null"} lastDisconnect=${JSON.stringify(lastStatus.lastDisconnect)})`
    : "";
  throw new Error(`discord account "${accountId}" did not become connected${details}`);
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
          triggerTimestamp: message.triggerTimestamp,
          timestamp: message.timestamp,
        }
      : {
          ...scenarioContext,
          messageId: message.messageId,
          channelId: message.channelId,
          guildId: message.guildId,
          senderId: message.senderId,
          senderIsBot: message.senderIsBot,
          senderUsername: message.senderUsername,
          triggerMessageId: message.triggerMessageId,
          triggerTimestamp: message.triggerTimestamp,
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
  const requestedIds =
    ids && ids.length > 0
      ? ids
      : listQaScenariosForExecutionProfile("discord:adapter").map((scenario) => scenario.id);
  const scenariosById = new Map(DISCORD_QA_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  const missingIds = requestedIds.filter((id) => !scenariosById.has(id as DiscordQaScenarioId));
  if (missingIds.length > 0) {
    throw new Error(`unknown Discord QA scenario id(s): ${missingIds.join(", ")}`);
  }
  return requestedIds.map((id) => scenariosById.get(id as DiscordQaScenarioId)!);
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
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    `missing Discord native command(s): ${params.expectedCommandNames
      .filter((name) => !lastNames.includes(name))
      .join(", ")} (registered: ${lastNames.join(", ") || "none"})`,
  );
}

const testing = {
  DISCORD_QA_SCENARIOS,
  collectSeenReactionSequence,
  assertDiscordScenarioReply,
  assertDiscordApplicationCommandsRegistered,
  buildDiscordQaConfig,
  buildDiscordWebMessageUrl,
  buildObservedMessagesArtifact,
  computeDiscordRttMs,
  findScenario,
  getCurrentDiscordUser,
  observeStatusReactionTimeline,
  pollChannelMessages,
  runDiscordThreadReplyFilePathAttachmentScenario,
  sendChannelMessage,
  getChannelMessage,
  getCurrentDiscordVoiceState,
  listApplicationCommands,
  resolveDiscordQaVoiceChannel,
  matchesDiscordScenarioReply,
  normalizeDiscordReactionSnapshot,
  normalizeDiscordObservedMessage,
  parseDiscordQaCredentialPayload,
  renderDiscordStatusReactionHtml,
  renderDiscordThreadReplyAttachmentHtml,
  resolveDiscordQaRuntimeEnv,
  waitForDiscordChannelRunning,
  waitForDiscordVoiceState,
  writeDiscordStatusReactionEvidence,
};

export const discordQaScenarioSupport = {
  testing,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
