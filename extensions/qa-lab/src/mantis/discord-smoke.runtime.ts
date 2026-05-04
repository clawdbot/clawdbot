import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";

export type MantisDiscordSmokeOptions = {
  channelId?: string;
  env?: NodeJS.ProcessEnv;
  guildId?: string;
  message?: string;
  now?: () => Date;
  outputDir?: string;
  redactPublicMetadata?: boolean;
  repoRoot?: string;
  skipPost?: boolean;
  token?: string;
  tokenEnv?: string;
  tokenFile?: string;
  tokenFileEnv?: string;
};

export type MantisDiscordSmokeResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  status: "pass" | "fail";
};

type DiscordUser = {
  id: string;
  username?: string;
};

type DiscordGuild = {
  id: string;
  name?: string;
};

type DiscordChannel = {
  guild_id?: string;
  id: string;
  name?: string;
  type?: number;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
};

type DiscordApiCall = {
  label: string;
  method: string;
  ok: boolean;
  path: string;
  status: number;
};

type MantisDiscordSmokeSummary = {
  apiCalls: DiscordApiCall[];
  artifacts: {
    reportPath: string;
    summaryPath: string;
  };
  bot?: {
    id: string;
    username?: string;
  };
  channel?: {
    id: string;
    name?: string;
    type?: number;
  };
  finishedAt: string;
  guild?: {
    id: string;
    name?: string;
  };
  message?: {
    id: string;
    posted: boolean;
    reactionAdded: boolean;
  };
  metadataRedaction: boolean;
  outputDir: string;
  reportPath: string;
  startedAt: string;
  status: "pass" | "fail";
  summaryPath: string;
  tokenSource: "env" | "file" | "option";
};

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_MANTIS_TOKEN_ENV = "OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN";
const DEFAULT_MANTIS_TOKEN_FILE_ENV = "OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN_FILE";
const DEFAULT_GUILD_ID_ENV = "OPENCLAW_QA_DISCORD_GUILD_ID";
const DEFAULT_CHANNEL_ID_ENV = "OPENCLAW_QA_DISCORD_CHANNEL_ID";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function assertDiscordSnowflake(value: string, label: string) {
  if (!/^\d{17,20}$/u.test(value)) {
    throw new Error(`${label} must be a Discord snowflake.`);
  }
}

async function readTokenFile(filePath: string) {
  const token = trimToValue(await fs.readFile(filePath, "utf8"));
  if (!token) {
    throw new Error(`Mantis Discord token file is empty: ${filePath}`);
  }
  return token;
}

async function resolveMantisDiscordToken(opts: MantisDiscordSmokeOptions) {
  const env = opts.env ?? process.env;
  const tokenEnv = trimToValue(opts.tokenEnv) ?? DEFAULT_MANTIS_TOKEN_ENV;
  const tokenFileEnv = trimToValue(opts.tokenFileEnv) ?? DEFAULT_MANTIS_TOKEN_FILE_ENV;
  const optionToken = trimToValue(opts.token);
  if (optionToken) {
    return { source: "option" as const, token: optionToken };
  }
  const envToken = trimToValue(env[tokenEnv]);
  if (envToken) {
    return { source: "env" as const, token: envToken };
  }
  const tokenFile = trimToValue(opts.tokenFile) ?? trimToValue(env[tokenFileEnv]);
  if (tokenFile) {
    return { source: "file" as const, token: await readTokenFile(tokenFile) };
  }
  throw new Error(
    `Missing Mantis Discord bot token. Set ${tokenEnv}, ${tokenFileEnv}, or pass --token-file.`,
  );
}

function resolveRequiredSnowflake(params: {
  env: NodeJS.ProcessEnv;
  envKey: string;
  label: string;
  value?: string;
}) {
  const resolved = trimToValue(params.value) ?? trimToValue(params.env[params.envKey]);
  if (!resolved) {
    throw new Error(`Missing ${params.envKey}.`);
  }
  assertDiscordSnowflake(resolved, params.label);
  return resolved;
}

function assertMantisDiscordChannelInGuild(params: {
  channel: DiscordChannel;
  guildChannels: readonly DiscordChannel[];
  guildId: string;
  channelId: string;
}) {
  if (!params.guildChannels.some((channel) => channel.id === params.channelId)) {
    throw new Error(
      `OPENCLAW_QA_DISCORD_CHANNEL_ID ${params.channelId} is not in guild ${params.guildId}.`,
    );
  }
  if (params.channel.guild_id && params.channel.guild_id !== params.guildId) {
    throw new Error(
      `OPENCLAW_QA_DISCORD_CHANNEL_ID ${params.channelId} belongs to guild ${params.channel.guild_id}, not ${params.guildId}.`,
    );
  }
}

function defaultMantisDiscordSmokeOutputDir(repoRoot: string, startedAt: Date) {
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `discord-smoke-${stamp}`);
}

async function callDiscordApi<T>(params: {
  apiCalls: DiscordApiCall[];
  body?: unknown;
  label: string;
  method?: string;
  path: string;
  token: string;
}) {
  const method = params.method ?? "GET";
  const headers = new Headers();
  headers.set("authorization", `Bot ${params.token}`);
  let body: string | undefined;
  if (params.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(params.body);
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${DISCORD_API_BASE_URL}${params.path}`,
    init: {
      method,
      headers,
      body,
    },
    signal: AbortSignal.timeout(15_000),
    policy: { hostnameAllowlist: ["discord.com"] },
    auditContext: "qa-lab-mantis-discord-smoke",
  });
  try {
    const text = await response.text();
    const payload = text.trim() ? (JSON.parse(text) as unknown) : undefined;
    params.apiCalls.push({
      label: params.label,
      method,
      ok: response.ok,
      path: params.path,
      status: response.status,
    });
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
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

function renderMantisDiscordSmokeReport(summary: MantisDiscordSmokeSummary) {
  const lines = [
    "# Mantis Discord Smoke",
    "",
    `Status: ${summary.status}`,
    `Metadata redaction: ${summary.metadataRedaction ? "enabled" : "disabled"}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    `Output: ${summary.outputDir}`,
    "",
    "## Target",
    "",
    `- Bot: ${summary.bot?.username ?? "unknown"} (${summary.bot?.id ?? "unknown"})`,
    `- Guild: ${summary.guild?.name ?? "unknown"} (${summary.guild?.id ?? "unknown"})`,
    `- Channel: #${summary.channel?.name ?? "unknown"} (${summary.channel?.id ?? "unknown"})`,
    "",
    "## Message",
    "",
    summary.message?.posted
      ? `- Posted message: ${summary.message.id}`
      : "- Posted message: skipped",
    summary.message?.reactionAdded ? "- Added reaction: yes" : "- Added reaction: no",
    "",
    "## Discord API Calls",
    "",
    "| Label | Method | Status |",
    "| --- | --- | --- |",
    ...summary.apiCalls.map((call) => `| ${call.label} | ${call.method} | ${call.status} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function addSensitiveValue(values: Set<string>, value: string | undefined) {
  const resolved = trimToValue(value);
  if (resolved && resolved !== "<redacted>") {
    values.add(resolved);
  }
}

function redactMantisDiscordMetadata(text: string, sensitiveValues: ReadonlySet<string>) {
  let redacted = text;
  const sortedValues = [...sensitiveValues].toSorted((a, b) => b.length - a.length);
  for (const value of sortedValues) {
    redacted = redacted.replaceAll(value, "<redacted>");
  }
  return redacted;
}

function buildPublishedMantisDiscordSmokeSummary(
  summary: MantisDiscordSmokeSummary,
  sensitiveValues: ReadonlySet<string>,
): MantisDiscordSmokeSummary {
  if (!summary.metadataRedaction) {
    return summary;
  }
  return {
    ...summary,
    apiCalls: summary.apiCalls.map((call) => ({
      ...call,
      path: redactMantisDiscordMetadata(call.path, sensitiveValues),
    })),
    bot: summary.bot
      ? {
          id: "<redacted>",
          username: summary.bot.username ? "<redacted>" : undefined,
        }
      : undefined,
    channel: summary.channel
      ? {
          id: "<redacted>",
          name: summary.channel.name ? "<redacted>" : undefined,
          type: summary.channel.type,
        }
      : undefined,
    guild: summary.guild
      ? {
          id: "<redacted>",
          name: summary.guild.name ? "<redacted>" : undefined,
        }
      : undefined,
    message: summary.message
      ? {
          ...summary.message,
          id: summary.message.id ? "<redacted>" : "",
        }
      : undefined,
  };
}

async function writeMantisDiscordSmokeArtifacts(
  summary: MantisDiscordSmokeSummary,
  sensitiveValues: ReadonlySet<string>,
) {
  await fs.mkdir(summary.outputDir, { recursive: true });
  const publishedSummary = buildPublishedMantisDiscordSmokeSummary(summary, sensitiveValues);
  const report = renderMantisDiscordSmokeReport(publishedSummary);
  const summaryJson = `${JSON.stringify(publishedSummary, null, 2)}\n`;
  await fs.writeFile(summary.reportPath, report, "utf8");
  await fs.writeFile(summary.summaryPath, summaryJson, "utf8");
}

export async function runMantisDiscordSmoke(
  opts: MantisDiscordSmokeOptions = {},
): Promise<MantisDiscordSmokeResult> {
  const env = opts.env ?? process.env;
  const startedAt = (opts.now ?? (() => new Date()))();
  const redactPublicMetadata =
    opts.redactPublicMetadata ?? isTruthyOptIn(env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
      defaultMantisDiscordSmokeOutputDir(repoRoot, startedAt),
    "Mantis Discord smoke output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-discord-smoke-summary.json");
  const reportPath = path.join(outputDir, "mantis-discord-smoke-report.md");
  const apiCalls: DiscordApiCall[] = [];
  const sensitiveValues = new Set<string>();
  const summary: MantisDiscordSmokeSummary = {
    apiCalls,
    artifacts: {
      reportPath,
      summaryPath,
    },
    finishedAt: startedAt.toISOString(),
    metadataRedaction: redactPublicMetadata,
    outputDir,
    reportPath,
    startedAt: startedAt.toISOString(),
    status: "fail",
    summaryPath,
    tokenSource: "env",
  };

  try {
    const { source, token } = await resolveMantisDiscordToken(opts);
    summary.tokenSource = source;
    const guildId = resolveRequiredSnowflake({
      env,
      envKey: DEFAULT_GUILD_ID_ENV,
      label: DEFAULT_GUILD_ID_ENV,
      value: opts.guildId,
    });
    const channelId = resolveRequiredSnowflake({
      env,
      envKey: DEFAULT_CHANNEL_ID_ENV,
      label: DEFAULT_CHANNEL_ID_ENV,
      value: opts.channelId,
    });
    addSensitiveValue(sensitiveValues, guildId);
    addSensitiveValue(sensitiveValues, channelId);
    const bot = await callDiscordApi<DiscordUser>({
      apiCalls,
      label: "current-user",
      path: "/users/@me",
      token,
    });
    addSensitiveValue(sensitiveValues, bot.id);
    addSensitiveValue(sensitiveValues, bot.username);
    const guild = await callDiscordApi<DiscordGuild>({
      apiCalls,
      label: "guild",
      path: `/guilds/${guildId}`,
      token,
    });
    addSensitiveValue(sensitiveValues, guild.id);
    addSensitiveValue(sensitiveValues, guild.name);
    const guildChannels = await callDiscordApi<DiscordChannel[]>({
      apiCalls,
      label: "guild-channels",
      path: `/guilds/${guildId}/channels`,
      token,
    });
    for (const guildChannel of guildChannels) {
      addSensitiveValue(sensitiveValues, guildChannel.id);
      addSensitiveValue(sensitiveValues, guildChannel.guild_id);
      addSensitiveValue(sensitiveValues, guildChannel.name);
    }
    const channel = await callDiscordApi<DiscordChannel>({
      apiCalls,
      label: "channel",
      path: `/channels/${channelId}`,
      token,
    });
    addSensitiveValue(sensitiveValues, channel.id);
    addSensitiveValue(sensitiveValues, channel.guild_id);
    addSensitiveValue(sensitiveValues, channel.name);
    assertMantisDiscordChannelInGuild({
      channel,
      guildChannels,
      guildId,
      channelId,
    });
    summary.bot = { id: bot.id, username: bot.username };
    summary.guild = { id: guild.id, name: guild.name };
    summary.channel = { id: channel.id, name: channel.name, type: channel.type };

    if (opts.skipPost) {
      summary.message = { id: "", posted: false, reactionAdded: false };
    } else {
      const message = await callDiscordApi<DiscordMessage>({
        apiCalls,
        body: {
          content:
            trimToValue(opts.message) ?? `Mantis Discord smoke: OK (${startedAt.toISOString()})`,
        },
        label: "post-message",
        method: "POST",
        path: `/channels/${channelId}/messages`,
        token,
      });
      addSensitiveValue(sensitiveValues, message.id);
      await callDiscordApi<void>({
        apiCalls,
        label: "add-reaction",
        method: "PUT",
        path: `/channels/${channelId}/messages/${message.id}/reactions/%F0%9F%91%80/@me`,
        token,
      });
      summary.message = { id: message.id, posted: true, reactionAdded: true };
    }

    summary.status = "pass";
  } catch (error) {
    summary.status = "fail";
    summary.message = summary.message ?? {
      id: "",
      posted: false,
      reactionAdded: false,
    };
    await fs.writeFile(
      path.join(outputDir, "error.txt"),
      `${
        redactPublicMetadata
          ? redactMantisDiscordMetadata(formatErrorMessage(error), sensitiveValues)
          : formatErrorMessage(error)
      }${os.EOL}`,
      "utf8",
    );
  } finally {
    summary.finishedAt = new Date().toISOString();
    await writeMantisDiscordSmokeArtifacts(summary, sensitiveValues);
  }

  return {
    outputDir,
    reportPath,
    summaryPath,
    status: summary.status,
  };
}
