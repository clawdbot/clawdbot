#!/usr/bin/env bun
import { execFile } from "node:child_process";
// Manual ACP thread smoke for plain-language routing.
// Keep this script available for regression/debug validation. Do not delete.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { formatErrorMessage } from "../../src/infra/errors.ts";

function writeStdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

type ThreadBindingRecord = {
  accountId?: string;
  channelId?: string;
  threadId?: string;
  targetKind?: string;
  targetSessionKey?: string;
  agentId?: string;
  boundBy?: string;
  boundAt?: number;
};

type ThreadBindingsPayload = {
  version?: number;
  bindings?: Record<string, ThreadBindingRecord>;
};

type DiscordMessage = {
  id: string;
  content?: string;
  timestamp?: string;
  author?: {
    id?: string;
    username?: string;
    bot?: boolean;
  };
};

type DiscordUser = {
  id: string;
  username: string;
  bot?: boolean;
};

const execFileAsync = promisify(execFile);

type DriverMode = "token" | "webhook" | "openclaw";

type Args = {
  channelId: string;
  driverMode: DriverMode;
  driverToken: string;
  driverTokenPrefix: string;
  botToken: string;
  botTokenPrefix: string;
  targetAgent: string;
  timeoutMs: number;
  pollMs: number;
  mentionUserId?: string;
  instruction?: string;
  threadBindingsPath: string;
  openclawBin: string;
  json: boolean;
};

type SuccessResult = {
  ok: true;
  smokeId: string;
  ackToken: string;
  sentMessageId: string;
  binding: {
    threadId: string;
    targetSessionKey: string;
    targetKind: string;
    agentId: string;
    boundAt: number;
    accountId?: string;
    channelId?: string;
  };
  ackMessage: {
    id: string;
    authorId?: string;
    authorUsername?: string;
    timestamp?: string;
    content?: string;
  };
};

type FailureResult = {
  ok: false;
  smokeId: string;
  stage: "validation" | "send-message" | "wait-binding" | "wait-ack" | "discord-api" | "unexpected";
  error: string;
  diagnostics?: {
    parentChannelRecent?: Array<{
      id: string;
      author?: string;
      bot?: boolean;
      content?: string;
    }>;
    bindingCandidates?: Array<{
      threadId: string;
      targetSessionKey: string;
      targetKind?: string;
      agentId?: string;
      boundAt?: number;
    }>;
  };
};

const DISCORD_API_BASE = "https://discord.com/api/v10";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return override.startsWith("~")
      ? path.resolve(process.env.HOME || "", override.slice(1))
      : path.resolve(override);
  }
  const home = process.env.OPENCLAW_HOME?.trim() || process.env.HOME || "";
  return path.join(home, ".openclaw");
}

function resolveArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((entry) => entry.startsWith(`${flag}=`));
  if (eq) {
    return eq.slice(flag.length + 1);
  }
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function usage(): string {
  return (
    "Usage: bun scripts/dev/discord-acp-plain-language-smoke.ts " +
    "--channel <discord-channel-id> [--token <driver-token> | --driver webhook --bot-token <bot-token> | --driver openclaw] [options]\n\n" +
    "Manual live smoke only (not CI). Sends a plain-language instruction in Discord and verifies:\n" +
    "1) OpenClaw spawned an ACP thread binding\n" +
    "2) agent replied in that bound thread with the expected ACK token\n\n" +
    "Options:\n" +
    "  --channel <id>               Parent Discord channel id (required)\n" +
    "  --driver <token|webhook|openclaw> Driver transport mode (default: token)\n" +
    "  --token <token>              Driver Discord token (required for driver=token)\n" +
    "  --token-prefix <prefix>      Auth prefix for --token (default: Bot)\n" +
    "  --bot-token <token>          Bot token for webhook driver mode\n" +
    "  --bot-token-prefix <prefix>  Auth prefix for --bot-token (default: Bot)\n" +
    "  --agent <id>                 Expected ACP agent id (default: codex)\n" +
    "  --mention <user-id>          Mention this user in the instruction (optional)\n" +
    "  --instruction <text>         Custom instruction template (optional)\n" +
    "  --timeout-ms <n>             Total timeout in ms (default: 240000)\n" +
    "  --poll-ms <n>                Poll interval in ms (default: 1500)\n" +
    "  --thread-bindings-path <p>   Override thread-bindings json path\n" +
    "  --openclaw-bin <path>        OpenClaw CLI binary for driver=openclaw (default: openclaw)\n" +
    "  --json                       Emit JSON output\n" +
    "\n" +
    "Environment fallbacks:\n" +
    "  OPENCLAW_DISCORD_SMOKE_CHANNEL_ID\n" +
    "  OPENCLAW_DISCORD_SMOKE_DRIVER\n" +
    "  OPENCLAW_DISCORD_SMOKE_DRIVER_TOKEN\n" +
    "  OPENCLAW_DISCORD_SMOKE_DRIVER_TOKEN_PREFIX\n" +
    "  OPENCLAW_DISCORD_SMOKE_BOT_TOKEN\n" +
    "  OPENCLAW_DISCORD_SMOKE_BOT_TOKEN_PREFIX\n" +
    "  OPENCLAW_DISCORD_SMOKE_AGENT\n" +
    "  OPENCLAW_DISCORD_SMOKE_MENTION_USER_ID\n" +
    "  OPENCLAW_DISCORD_SMOKE_TIMEOUT_MS\n" +
    "  OPENCLAW_DISCORD_SMOKE_POLL_MS\n" +
    "  OPENCLAW_DISCORD_SMOKE_THREAD_BINDINGS_PATH\n" +
    "  OPENCLAW_DISCORD_SMOKE_OPENCLAW_BIN"
  );
}

function parseArgs(): Args {
  const channelId = resolveArg("--channel") || process.env.OPENCLAW_DISCORD_SMOKE_CHANNEL_ID || "";
  const driverModeRaw =
    resolveArg("--driver") || process.env.OPENCLAW_DISCORD_SMOKE_DRIVER || "token";
  const normalizedDriverMode = driverModeRaw.trim().toLowerCase();
  const driverMode: DriverMode =
    normalizedDriverMode === "webhook"
      ? "webhook"
      : normalizedDriverMode === "openclaw"
        ? "openclaw"
        : normalizedDriverMode === "token"
          ? "token"
          : "token";
  const driverToken =
    resolveArg("--token") || process.env.OPENCLAW_DISCORD_SMOKE_DRIVER_TOKEN || "";
  const driverTokenPrefix =
    resolveArg("--token-prefix") || process.env.OPENCLAW_DISCORD_SMOKE_DRIVER_TOKEN_PREFIX || "Bot";
  const botToken =
    resolveArg("--bot-token") ||
    process.env.OPENCLAW_DISCORD_SMOKE_BOT_TOKEN ||
    process.env.DISCORD_BOT_TOKEN ||
    "";
  const botTokenPrefix =
    resolveArg("--bot-token-prefix") ||
    process.env.OPENCLAW_DISCORD_SMOKE_BOT_TOKEN_PREFIX ||
    "Bot";
  const targetAgent = resolveArg("--agent") || process.env.OPENCLAW_DISCORD_SMOKE_AGENT || "codex";
  const mentionUserId =
    resolveArg("--mention") || process.env.OPENCLAW_DISCORD_SMOKE_MENTION_USER_ID || undefined;
  const instruction =
    resolveArg("--instruction") || process.env.OPENCLAW_DISCORD_SMOKE_INSTRUCTION || undefined;
  const timeoutMs = parseNumber(
    resolveArg("--timeout-ms") || process.env.OPENCLAW_DISCORD_SMOKE_TIMEOUT_MS,
    240_000,
  );
  const pollMs = parseNumber(
    resolveArg("--poll-ms") || process.env.OPENCLAW_DISCORD_SMOKE_POLL_MS,
    1_500,
  );
  const defaultBindingsPath = path.join(resolveStateDir(), "discord", "thread-bindings.json");
  const threadBindingsPath =
    resolveArg("--thread-bindings-path") ||
    process.env.OPENCLAW_DISCORD_SMOKE_THREAD_BINDINGS_PATH ||
    defaultBindingsPath;
  const openclawBin =
    resolveArg("--openclaw-bin") || process.env.OPENCLAW_DISCORD_SMOKE_OPENCLAW_BIN || "openclaw";
  const json = hasFlag("--json");

  if (!channelId) {
    throw new Error(usage());
  }
  if (driverMode === "token" && !driverToken) {
    throw new Error(usage());
  }
  if (driverMode === "webhook" && !botToken) {
    throw new Error(usage());
  }

  return {
    channelId,
    driverMode,
    driverToken,
    driverTokenPrefix,
    botToken,
    botTokenPrefix,
    targetAgent,
    timeoutMs,
    pollMs,
    mentionUserId,
    instruction,
    threadBindingsPath,
    openclawBin,
    json,
  };
}

async function openclawCliJson<T>(params: { openclawBin: string; args: string[] }): Promise<T> {
  const result = await execFileAsync(params.openclawBin, params.args, {
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    throw new Error(`openclaw ${params.args.join(" ")} returned empty stdout`);
  }
  return JSON.parse(stdout) as T;
}

async function readMessagesWithOpenclaw(params: {
  openclawBin: string;
  target: string;
  limit: number;
}): Promise<DiscordMessage[]> {
  const response = await openclawCliJson<{
    payload?: {
      messages?: DiscordMessage[];
    };
  }>({
    openclawBin: params.openclawBin,
    args: [
      "message",
      "read",
      "--channel",
      "discord",
      "--target",
      params.target,
      "--limit",
      String(params.limit),
      "--json",
    ],
  });
  return Array.isArray(response.payload?.messages) ? response.payload.messages : [];
}

function resolveAuthorizationHeader(params: { token: string; tokenPrefix: string }): string {
  const token = params.token.trim();
  if (!token) {
    throw new Error("Missing Discord driver token.");
  }
  if (token.includes(" ")) {
    return token;
  }
  return `${params.tokenPrefix.trim() || "Bot"} ${token}`;
}

async function discordApi<T>(params: {
  method: "GET" | "POST";
  path: string;
  authHeader: string;
  body?: unknown;
  retries?: number;
}): Promise<T> {
  return requestDiscordJson<T>({
    method: params.method,
    path: params.path,
    headers: {
      Authorization: params.authHeader,
      "Content-Type": "application/json",
    },
    body: params.body,
    retries: params.retries,
    errorPrefix: "Discord API",
  });
}

async function discordWebhookApi<T>(params: {
  method: "POST" | "DELETE";
  webhookId: string;
  webhookToken: string;
  body?: unknown;
  query?: string;
  retries?: number;
}): Promise<T> {
  const suffix = params.query ? `?${params.query}` : "";
  const path = `/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}${suffix}`;
  return requestDiscordJson<T>({
    method: params.method,
    path,
    headers: {
      "Content-Type": "application/json",
    },
    body: params.body,
    retries: params.retries,
    errorPrefix: "Discord webhook API",
  });
}

async function requestDiscordJson<T>(params: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  retries?: number;
  errorPrefix: string;
}): Promise<T> {
  const retries = params.retries ?? 6;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(`${DISCORD_API_BASE}${params.path}`, {
      method: params.method,
      headers: params.headers,
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
    });

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const waitSeconds = typeof body.retry_after === "number" ? body.retry_after : 1;
      await sleep(Math.ceil(waitSeconds * 1000));
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${params.errorPrefix} ${params.method} ${params.path} failed: ${response.status} ${response.statusText}${text ? ` :: ${text}` : ""}`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  throw new Error(`${params.errorPrefix} ${params.method} ${params.path} exceeded retry budget.`);
}

async function readThreadBindings(filePath: string): Promise<ThreadBindingRecord[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const payload = JSON.parse(raw) as ThreadBindingsPayload;
  const entries = Object.values(payload.bindings ?? {});
  return entries.filter((entry) => Boolean(entry?.threadId && entry?.targetSessionKey));
}

function normalizeBoundAt(record: ThreadBindingRecord): number {
  if (typeof record.boundAt === "number" && Number.isFinite(record.boundAt)) {
    return record.boundAt;
  }
  return 0;
}

function resolveCandidateBindings(params: {
  entries: ThreadBindingRecord[];
  minBoundAt: number;
  targetAgent: string;
}): ThreadBindingRecord[] {
  const normalizedTargetAgent = params.targetAgent.trim().toLowerCase();
  return params.entries
    .filter((entry) => {
      const targetKind = (entry.targetKind || "").trim().toLowerCase();
      if (targetKind !== "acp") {
        return false;
      }
      if (normalizeBoundAt(entry) < params.minBoundAt) {
        return false;
      }
      const agentId = (entry.agentId || "").trim().toLowerCase();
      if (normalizedTargetAgent && agentId && agentId !== normalizedTargetAgent) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => normalizeBoundAt(b) - normalizeBoundAt(a));
}

function buildInstruction(params: {
  smokeId: string;
  ackToken: string;
  targetAgent: string;
  mentionUserId?: string;
  template?: string;
}): string {
  const mentionPrefix = params.mentionUserId?.trim() ? `<@${params.mentionUserId.trim()}> ` : "";
  if (params.template?.trim()) {
    return mentionPrefix + params.template.trim();
  }
  return (
    mentionPrefix +
    `Manual smoke ${params.smokeId}: Please spawn a ${params.targetAgent} ACP coding agent in a thread for this request, keep it persistent, and in that thread reply with exactly "${params.ackToken}" and nothing else.`
  );
}

function toRecentMessageRow(message: DiscordMessage) {
  return {
    id: message.id,
    author: message.author?.username || message.author?.id || "unknown",
    bot: Boolean(message.author?.bot),
    content: (message.content || "").slice(0, 500),
  };
}

async function loadParentRecentMessages(params: {
  args: Args;
  readAuthHeader: string;
}): Promise<DiscordMessage[]> {
  if (params.args.driverMode === "openclaw") {
    return await readMessagesWithOpenclaw({
      openclawBin: params.args.openclawBin,
      target: params.args.channelId,
      limit: 20,
    });
  }
  return await discordApi<DiscordMessage[]>({
    method: "GET",
    path: `/channels/${encodeURIComponent(params.args.channelId)}/messages?limit=20`,
    authHeader: params.readAuthHeader,
  });
}

function printOutput(params: { json: boolean; payload: SuccessResult | FailureResult }) {
  if (params.json) {
    writeStdoutJson(params.payload);
    return;
  }
  if (params.payload.ok) {
    const success = params.payload;
    writeStdoutLine("PASS");
    writeStdoutLine(`smokeId: ${success.smokeId}`);
    writeStdoutLine(`sentMessageId: ${success.sentMessageId}`);
    writeStdoutLine(`threadId: ${success.binding.threadId}`);
    writeStdoutLine(`sessionKey: ${success.binding.targetSessionKey}`);
    writeStdoutLine(`ackMessageId: ${success.ackMessage.id}`);
    writeStdoutLine(
      `ackAuthor: ${success.ackMessage.authorUsername || success.ackMessage.authorId || "unknown"}`,
    );
    return;
  }
  const failure = params.payload;
  writeStderrLine("FAIL");
  writeStderrLine(`stage: ${failure.stage}`);
  writeStderrLine(`smokeId: ${failure.smokeId}`);
  writeStderrLine(`error: ${failure.error}`);
  if (failure.diagnostics?.bindingCandidates?.length) {
    writeStderrLine("binding candidates:");
    for (const candidate of failure.diagnostics.bindingCandidates) {
      writeStderrLine(
        `  thread=${candidate.threadId} kind=${candidate.targetKind || "?"} agent=${candidate.agentId || "?"} boundAt=${candidate.boundAt || 0} session=${candidate.targetSessionKey}`,
      );
    }
  }
  if (failure.diagnostics?.parentChannelRecent?.length) {
    writeStderrLine("recent parent channel messages:");
    for (const row of failure.diagnostics.parentChannelRecent) {
      writeStderrLine(`  ${row.id} ${row.author}${row.bot ? " [bot]" : ""}: ${row.content || ""}`);
    }
  }
}

async function run(): Promise<SuccessResult | FailureResult> {
  let args: Args;
  try {
    args = parseArgs();
  } catch (err) {
    return {
      ok: false,
      stage: "validation",
      smokeId: "n/a",
      error: formatErrorMessage(err),
    };
  }

  const smokeId = `acp-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ackToken = `ACP_SMOKE_ACK_${smokeId}`;
  const instruction = buildInstruction({
    smokeId,
    ackToken,
    targetAgent: args.targetAgent,
    mentionUserId: args.mentionUserId,
    template: args.instruction,
  });

  let readAuthHeader = "";
  let sentMessageId = "";
  let setupStage: "discord-api" | "send-message" = "discord-api";
  let senderAuthorId: string | undefined;
  let webhookForCleanup:
    | {
        id: string;
        token: string;
      }
    | undefined;

  try {
    if (args.driverMode === "token") {
      const authHeader = resolveAuthorizationHeader({
        token: args.driverToken,
        tokenPrefix: args.driverTokenPrefix,
      });
      readAuthHeader = authHeader;

      const driverUser = await discordApi<DiscordUser>({
        method: "GET",
        path: "/users/@me",
        authHeader,
      });
      senderAuthorId = driverUser.id;

      setupStage = "send-message";
      const sent = await discordApi<DiscordMessage>({
        method: "POST",
        path: `/channels/${encodeURIComponent(args.channelId)}/messages`,
        authHeader,
        body: {
          content: instruction,
          allowed_mentions: args.mentionUserId
            ? { parse: [], users: [args.mentionUserId] }
            : { parse: [] },
        },
      });
      sentMessageId = sent.id;
    } else if (args.driverMode === "webhook") {
      const botAuthHeader = resolveAuthorizationHeader({
        token: args.botToken,
        tokenPrefix: args.botTokenPrefix,
      });
      readAuthHeader = botAuthHeader;

      await discordApi<DiscordUser>({
        method: "GET",
        path: "/users/@me",
        authHeader: botAuthHeader,
      });

      setupStage = "send-message";
      const webhook = await discordApi<{ id: string; token?: string | null }>({
        method: "POST",
        path: `/channels/${encodeURIComponent(args.channelId)}/webhooks`,
        authHeader: botAuthHeader,
        body: {
          name: `openclaw-acp-smoke-${smokeId.slice(-8)}`,
        },
      });
      if (!webhook.id || !webhook.token) {
        return {
          ok: false,
          stage: "send-message",
          smokeId,
          error:
            "Discord webhook creation succeeded but no webhook token was returned; cannot post smoke message.",
        };
      }
      webhookForCleanup = { id: webhook.id, token: webhook.token };

      const sent = await discordWebhookApi<DiscordMessage>({
        method: "POST",
        webhookId: webhook.id,
        webhookToken: webhook.token,
        query: "wait=true",
        body: {
          content: instruction,
          allowed_mentions: args.mentionUserId
            ? { parse: [], users: [args.mentionUserId] }
            : { parse: [] },
        },
      });
      sentMessageId = sent.id;
      senderAuthorId = sent.author?.id;
    } else {
      setupStage = "send-message";
      const sent = await openclawCliJson<{
        payload?: {
          result?: {
            messageId?: string;
          };
        };
      }>({
        openclawBin: args.openclawBin,
        args: [
          "message",
          "send",
          "--channel",
          "discord",
          "--target",
          args.channelId,
          "--message",
          instruction,
          "--json",
        ],
      });
      sentMessageId = sent.payload?.result?.messageId || "";
      if (!sentMessageId) {
        throw new Error("openclaw message send did not return payload.result.messageId");
      }
    }
  } catch (err) {
    return {
      ok: false,
      stage: setupStage,
      smokeId,
      error: formatErrorMessage(err),
    };
  }

  const startedAt = Date.now();

  const deadline = startedAt + args.timeoutMs;
  let winningBinding: ThreadBindingRecord | undefined;
  let latestCandidates: ThreadBindingRecord[] = [];

  try {
    while (Date.now() < deadline && !winningBinding) {
      try {
        const entries = await readThreadBindings(args.threadBindingsPath);
        latestCandidates = resolveCandidateBindings({
          entries,
          minBoundAt: startedAt - 3_000,
          targetAgent: args.targetAgent,
        });
        winningBinding = latestCandidates[0];
      } catch {
        // Keep polling; file may not exist yet or may be mid-write.
      }
      if (!winningBinding) {
        await sleep(args.pollMs);
      }
    }

    if (!winningBinding?.threadId || !winningBinding?.targetSessionKey) {
      let parentRecent: DiscordMessage[] = [];
      try {
        parentRecent = await loadParentRecentMessages({ args, readAuthHeader });
      } catch {
        // Best effort diagnostics only.
      }
      return {
        ok: false,
        stage: "wait-binding",
        smokeId,
        error: `Timed out waiting for new ACP thread binding (path: ${args.threadBindingsPath}).`,
        diagnostics: {
          bindingCandidates: latestCandidates.slice(0, 6).map((entry) => ({
            threadId: entry.threadId || "",
            targetSessionKey: entry.targetSessionKey || "",
            targetKind: entry.targetKind,
            agentId: entry.agentId,
            boundAt: entry.boundAt,
          })),
          parentChannelRecent: parentRecent.map(toRecentMessageRow),
        },
      };
    }

    const threadId = winningBinding.threadId;
    let ackMessage: DiscordMessage | undefined;
    while (Date.now() < deadline && !ackMessage) {
      try {
        const threadMessages =
          args.driverMode === "openclaw"
            ? await readMessagesWithOpenclaw({
                openclawBin: args.openclawBin,
                target: threadId,
                limit: 50,
              })
            : await discordApi<DiscordMessage[]>({
                method: "GET",
                path: `/channels/${encodeURIComponent(threadId)}/messages?limit=50`,
                authHeader: readAuthHeader,
              });
        ackMessage = threadMessages.find((message) => {
          const content = message.content || "";
          if (!content.includes(ackToken)) {
            return false;
          }
          const authorId = message.author?.id || "";
          return !senderAuthorId || authorId !== senderAuthorId;
        });
      } catch {
        // Keep polling; thread can appear before read permissions settle.
      }
      if (!ackMessage) {
        await sleep(args.pollMs);
      }
    }

    if (!ackMessage) {
      let parentRecent: DiscordMessage[] = [];
      try {
        parentRecent = await loadParentRecentMessages({ args, readAuthHeader });
      } catch {
        // Best effort diagnostics only.
      }

      return {
        ok: false,
        stage: "wait-ack",
        smokeId,
        error: `Thread bound (${threadId}) but timed out waiting for ACK token "${ackToken}" from OpenClaw.`,
        diagnostics: {
          bindingCandidates: [
            {
              threadId: winningBinding.threadId || "",
              targetSessionKey: winningBinding.targetSessionKey || "",
              targetKind: winningBinding.targetKind,
              agentId: winningBinding.agentId,
              boundAt: winningBinding.boundAt,
            },
          ],
          parentChannelRecent: parentRecent.map(toRecentMessageRow),
        },
      };
    }

    return {
      ok: true,
      smokeId,
      ackToken,
      sentMessageId,
      binding: {
        threadId,
        targetSessionKey: winningBinding.targetSessionKey,
        targetKind: winningBinding.targetKind || "acp",
        agentId: winningBinding.agentId || args.targetAgent,
        boundAt: normalizeBoundAt(winningBinding),
        accountId: winningBinding.accountId,
        channelId: winningBinding.channelId,
      },
      ackMessage: {
        id: ackMessage.id,
        authorId: ackMessage.author?.id,
        authorUsername: ackMessage.author?.username,
        timestamp: ackMessage.timestamp,
        content: ackMessage.content,
      },
    };
  } finally {
    if (webhookForCleanup) {
      await discordWebhookApi<void>({
        method: "DELETE",
        webhookId: webhookForCleanup.id,
        webhookToken: webhookForCleanup.token,
      }).catch(() => {
        // Best-effort cleanup only.
      });
    }
  }
}

if (hasFlag("--help") || hasFlag("-h")) {
  writeStdoutLine(usage());
  process.exit(0);
}

const result = await run().catch(
  (err): FailureResult => ({
    ok: false,
    stage: "unexpected",
    smokeId: "n/a",
    error: formatErrorMessage(err),
  }),
);

printOutput({
  json: hasFlag("--json"),
  payload: result,
});

process.exit(result.ok ? 0 : 1);
