/**
 * HTTP callback handler for Mattermost slash commands.
 *
 * Receives POST requests from Mattermost when a slash command is invoked,
 * validates the token, and routes the command through the standard inbound pipeline.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedMattermostAccount } from "../mattermost/accounts.js";
import { getMattermostRuntime } from "../runtime.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  sendMattermostTyping,
  type MattermostChannel,
} from "./client.js";
import {
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";
import {
  authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import {
  buildModelsProviderData,
  createChannelReplyPipeline,
  isRequestBodyLimitError,
  logTypingFailure,
  readRequestBodyWithLimit,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import {
  MATTERMOST_SLASH_POST_METHOD,
  getMattermostCommand,
  listMattermostCommands,
  normalizeSlashCommandTrigger,
  parseSlashCommandPayload,
  resolveCommandText,
  type MattermostRegisteredCommand,
  type MattermostCommandResponse,
  type MattermostSlashCommandResponse,
  type MattermostSlashCommandPayload,
} from "./slash-commands.js";

type SlashHttpHandlerParams = {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  /** Commands registered or reconciled during monitor startup. */
  registeredCommands: readonly MattermostRegisteredCommand[];
  /** Map from trigger to original command name (for skill commands that start with oc_). */
  triggerMap?: ReadonlyMap<string, string>;
  log?: (msg: string) => void;
  bodyTimeoutMs?: number;
};

const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const COMMAND_LOOKUP_TIMEOUT_MS = 1_000;
const COMMAND_VALIDATION_FAILURE_CACHE_MS = 5_000;
const COMMAND_VALIDATION_FAILURE_CACHE_MAX_KEYS = 2_000;
const COMMAND_VALIDATION_LOOKUP_BURST = 20;
const COMMAND_VALIDATION_LOOKUP_REFILL_MS = 500;
const COMMAND_VALIDATION_LOOKUP_LIMIT_LOG_MS = 5_000;
const COMMAND_VALIDATION_LOOKUP_RATE_LIMIT_MAX_KEYS = 2_000;
type CommandLookupInflightEntry = {
  accountId: string;
  promise: Promise<MattermostCommandResponse | null>;
};
type CommandValidationRateLimitEntry = {
  accountId: string;
  tokens: number;
  updatedAt: number;
  lastLimitedLogAt: number;
};
const commandLookupInflight = new Map<string, CommandLookupInflightEntry>();
const commandValidationFailureCache = new Map<string, { accountId: string; expiresAt: number }>();
const commandValidationLookupRateLimit = new Map<string, CommandValidationRateLimitEntry>();
const SECRET_LOG_KEYS = new Set([
  "access_token",
  "authorization",
  "bottoken",
  "client_secret",
  "refresh_token",
  "token",
]);

/**
 * Read the full request body as a string.
 */
function readBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs = BODY_READ_TIMEOUT_MS,
): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs,
  });
}

function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: MattermostSlashCommandResponse,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function findRegisteredCommandForPayload(params: {
  registeredCommands: readonly MattermostRegisteredCommand[];
  payload: MattermostSlashCommandPayload;
}): MattermostRegisteredCommand | undefined {
  const trigger = normalizeSlashCommandTrigger(params.payload.command);
  return params.registeredCommands.find(
    (cmd) => cmd.teamId === params.payload.team_id && cmd.trigger === trigger,
  );
}

function isDeletedMattermostCommand(command: { delete_at?: number }): boolean {
  return typeof command.delete_at === "number" && command.delete_at > 0;
}

function sanitizeCommandLookupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\r\n\t]/gu, " ")
    .replace(/https?:\/\/[^\s)\]}]+/giu, (urlText) => {
      try {
        const url = new URL(urlText);
        if (url.username || url.password) {
          url.username = "redacted";
          url.password = "redacted";
        }
        for (const key of url.searchParams.keys()) {
          if (SECRET_LOG_KEYS.has(key.toLowerCase())) {
            url.searchParams.set(key, "redacted");
          }
        }
        return url.toString();
      } catch {
        return urlText;
      }
    })
    .replace(/(^|[^\w-])(Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/giu, "$1$2 [redacted]")
    .replace(
      /\b(token|authorization|access_token|refresh_token|client_secret|botToken)\b(\s*["']?\s*(?:=|:)\s*["']?)[^"',\s;}]+/giu,
      "$1$2[redacted]",
    )
    .slice(0, 300);
}

function sanitizeMattermostLogValue(value: string): string {
  return value.replace(/[\r\n\t]/gu, " ").slice(0, 200);
}

async function withCommandLookupTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_LOOKUP_TIMEOUT_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function commandLookupKey(
  client: ReturnType<typeof createMattermostClient>,
  registered: MattermostRegisteredCommand,
  accountId: string,
): string {
  return `${client.apiBaseUrl}:${accountId}:${registered.teamId}:${registered.id}`;
}

export function resetMattermostSlashCommandValidationCacheForTests(): void {
  commandLookupInflight.clear();
  commandValidationFailureCache.clear();
  commandValidationLookupRateLimit.clear();
}

export function clearMattermostSlashCommandValidationCacheForAccount(accountId: string): void {
  for (const [key, entry] of commandValidationFailureCache) {
    if (entry.accountId === accountId) {
      commandValidationFailureCache.delete(key);
    }
  }
  for (const [key, entry] of commandLookupInflight) {
    if (entry.accountId === accountId) {
      commandLookupInflight.delete(key);
    }
  }
  for (const [key, entry] of commandValidationLookupRateLimit) {
    if (entry.accountId === accountId) {
      commandValidationLookupRateLimit.delete(key);
    }
  }
}

function sweepCommandValidationFailureCache(now = Date.now()): void {
  for (const [key, entry] of commandValidationFailureCache) {
    if (entry.expiresAt <= now) {
      commandValidationFailureCache.delete(key);
    }
  }
  while (commandValidationFailureCache.size > COMMAND_VALIDATION_FAILURE_CACHE_MAX_KEYS) {
    const oldestKey = commandValidationFailureCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    commandValidationFailureCache.delete(oldestKey);
  }
}

function hasCachedCommandValidationFailure(key: string, now = Date.now()): boolean {
  sweepCommandValidationFailureCache(now);
  const cached = commandValidationFailureCache.get(key);
  if (!cached) {
    return false;
  }
  if (cached.expiresAt > now) {
    return true;
  }
  commandValidationFailureCache.delete(key);
  return false;
}

function cacheCommandValidationFailure(key: string, accountId: string): void {
  sweepCommandValidationFailureCache();
  commandValidationFailureCache.set(key, {
    accountId,
    expiresAt: Date.now() + COMMAND_VALIDATION_FAILURE_CACHE_MS,
  });
}

function sweepCommandValidationLookupRateLimit(now = Date.now()): void {
  const staleAfterMs = COMMAND_VALIDATION_LOOKUP_REFILL_MS * COMMAND_VALIDATION_LOOKUP_BURST * 2;
  for (const [key, entry] of commandValidationLookupRateLimit) {
    if (now - entry.updatedAt > staleAfterMs) {
      commandValidationLookupRateLimit.delete(key);
    }
  }
  while (commandValidationLookupRateLimit.size > COMMAND_VALIDATION_LOOKUP_RATE_LIMIT_MAX_KEYS) {
    const oldestKey = commandValidationLookupRateLimit.keys().next().value;
    if (!oldestKey) {
      break;
    }
    commandValidationLookupRateLimit.delete(oldestKey);
  }
}

function reserveCommandValidationLookup(params: {
  key: string;
  accountId: string;
  now?: number;
}): { allowed: true } | { allowed: false; shouldLog: boolean } {
  const now = params.now ?? Date.now();
  sweepCommandValidationLookupRateLimit(now);
  const existing = commandValidationLookupRateLimit.get(params.key);
  if (!existing) {
    commandValidationLookupRateLimit.set(params.key, {
      accountId: params.accountId,
      tokens: COMMAND_VALIDATION_LOOKUP_BURST - 1,
      updatedAt: now,
      lastLimitedLogAt: 0,
    });
    return { allowed: true };
  }

  const refill = Math.floor((now - existing.updatedAt) / COMMAND_VALIDATION_LOOKUP_REFILL_MS);
  if (refill > 0) {
    existing.tokens = Math.min(COMMAND_VALIDATION_LOOKUP_BURST, existing.tokens + refill);
    existing.updatedAt += refill * COMMAND_VALIDATION_LOOKUP_REFILL_MS;
  }
  if (existing.tokens <= 0) {
    const shouldLog = now - existing.lastLimitedLogAt >= COMMAND_VALIDATION_LOOKUP_LIMIT_LOG_MS;
    if (shouldLog) {
      existing.lastLimitedLogAt = now;
    }
    return { allowed: false, shouldLog };
  }
  existing.tokens -= 1;
  return { allowed: true };
}

async function fetchCurrentMattermostCommandUncached(params: {
  client: ReturnType<typeof createMattermostClient>;
  registered: MattermostRegisteredCommand;
  log?: (msg: string) => void;
}): Promise<MattermostCommandResponse | null> {
  let commandLookupResult: MattermostCommandResponse | null = null;
  let commandLookupError: unknown;
  let commandLookupFallbackDetail: string | undefined;
  try {
    commandLookupResult = await withCommandLookupTimeout((signal) =>
      getMattermostCommand(params.client, params.registered.id, { signal }),
    );
    if (!isDeletedMattermostCommand(commandLookupResult)) {
      return commandLookupResult;
    }
    commandLookupFallbackDetail = `command lookup by id returned deleted command ${sanitizeMattermostLogValue(commandLookupResult.id)}`;
  } catch (err) {
    commandLookupError = err;
    // Older Mattermost servers may not expose GET /commands/{id}; fall back to
    // the team command list, which registration already requires.
  }

  try {
    const currentCommands = await withCommandLookupTimeout((signal) =>
      listMattermostCommands(params.client, params.registered.teamId, { signal }),
    );
    if (commandLookupError) {
      params.log?.(
        `mattermost: slash command lookup by id failed for /${sanitizeMattermostLogValue(params.registered.trigger)}; using team list fallback: ${sanitizeCommandLookupError(commandLookupError)}`,
      );
    } else if (commandLookupFallbackDetail) {
      params.log?.(
        `mattermost: slash ${commandLookupFallbackDetail} for /${sanitizeMattermostLogValue(params.registered.trigger)}; using team list fallback`,
      );
    }
    return currentCommands.find((cmd) => cmd.id === params.registered.id) ?? commandLookupResult;
  } catch (err) {
    const primaryDetail = commandLookupError
      ? `; command lookup: ${sanitizeCommandLookupError(commandLookupError)}`
      : commandLookupFallbackDetail
        ? `; command lookup: ${commandLookupFallbackDetail}`
        : "";
    params.log?.(
      `mattermost: slash command registration check failed for /${sanitizeMattermostLogValue(params.registered.trigger)}: ${sanitizeCommandLookupError(err)}${primaryDetail}`,
    );
    return null;
  }
}

async function fetchCurrentMattermostCommand(params: {
  accountId: string;
  client: ReturnType<typeof createMattermostClient>;
  registered: MattermostRegisteredCommand;
  log?: (msg: string) => void;
}): Promise<MattermostCommandResponse | null> {
  const key = commandLookupKey(params.client, params.registered, params.accountId);
  const existing = commandLookupInflight.get(key);
  if (existing) {
    return await existing.promise;
  }

  const lookup = fetchCurrentMattermostCommandUncached(params).finally(() => {
    commandLookupInflight.delete(key);
  });
  commandLookupInflight.set(key, { accountId: params.accountId, promise: lookup });
  return await lookup;
}

export async function validateMattermostSlashCommandToken(params: {
  accountId: string;
  client: ReturnType<typeof createMattermostClient>;
  registeredCommand: MattermostRegisteredCommand;
  payload: MattermostSlashCommandPayload;
  log?: (msg: string) => void;
}): Promise<boolean> {
  const lookupKey = commandLookupKey(params.client, params.registeredCommand, params.accountId);
  if (hasCachedCommandValidationFailure(lookupKey)) {
    return false;
  }
  if (!commandLookupInflight.has(lookupKey)) {
    const reservation = reserveCommandValidationLookup({
      key: lookupKey,
      accountId: params.accountId,
    });
    if (!reservation.allowed) {
      if (reservation.shouldLog) {
        params.log?.(
          `mattermost: slash command validation lookup rate-limited for /${sanitizeMattermostLogValue(params.registeredCommand.trigger)}`,
        );
      }
      return false;
    }
  }
  const current = await fetchCurrentMattermostCommand({
    accountId: params.accountId,
    client: params.client,
    registered: params.registeredCommand,
    log: params.log,
  });
  if (!current || isDeletedMattermostCommand(current)) {
    cacheCommandValidationFailure(lookupKey, params.accountId);
    return false;
  }
  if (
    current.id !== params.registeredCommand.id ||
    current.team_id !== params.registeredCommand.teamId ||
    current.trigger !== params.registeredCommand.trigger ||
    current.method !== MATTERMOST_SLASH_POST_METHOD ||
    current.url !== params.registeredCommand.url
  ) {
    cacheCommandValidationFailure(lookupKey, params.accountId);
    return false;
  }
  if (!current.token || !safeEqualSecret(params.payload.token, current.token)) {
    cacheCommandValidationFailure(lookupKey, params.accountId);
    return false;
  }
  commandValidationFailureCache.delete(lookupKey);
  return true;
}

type SlashInvocationAuth = {
  ok: boolean;
  denyResponse?: MattermostSlashCommandResponse;
  commandAuthorized: boolean;
  channelInfo: MattermostChannel | null;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
};

async function authorizeSlashInvocation(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  log?: (msg: string) => void;
}): Promise<SlashInvocationAuth> {
  const { account, cfg, client, commandText, channelId, senderId, senderName, log } = params;
  const core = getMattermostRuntime();

  // Resolve channel info so we can enforce DM vs group/channel policies.
  let channelInfo: MattermostChannel | null = null;
  try {
    channelInfo = await fetchMattermostChannel(client, channelId);
  } catch (err) {
    log?.(
      `mattermost: slash channel lookup failed for ${sanitizeMattermostLogValue(channelId)}: ${sanitizeCommandLookupError(err)}`,
    );
  }

  if (!channelInfo) {
    return {
      ok: false,
      denyResponse: {
        response_type: "ephemeral",
        text: "Temporary error: unable to determine channel type. Please try again.",
      },
      commandAuthorized: false,
      channelInfo: null,
      kind: "channel",
      chatType: "channel",
      channelName: "",
      channelDisplay: "",
      roomLabel: `#${channelId}`,
    };
  }

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "mattermost",
  });
  const hasControlCommand = core.channel.text.hasControlCommand(commandText, cfg);
  const storeAllowFrom = normalizeMattermostAllowList(
    await core.channel.pairing
      .readAllowFromStore({
        channel: "mattermost",
        accountId: account.accountId,
      })
      .catch(() => []),
  );
  const decision = authorizeMattermostCommandInvocation({
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    channelInfo,
    storeAllowFrom,
    allowTextCommands,
    hasControlCommand,
  });

  if (!decision.ok) {
    if (decision.denyReason === "dm-pairing") {
      const { code } = await core.channel.pairing.upsertPairingRequest({
        channel: "mattermost",
        accountId: account.accountId,
        id: senderId,
        meta: { name: senderName },
      });
      return {
        ...decision,
        denyResponse: {
          response_type: "ephemeral",
          text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${senderId}`,
            code,
          }),
        },
      };
    }

    const denyText =
      decision.denyReason === "unknown-channel"
        ? "Temporary error: unable to determine channel type. Please try again."
        : decision.denyReason === "dm-disabled"
          ? "This bot is not accepting direct messages."
          : decision.denyReason === "channels-disabled"
            ? "Slash commands are disabled in channels."
            : decision.denyReason === "channel-no-allowlist"
              ? "Slash commands are not configured for this channel (no allowlist)."
              : "Unauthorized.";
    return {
      ...decision,
      denyResponse: {
        response_type: "ephemeral",
        text: denyText,
      },
    };
  }

  return {
    ...decision,
    denyResponse: undefined,
  };
}

/**
 * Create the HTTP request handler for Mattermost slash command callbacks.
 *
 * This handler is registered as a plugin HTTP route and receives POSTs
 * from the Mattermost server when a user invokes a registered slash command.
 */
export function createSlashCommandHttpHandler(params: SlashHttpHandlerParams) {
  const { account, cfg, runtime, registeredCommands, triggerMap, log, bodyTimeoutMs } = params;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs);
    } catch (error) {
      if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end("Request body timeout");
        return;
      }
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    const payload = parseSlashCommandPayload(body, contentType);
    if (!payload) {
      sendJsonResponse(res, 400, {
        response_type: "ephemeral",
        text: "Invalid slash command payload.",
      });
      return;
    }

    const registeredCommand = findRegisteredCommandForPayload({ registeredCommands, payload });

    // Fail closed when no commands are registered, the payload doesn't map to
    // a registered (team, trigger), or the payload token doesn't equal the
    // resolved command's startup token. Comparing against the resolved
    // command's token (rather than any token in the account) prevents a token
    // valid for command A from advancing to upstream validation for command B,
    // which would otherwise let an attacker poison the per-command failure
    // cache and DoS legitimate invocations of command B.
    if (
      registeredCommands.length === 0 ||
      !registeredCommand ||
      !safeEqualSecret(payload.token, registeredCommand.token)
    ) {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // Extract command info
    const client = createMattermostClient({
      baseUrl: account.baseUrl ?? "",
      botToken: account.botToken ?? "",
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    });

    const tokenIsCurrent = await validateMattermostSlashCommandToken({
      accountId: account.accountId,
      client,
      registeredCommand,
      payload,
      log,
    });
    if (!tokenIsCurrent) {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // Extract command info
    const trigger = normalizeSlashCommandTrigger(payload.command);
    const commandText = resolveCommandText(trigger, payload.text, triggerMap);
    const channelId = payload.channel_id;
    const senderId = payload.user_id;
    const senderName = payload.user_name ?? senderId;

    const auth = await authorizeSlashInvocation({
      account,
      cfg,
      client,
      commandText,
      channelId,
      senderId,
      senderName,
      log,
    });

    if (!auth.ok) {
      sendJsonResponse(
        res,
        200,
        auth.denyResponse ?? { response_type: "ephemeral", text: "Unauthorized." },
      );
      return;
    }

    log?.(
      `mattermost: slash command /${sanitizeMattermostLogValue(trigger)} from ${sanitizeMattermostLogValue(senderName)} in ${sanitizeMattermostLogValue(channelId)}`,
    );

    // Acknowledge immediately — we'll send the actual reply asynchronously
    sendJsonResponse(res, 200, {
      response_type: "ephemeral",
      text: "Processing...",
    });

    // Now handle the command asynchronously (post reply as a message)
    try {
      await handleSlashCommandAsync({
        account,
        cfg,
        runtime,
        client,
        commandText,
        channelId,
        senderId,
        senderName,
        teamId: payload.team_id,
        triggerId: payload.trigger_id,
        kind: auth.kind,
        chatType: auth.chatType,
        channelName: auth.channelName,
        channelDisplay: auth.channelDisplay,
        roomLabel: auth.roomLabel,
        commandAuthorized: auth.commandAuthorized,
        log,
      });
    } catch (err) {
      log?.(`mattermost: slash command handler error: ${sanitizeCommandLookupError(err)}`);
      try {
        const to = `channel:${channelId}`;
        await sendMessageMattermost(to, "Sorry, something went wrong processing that command.", {
          cfg,
          accountId: account.accountId,
        });
      } catch {
        // best-effort error reply
      }
    }
  };
}

async function handleSlashCommandAsync(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  teamId: string;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
  commandAuthorized: boolean;
  triggerId?: string;
  log?: (msg: string) => void;
}) {
  const {
    account,
    cfg,
    runtime,
    client,
    commandText,
    channelId,
    senderId,
    senderName,
    teamId,
    kind,
    chatType,
    channelName: _channelName,
    channelDisplay,
    roomLabel,
    commandAuthorized,
    triggerId,
    log,
  } = params;
  const core = getMattermostRuntime();

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? senderId : channelId,
    },
  });

  const fromLabel =
    kind === "direct"
      ? `Mattermost DM from ${senderName}`
      : `Mattermost message in ${roomLabel} from ${senderName}`;

  const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
  const pickerEntry = resolveMattermostModelPickerEntry(commandText);
  if (pickerEntry) {
    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      await sendMessageMattermost(to, "No models available.", {
        cfg,
        accountId: account.accountId,
      });
      return;
    }

    const currentModel = resolveMattermostModelPickerCurrentModel({
      cfg,
      route,
      data,
    });
    const view =
      pickerEntry.kind === "summary"
        ? renderMattermostModelSummaryView({
            ownerUserId: senderId,
            currentModel,
          })
        : pickerEntry.kind === "providers"
          ? renderMattermostProviderPickerView({
              ownerUserId: senderId,
              data,
              currentModel,
            })
          : renderMattermostModelsPickerView({
              ownerUserId: senderId,
              data,
              provider: pickerEntry.provider,
              page: 1,
              currentModel,
            });

    await sendMessageMattermost(to, view.text, {
      cfg,
      accountId: account.accountId,
      buttons: view.buttons,
    });
    runtime.log?.(`delivered model picker to ${to}`);
    return;
  }

  // Build inbound context — the command text is the body
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: commandText,
    BodyForAgent: commandText,
    RawBody: commandText,
    CommandBody: commandText,
    From:
      kind === "direct"
        ? `mattermost:${senderId}`
        : kind === "group"
          ? `mattermost:group:${channelId}`
          : `mattermost:channel:${channelId}`,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "mattermost" as const,
    Surface: "mattermost" as const,
    MessageSid: triggerId ?? `slash-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: commandAuthorized,
    CommandSource: "native" as const,
    OriginatingChannel: "mattermost" as const,
    OriginatingTo: to,
  });

  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, {
    fallbackLimit: account.textChunkLimit ?? 4000,
  });
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
  });

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "mattermost",
    accountId: account.accountId,
    typing: {
      start: () => sendMattermostTyping(client, { channelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => log?.(message),
          channel: "mattermost",
          target: channelId,
          error: err,
        });
      },
    },
  });
  const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay,
      deliver: async (payload: ReplyPayload) => {
        await deliverMattermostReplyPayload({
          core,
          cfg,
          payload,
          to,
          accountId: account.accountId,
          agentId: route.agentId,
          textLimit,
          tableMode,
          sendMessage: sendMessageMattermost,
        });
        runtime.log?.(`delivered slash reply to ${to}`);
      },
      onError: (err, info) => {
        runtime.error?.(
          `mattermost slash ${info.kind} reply failed: ${sanitizeCommandLookupError(err)}`,
        );
      },
      onReplyStart: typingCallbacks?.onReplyStart,
    });

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected,
        },
      }),
  });
}
