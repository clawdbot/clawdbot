#!/usr/bin/env bun
import { execFile } from "node:child_process";
// Manual ACP thread smoke for plain-language routing.
// Keep this script available for regression/debug validation. Do not delete.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { formatErrorMessage } from "../../src/infra/errors.ts";
import { createPluginStateKeyedStore } from "../../src/plugin-state/plugin-state-store.ts";
import { readBoundedResponseText } from "../lib/bounded-response.ts";
import {
  maskIdentifier,
  parseStrictIntegerOption,
  previewForDevToolLog,
  redactForDevToolLog,
  redactHomePath,
} from "../lib/dev-tooling-safety.ts";

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

type WebhookForCleanup = {
  id: string;
  token: string;
};

const execFileAsync = promisify(execFile);
const THREAD_BINDINGS_NAMESPACE = "thread-bindings";
const THREAD_BINDINGS_MAX_ENTRIES = 10_000;

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
  stateDir: string;
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
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OPENCLAW_CLI_TIMEOUT_MS = 60_000;
const DISCORD_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;
const WEBHOOK_CLEANUP_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function remainingTimeoutMs(deadlineMs: number, nowMs = Date.now()): number {
  const remaining = Math.floor(deadlineMs - nowMs);
  if (!Number.isFinite(deadlineMs) || remaining <= 0) {
    throw new Error("Discord ACP smoke exceeded total timeout.");
  }
  return Math.max(1, remaining);
}

async function sleepUntilDeadline(params: { pollMs: number; deadlineMs: number }): Promise<void> {
  const remaining = params.deadlineMs - Date.now();
  if (remaining <= 0) {
    return;
  }
  await sleep(Math.min(params.pollMs, Math.max(1, remaining)));
}

async function withTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  timeoutError: () => Error;
  onTimeout?: () => void;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      params.operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          params.onTimeout?.();
          reject(params.timeoutError());
        }, params.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseNumber(value: string | undefined, fallback: number, label: string): number {
  return parseStrictIntegerOption({ fallback, label, min: 1, raw: value });
}

function createDiscordResponseTooLargeError(message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = "ETOOBIG";
  return error;
}

function isTooLargeError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETOOBIG";
}

async function readDiscordResponseText(params: {
  response: Response;
  label: string;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<string> {
  return await readBoundedResponseText(params.response, params.label, params.maxBytes, {
    createTooLargeError: createDiscordResponseTooLargeError,
    signal: params.signal,
  });
}

async function readDiscordResponseJson(params: {
  response: Response;
  label: string;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<unknown> {
  const text = await readDiscordResponseText(params);
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    if (override === "~") {
      return path.resolve(process.env.HOME || "");
    }
    if (override.startsWith("~/")) {
      return path.resolve(process.env.HOME || "", override.slice(2));
    }
    return path.resolve(override);
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

function parseDriverMode(raw: string): DriverMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "token" || normalized === "webhook" || normalized === "openclaw") {
    return normalized;
  }
  throw new Error(
    `Invalid --driver value ${JSON.stringify(raw)}; expected token, webhook, or openclaw.`,
  );
}

function redactDiscordApiPath(apiPath: string): string {
  return apiPath.replace(
    /(\/webhooks\/[^/?#]+\/)([^/?#]+)/gu,
    (_match, prefix: string, token: string) => `${prefix}${maskIdentifier(token)}`,
  );
}

function safeErrorMessage(error: unknown): string {
  return redactForDevToolLog(formatErrorMessage(error));
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
    "  --state-dir <p>              Override OpenClaw state dir for plugin-state polling\n" +
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
    "  OPENCLAW_STATE_DIR\n" +
    "  OPENCLAW_DISCORD_SMOKE_OPENCLAW_BIN"
  );
}

function parseArgs(): Args {
  const channelId = resolveArg("--channel") || process.env.OPENCLAW_DISCORD_SMOKE_CHANNEL_ID || "";
  const driverModeRaw =
    resolveArg("--driver") || process.env.OPENCLAW_DISCORD_SMOKE_DRIVER || "token";
  const driverMode = parseDriverMode(driverModeRaw);
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
    "--timeout-ms",
  );
  const pollMs = parseNumber(
    resolveArg("--poll-ms") || process.env.OPENCLAW_DISCORD_SMOKE_POLL_MS,
    1_500,
    "--poll-ms",
  );
  const stateDir = path.resolve(resolveArg("--state-dir") || resolveStateDir());
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
    stateDir,
    openclawBin,
    json,
  };
}

async function openclawCliJson<T>(params: {
  openclawBin: string;
  args: string[];
  timeoutMs?: number;
}): Promise<T> {
  const result = await execFileAsync(params.openclawBin, params.args, {
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
    timeout: params.timeoutMs ?? DEFAULT_OPENCLAW_CLI_TIMEOUT_MS,
    killSignal: "SIGKILL",
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
  timeoutMs?: number;
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
    timeoutMs: params.timeoutMs,
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
  timeoutMs?: number;
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
    timeoutMs: params.timeoutMs,
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
  timeoutMs?: number;
}): Promise<T> {
  const suffix = params.query ? `?${params.query}` : "";
  const pathLocal = `/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}${suffix}`;
  return requestDiscordJson<T>({
    method: params.method,
    path: pathLocal,
    headers: {
      "Content-Type": "application/json",
    },
    body: params.body,
    retries: params.retries,
    timeoutMs: params.timeoutMs,
    errorPrefix: "Discord webhook API",
  });
}

async function requestDiscordJson<T>(params: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  retries?: number;
  timeoutMs?: number;
  errorPrefix: string;
  responseBodyMaxBytes?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<T> {
  const retries = params.retries ?? 6;
  const fetchImpl = params.fetchImpl ?? fetch;
  const sleepImpl = params.sleepImpl ?? sleep;
  const responseBodyMaxBytes = params.responseBodyMaxBytes ?? DISCORD_RESPONSE_BODY_MAX_BYTES;
  const deadlineMs = Date.now() + (params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const timeoutError = () =>
    new Error(
      `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)} exceeded timeout.`,
    );

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const fetchTimeoutMs = remainingTimeoutMs(deadlineMs);
    const response = await withTimeout({
      operation: fetchImpl(`${DISCORD_API_BASE}${params.path}`, {
        method: params.method,
        headers: params.headers,
        body: params.body === undefined ? undefined : JSON.stringify(params.body),
        signal: controller.signal,
      }),
      timeoutMs: fetchTimeoutMs,
      timeoutError,
      onTimeout: () => controller.abort(),
    });

    if (response.status === 429) {
      const bodyTimeoutMs = remainingTimeoutMs(deadlineMs);
      const body = (await withTimeout({
        operation: readDiscordResponseJson({
          response,
          label: `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)}`,
          signal: controller.signal,
          maxBytes: responseBodyMaxBytes,
        }).catch((error: unknown) => {
          if (isTooLargeError(error)) {
            throw error;
          }
          return {};
        }),
        timeoutMs: bodyTimeoutMs,
        timeoutError,
        onTimeout: () => controller.abort(),
      })) as { retry_after?: number };
      const waitSeconds = typeof body.retry_after === "number" ? body.retry_after : 1;
      const waitMs = Math.ceil(waitSeconds * 1000);
      const remainingMs = remainingTimeoutMs(deadlineMs);
      if (waitMs >= remainingMs) {
        throw new Error(
          `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)} exceeded total timeout before retry.`,
        );
      }
      await sleepImpl(waitMs);
      continue;
    }

    if (!response.ok) {
      const bodyTimeoutMs = remainingTimeoutMs(deadlineMs);
      const text = await withTimeout({
        operation: readDiscordResponseText({
          response,
          label: `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)}`,
          signal: controller.signal,
          maxBytes: responseBodyMaxBytes,
        }),
        timeoutMs: bodyTimeoutMs,
        timeoutError,
        onTimeout: () => controller.abort(),
      });
      throw new Error(
        redactForDevToolLog(
          `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)} failed: ${response.status} ${response.statusText}${text ? ` :: ${text}` : ""}`,
        ),
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const bodyTimeoutMs = remainingTimeoutMs(deadlineMs);
    return (await withTimeout({
      operation: readDiscordResponseJson({
        response,
        label: `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)}`,
        signal: controller.signal,
        maxBytes: responseBodyMaxBytes,
      }),
      timeoutMs: bodyTimeoutMs,
      timeoutError,
      onTimeout: () => controller.abort(),
    })) as T;
  }

  throw new Error(
    `${params.errorPrefix} ${params.method} ${redactDiscordApiPath(params.path)} exceeded retry budget.`,
  );
}

async function readThreadBindings(stateDir: string): Promise<ThreadBindingRecord[]> {
  const store = createPluginStateKeyedStore<ThreadBindingRecord>("discord", {
    namespace: THREAD_BINDINGS_NAMESPACE,
    maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const entries = await store.entries();
  return entries
    .map((entry) => entry.value)
    .filter((entry) => Boolean(entry?.threadId && entry?.targetSessionKey));
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
    content: previewForDevToolLog(message.content || "", 500),
  };
}

async function loadParentRecentMessages(params: {
  args: Args;
  readAuthHeader: string;
  timeoutMs?: number;
}): Promise<DiscordMessage[]> {
  if (params.args.driverMode === "openclaw") {
    return await readMessagesWithOpenclaw({
      openclawBin: params.args.openclawBin,
      target: params.args.channelId,
      limit: 20,
      timeoutMs: params.timeoutMs,
    });
  }
  return await discordApi<DiscordMessage[]>({
    method: "GET",
    path: `/channels/${encodeURIComponent(params.args.channelId)}/messages?limit=20`,
    authHeader: params.readAuthHeader,
    timeoutMs: params.timeoutMs,
  });
}

async function cleanupWebhook(webhookForCleanup: WebhookForCleanup | undefined): Promise<void> {
  if (!webhookForCleanup) {
    return;
  }
  await discordWebhookApi<void>({
    method: "DELETE",
    webhookId: webhookForCleanup.id,
    webhookToken: webhookForCleanup.token,
    timeoutMs: WEBHOOK_CLEANUP_TIMEOUT_MS,
  }).catch(() => {
    // Best-effort cleanup only.
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
    writeStdoutLine(`sessionKey: ${maskIdentifier(success.binding.targetSessionKey)}`);
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
      error: safeErrorMessage(err),
    };
  }

  const smokeId = `acp-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const deadline = startedAt + args.timeoutMs;
  const ackToken = `ACP_SMOKE_ACK_${smokeId}`;
  const instruction = buildInstruction({
    smokeId,
    ackToken,
    targetAgent: args.targetAgent,
    mentionUserId: args.mentionUserId,
    template: args.instruction,
  });

  let readAuthHeader = "";
  let sentMessageId;
  let setupStage: "discord-api" | "send-message" = "discord-api";
  let senderAuthorId: string | undefined;
  let minBindingBoundAt;
  let webhookForCleanup: WebhookForCleanup | undefined;

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
        timeoutMs: remainingTimeoutMs(deadline),
      });
      senderAuthorId = driverUser.id;

      setupStage = "send-message";
      minBindingBoundAt = Date.now() - 3_000;
      const sent = await discordApi<DiscordMessage>({
        method: "POST",
        path: `/channels/${encodeURIComponent(args.channelId)}/messages`,
        authHeader,
        timeoutMs: remainingTimeoutMs(deadline),
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
        timeoutMs: remainingTimeoutMs(deadline),
      });

      setupStage = "send-message";
      const webhook = await discordApi<{ id: string; token?: string | null }>({
        method: "POST",
        path: `/channels/${encodeURIComponent(args.channelId)}/webhooks`,
        authHeader: botAuthHeader,
        timeoutMs: remainingTimeoutMs(deadline),
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

      minBindingBoundAt = Date.now() - 3_000;
      const sent = await discordWebhookApi<DiscordMessage>({
        method: "POST",
        webhookId: webhook.id,
        webhookToken: webhook.token,
        query: "wait=true",
        timeoutMs: remainingTimeoutMs(deadline),
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
      minBindingBoundAt = Date.now() - 3_000;
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
        timeoutMs: remainingTimeoutMs(deadline),
      });
      sentMessageId = sent.payload?.result?.messageId || "";
      if (!sentMessageId) {
        throw new Error("openclaw message send did not return payload.result.messageId");
      }
    }
  } catch (err) {
    await cleanupWebhook(webhookForCleanup);
    return {
      ok: false,
      stage: setupStage,
      smokeId,
      error: safeErrorMessage(err),
    };
  }

  let winningBinding: ThreadBindingRecord | undefined;
  let latestCandidates: ThreadBindingRecord[] = [];

  try {
    while (Date.now() < deadline && !winningBinding) {
      try {
        const entries = await readThreadBindings(args.stateDir);
        latestCandidates = resolveCandidateBindings({
          entries,
          minBoundAt: minBindingBoundAt,
          targetAgent: args.targetAgent,
        });
        winningBinding = latestCandidates[0];
      } catch {
        // Keep polling; file may not exist yet or may be mid-write.
      }
      if (!winningBinding) {
        await sleepUntilDeadline({ pollMs: args.pollMs, deadlineMs: deadline });
      }
    }

    if (!winningBinding?.threadId || !winningBinding?.targetSessionKey) {
      let parentRecent: DiscordMessage[] = [];
      try {
        parentRecent = await loadParentRecentMessages({
          args,
          readAuthHeader,
          timeoutMs: remainingTimeoutMs(deadline),
        });
      } catch {
        // Best effort diagnostics only.
      }
      return {
        ok: false,
        stage: "wait-binding",
        smokeId,
        error: `Timed out waiting for new ACP thread binding (state: ${redactHomePath(args.stateDir)}).`,
        diagnostics: {
          bindingCandidates: latestCandidates.slice(0, 6).map((entry) => ({
            threadId: entry.threadId || "",
            targetSessionKey: maskIdentifier(entry.targetSessionKey),
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
                timeoutMs: remainingTimeoutMs(deadline),
              })
            : await discordApi<DiscordMessage[]>({
                method: "GET",
                path: `/channels/${encodeURIComponent(threadId)}/messages?limit=50`,
                authHeader: readAuthHeader,
                timeoutMs: remainingTimeoutMs(deadline),
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
        await sleepUntilDeadline({ pollMs: args.pollMs, deadlineMs: deadline });
      }
    }

    if (!ackMessage) {
      let parentRecent: DiscordMessage[] = [];
      try {
        parentRecent = await loadParentRecentMessages({
          args,
          readAuthHeader,
          timeoutMs: remainingTimeoutMs(deadline),
        });
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
              targetSessionKey: maskIdentifier(winningBinding.targetSessionKey),
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
    await cleanupWebhook(webhookForCleanup);
  }
}

async function main(): Promise<number> {
  if (hasFlag("--help") || hasFlag("-h")) {
    writeStdoutLine(usage());
    return 0;
  }
  const result = await run().catch(
    (err: unknown): FailureResult => ({
      ok: false,
      stage: "unexpected",
      smokeId: "n/a",
      error: safeErrorMessage(err),
    }),
  );
  printOutput({
    json: hasFlag("--json"),
    payload: result,
  });
  return result.ok ? 0 : 1;
}

export const testing = {
  parseDriverMode,
  parseNumber,
  DISCORD_RESPONSE_BODY_MAX_BYTES,
  redactDiscordApiPath,
  readDiscordResponseText,
  remainingTimeoutMs,
  requestDiscordJson,
  resolveStateDir,
  safeErrorMessage,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
