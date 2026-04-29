/**
 * Inbound webhook handler for Synology Chat outgoing webhooks.
 * Parses form-urlencoded/JSON body, validates security, delivers to agent.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import * as synologyClient from "./client.js";
import { validateToken, authorizeUserForDm, sanitizeInput, RateLimiter } from "./security.js";
import type { SynologyWebhookPayload, ResolvedSynologyChatAccount } from "./types.js";

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// One rate limiter per account, created lazily
const rateLimiters = new Map<string, RateLimiter>();
const invalidTokenRateLimiters = new Map<string, InvalidTokenRateLimiter>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_BODY_TIMEOUT_MS = 5_000;
const PREAUTH_MAX_REQUESTS_PER_MINUTE = 10;
const INVALID_TOKEN_WINDOW_MS = 60_000;
const INVALID_TOKEN_MAX_TRACKED_KEYS = 5_000;

type InvalidTokenRateLimitState = {
  count: number;
  windowStartMs: number;
};

class InvalidTokenRateLimiter {
  private readonly limit: number;
  private readonly state = new Map<string, InvalidTokenRateLimitState>();

  constructor(limit: number) {
    this.limit = limit;
  }

  private normalizeState(key: string, nowMs: number): InvalidTokenRateLimitState | undefined {
    const existing = this.state.get(key);
    if (!existing) {
      return undefined;
    }
    if (nowMs - existing.windowStartMs >= INVALID_TOKEN_WINDOW_MS) {
      this.state.delete(key);
      return undefined;
    }
    return existing;
  }

  private touch(key: string, value: InvalidTokenRateLimitState): void {
    this.state.delete(key);
    this.state.set(key, value);
    while (this.state.size > INVALID_TOKEN_MAX_TRACKED_KEYS) {
      const oldestKey = this.state.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.state.delete(oldestKey);
    }
  }

  isLocked(key: string, nowMs = Date.now()): boolean {
    if (!key) {
      return false;
    }
    const existing = this.normalizeState(key, nowMs);
    return (existing?.count ?? 0) > this.limit;
  }

  recordFailure(key: string, nowMs = Date.now()): boolean {
    if (!key) {
      return false;
    }
    const existing = this.normalizeState(key, nowMs);
    const nextCount = (existing?.count ?? 0) + 1;
    const windowStartMs = existing?.windowStartMs ?? nowMs;
    this.touch(key, { count: nextCount, windowStartMs });
    return nextCount > this.limit;
  }

  clear(): void {
    this.state.clear();
  }

  maxRequests(): number {
    return this.limit;
  }
}

function getRateLimiter(account: ResolvedSynologyChatAccount): RateLimiter {
  let rl = rateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
    rl?.clear();
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}

function getInvalidTokenRateLimiter(account: ResolvedSynologyChatAccount): InvalidTokenRateLimiter {
  const limit = Math.min(account.rateLimitPerMinute, PREAUTH_MAX_REQUESTS_PER_MINUTE);
  let rl = invalidTokenRateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== limit) {
    rl?.clear();
    rl = new InvalidTokenRateLimiter(limit);
    invalidTokenRateLimiters.set(account.accountId, rl);
  }
  return rl;
}

export function clearSynologyWebhookRateLimiterStateForTest(): void {
  for (const limiter of rateLimiters.values()) {
    limiter.clear();
  }
  rateLimiters.clear();
  for (const limiter of invalidTokenRateLimiters.values()) {
    limiter.clear();
  }
  invalidTokenRateLimiters.clear();
  webhookInFlightLimiter.clear();
}

export function getSynologyWebhookRateLimiterCountForTest(): number {
  return rateLimiters.size + invalidTokenRateLimiters.size;
}

function getSynologyWebhookInvalidTokenRateLimitKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

function getSynologyWebhookInFlightKey(account: ResolvedSynologyChatAccount): string {
  // Synology webhook ingress is typically a single upstream per account, and this
  // handler does not have a trusted-proxy-aware client IP config. Keep the shared
  // pre-auth concurrency budget scoped per account instead of keying on a fragile
  // remoteAddress value that can collapse behind proxies or to "unknown".
  return account.accountId;
}

/** Read the full request body as a string. */
async function readBody(
  req: IncomingMessage,
  timeoutMs = PREAUTH_BODY_TIMEOUT_MS,
): Promise<
  | { ok: true; body: string }
  | {
      ok: false;
      statusCode: number;
      error: string;
    }
> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: PREAUTH_MAX_BODY_BYTES,
      timeoutMs,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code),
      };
    }
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid request body",
    };
  }
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = firstNonEmptyString(item);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  const str = typeof value === "string" ? value.trim() : "";
  return str.length > 0 ? str : undefined;
}

function pickAlias(record: Record<string, unknown>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const normalized = firstNonEmptyString(record[alias]);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function parseQueryParams(req: IncomingMessage): Record<string, unknown> {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const out: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseFormBody(body: string): Record<string, unknown> {
  return querystring.parse(body) as Record<string, unknown>;
}

function parseJsonBody(body: string): Record<string, unknown> {
  if (!body.trim()) {
    return {};
  }
  const parsed = JSON.parse(body);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Invalid JSON body");
  }
  return parsed as Record<string, unknown>;
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return firstNonEmptyString(header);
}

function extractTokenFromHeaders(req: IncomingMessage): string | undefined {
  const explicit =
    headerValue(req.headers["x-synology-token"]) ??
    headerValue(req.headers["x-webhook-token"]) ??
    headerValue(req.headers["x-openclaw-token"]);
  if (explicit) {
    return explicit;
  }

  const auth = headerValue(req.headers.authorization);
  if (!auth) {
    return undefined;
  }

  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return bearerMatch[1].trim();
  }
  return auth.trim();
}

/**
 * Parse/normalize incoming webhook payload.
 *
 * Supports:
 * - application/x-www-form-urlencoded
 * - application/json
 *
 * Token resolution order: body.token -> query.token -> headers
 * Field aliases:
 * - user_id <- user_id | userId | user
 * - text    <- text | message | content
 */
function parsePayload(req: IncomingMessage, body: string): SynologyWebhookPayload | null {
  const contentType = normalizeLowercaseStringOrEmpty(req.headers["content-type"]);

  let bodyFields: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    bodyFields = parseJsonBody(body);
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    bodyFields = parseFormBody(body);
  } else {
    // Fallback for clients with missing/incorrect content-type.
    // Try JSON first, then form-urlencoded.
    try {
      bodyFields = parseJsonBody(body);
    } catch {
      bodyFields = parseFormBody(body);
    }
  }

  const queryFields = parseQueryParams(req);
  const headerToken = extractTokenFromHeaders(req);

  const token =
    pickAlias(bodyFields, ["token"]) ?? pickAlias(queryFields, ["token"]) ?? headerToken;
  const userId =
    pickAlias(bodyFields, ["user_id", "userId", "user"]) ??
    pickAlias(queryFields, ["user_id", "userId", "user"]);
  const text =
    pickAlias(bodyFields, ["text", "message", "content"]) ??
    pickAlias(queryFields, ["text", "message", "content"]);

  if (!token || !userId || !text) {
    return null;
  }

  return {
    token,
    channel_id:
      pickAlias(bodyFields, ["channel_id"]) ?? pickAlias(queryFields, ["channel_id"]) ?? undefined,
    channel_name:
      pickAlias(bodyFields, ["channel_name"]) ??
      pickAlias(queryFields, ["channel_name"]) ??
      undefined,
    user_id: userId,
    username:
      pickAlias(bodyFields, ["username", "user_name", "name"]) ??
      pickAlias(queryFields, ["username", "user_name", "name"]) ??
      "unknown",
    post_id: pickAlias(bodyFields, ["post_id"]) ?? pickAlias(queryFields, ["post_id"]) ?? undefined,
    timestamp:
      pickAlias(bodyFields, ["timestamp"]) ?? pickAlias(queryFields, ["timestamp"]) ?? undefined,
    text,
    trigger_word:
      pickAlias(bodyFields, ["trigger_word", "triggerWord"]) ??
      pickAlias(queryFields, ["trigger_word", "triggerWord"]) ??
      undefined,
  };
}

/** Send a JSON response. */
function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Send a no-content ACK. */
function respondNoContent(res: ServerResponse) {
  res.writeHead(204);
  res.end();
}

export interface WebhookHandlerDeps {
  account: ResolvedSynologyChatAccount;
  deliver: (msg: import("./inbound-context.js").SynologyInboundMessage) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  bodyTimeoutMs?: number;
}

/**
 * Create an HTTP request handler for Synology Chat outgoing webhooks.
 *
 * This handler:
 * 1. Parses form-urlencoded/JSON payload
 * 2. Validates token (constant-time)
 * 3. Checks user allowlist
 * 4. Checks rate limit
 * 5. Sanitizes input
 * 6. Immediately ACKs request (204)
 * 7. Delivers to the agent asynchronously and sends final reply via incomingUrl
 */
type SynologyWebhookAuthorization =
  | { ok: false; statusCode: number; error: string }
  | { ok: true; commandAuthorized: boolean };

type AuthorizedSynologyWebhook = {
  payload: SynologyWebhookPayload;
  body: string;
  commandAuthorized: boolean;
  preview: string;
};

async function parseWebhookPayloadRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  log?: WebhookHandlerDeps["log"];
  bodyTimeoutMs?: number;
}): Promise<{ ok: false } | { ok: true; payload: SynologyWebhookPayload }> {
  const bodyResult = await readBody(params.req, params.bodyTimeoutMs);
  if (!bodyResult.ok) {
    params.log?.error("Failed to read request body", bodyResult.error);
    respondJson(params.res, bodyResult.statusCode, { error: bodyResult.error });
    return { ok: false };
  }

  let payload: SynologyWebhookPayload | null = null;
  try {
    payload = parsePayload(params.req, bodyResult.body);
  } catch (err) {
    params.log?.warn("Failed to parse webhook payload", err);
    respondJson(params.res, 400, { error: "Invalid request body" });
    return { ok: false };
  }
  if (!payload) {
    respondJson(params.res, 400, { error: "Missing required fields (token, user_id, text)" });
    return { ok: false };
  }
  return { ok: true, payload };
}

function authorizeSynologyWebhook(params: {
  req: IncomingMessage;
  account: ResolvedSynologyChatAccount;
  payload: SynologyWebhookPayload;
  invalidTokenRateLimiter: InvalidTokenRateLimiter;
  rateLimiter: RateLimiter;
  log?: WebhookHandlerDeps["log"];
}): SynologyWebhookAuthorization {
  const invalidTokenRateLimitKey = getSynologyWebhookInvalidTokenRateLimitKey(params.req);
  // Once a source has exhausted its invalid-token budget, reject all requests in the window.
  if (params.invalidTokenRateLimiter.isLocked(invalidTokenRateLimitKey)) {
    params.log?.warn(`Rate limit exceeded for remote IP: ${invalidTokenRateLimitKey}`);
    return { ok: false, statusCode: 429, error: "Rate limit exceeded" };
  }

  if (!validateToken(params.payload.token, params.account.token)) {
    if (params.invalidTokenRateLimiter.recordFailure(invalidTokenRateLimitKey)) {
      params.log?.warn(`Rate limit exceeded for remote IP: ${invalidTokenRateLimitKey}`);
      return { ok: false, statusCode: 429, error: "Rate limit exceeded" };
    }
    params.log?.warn(`Invalid token from ${params.req.socket?.remoteAddress}`);
    return { ok: false, statusCode: 401, error: "Invalid token" };
  }

  const auth = authorizeUserForDm(
    params.payload.user_id,
    params.account.dmPolicy,
    params.account.allowedUserIds,
  );
  if (!auth.allowed) {
    if (auth.reason === "disabled") {
      return { ok: false, statusCode: 403, error: "DMs are disabled" };
    }
    if (auth.reason === "allowlist-empty") {
      params.log?.warn(
        "Synology Chat allowlist is empty while dmPolicy=allowlist; rejecting message",
      );
      return {
        ok: false,
        statusCode: 403,
        error:
          'Allowlist is empty. Configure allowedUserIds or use dmPolicy=open with allowedUserIds=["*"].',
      };
    }
    params.log?.warn(`Unauthorized user: ${params.payload.user_id}`);
    return { ok: false, statusCode: 403, error: "User not authorized" };
  }

  if (!params.rateLimiter.check(params.payload.user_id)) {
    // Keep a separate post-auth budget so authenticated users are still throttled per sender.
    params.log?.warn(`Rate limit exceeded for user: ${params.payload.user_id}`);
    return { ok: false, statusCode: 429, error: "Rate limit exceeded" };
  }

  return { ok: true, commandAuthorized: auth.allowed };
}

function sanitizeSynologyWebhookText(payload: SynologyWebhookPayload): string {
  let cleanText = sanitizeInput(payload.text);
  if (payload.trigger_word && cleanText.startsWith(payload.trigger_word)) {
    cleanText = cleanText.slice(payload.trigger_word.length).trim();
  }
  return cleanText;
}

async function parseAndAuthorizeSynologyWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  account: ResolvedSynologyChatAccount;
  invalidTokenRateLimiter: InvalidTokenRateLimiter;
  rateLimiter: RateLimiter;
  log?: WebhookHandlerDeps["log"];
  bodyTimeoutMs?: number;
}): Promise<{ ok: false } | { ok: true; message: AuthorizedSynologyWebhook }> {
  const parsed = await parseWebhookPayloadRequest(params);
  if (!parsed.ok) {
    return { ok: false };
  }

  const authorized = authorizeSynologyWebhook({
    req: params.req,
    account: params.account,
    payload: parsed.payload,
    invalidTokenRateLimiter: params.invalidTokenRateLimiter,
    rateLimiter: params.rateLimiter,
    log: params.log,
  });
  if (!authorized.ok) {
    respondJson(params.res, authorized.statusCode, { error: authorized.error });
    return { ok: false };
  }

  const cleanText = sanitizeSynologyWebhookText(parsed.payload);
  if (!cleanText) {
    respondNoContent(params.res);
    return { ok: false };
  }
  const preview = cleanText.length > 100 ? `${cleanText.slice(0, 100)}...` : cleanText;
  return {
    ok: true,
    message: {
      payload: parsed.payload,
      body: cleanText,
      commandAuthorized: authorized.commandAuthorized,
      preview,
    },
  };
}

async function resolveSynologyReplyDeliveryUserId(params: {
  account: ResolvedSynologyChatAccount;
  payload: SynologyWebhookPayload;
  log?: WebhookHandlerDeps["log"];
}): Promise<string> {
  if (!params.account.dangerouslyAllowNameMatching) {
    return params.payload.user_id;
  }

  const resolvedChatApiUserId = await synologyClient.resolveLegacyWebhookNameToChatUserId({
    incomingUrl: params.account.incomingUrl,
    mutableWebhookUsername: params.payload.username,
    allowInsecureSsl: params.account.allowInsecureSsl,
    log: params.log,
  });
  if (resolvedChatApiUserId !== undefined) {
    return String(resolvedChatApiUserId);
  }
  params.log?.warn(
    `Could not resolve Chat API user_id for "${params.payload.username}" — falling back to webhook user_id ${params.payload.user_id}. Reply delivery may fail.`,
  );
  return params.payload.user_id;
}

async function processAuthorizedSynologyWebhook(params: {
  account: ResolvedSynologyChatAccount;
  deliver: WebhookHandlerDeps["deliver"];
  log?: WebhookHandlerDeps["log"];
  message: AuthorizedSynologyWebhook;
}): Promise<void> {
  const authorizedWebhookUserId = params.message.payload.user_id;
  let deliveryUserId = authorizedWebhookUserId;
  try {
    deliveryUserId = await resolveSynologyReplyDeliveryUserId({
      account: params.account,
      payload: params.message.payload,
      log: params.log,
    });

    const deliverPromise = params.deliver({
      body: params.message.body,
      from: authorizedWebhookUserId,
      senderName: params.message.payload.username,
      provider: "synology-chat",
      chatType: "direct",
      accountId: params.account.accountId,
      commandAuthorized: params.message.commandAuthorized,
      chatUserId: deliveryUserId,
    });
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("Agent response timeout (120s)")), 120_000),
    );
    const reply = await Promise.race([deliverPromise, timeoutPromise]);
    if (!reply) {
      return;
    }

    await synologyClient.sendMessage(
      params.account.incomingUrl,
      reply,
      deliveryUserId,
      params.account.allowInsecureSsl,
    );
    const replyPreview = reply.length > 100 ? `${reply.slice(0, 100)}...` : reply;
    params.log?.info?.(
      `Reply sent to ${params.message.payload.username} (${deliveryUserId}): ${replyPreview}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    params.log?.error?.(
      `Failed to process message from ${params.message.payload.username}: ${errMsg}`,
    );
    await synologyClient.sendMessage(
      params.account.incomingUrl,
      "Sorry, an error occurred while processing your message.",
      deliveryUserId,
      params.account.allowInsecureSsl,
    );
  }
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);
  const invalidTokenRateLimiter = getInvalidTokenRateLimiter(account);

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const requestLifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      inFlightLimiter: webhookInFlightLimiter,
      inFlightKey: getSynologyWebhookInFlightKey(account),
    });
    if (!requestLifecycle.ok) {
      return;
    }

    let authorized: Awaited<ReturnType<typeof parseAndAuthorizeSynologyWebhook>>;
    try {
      authorized = await parseAndAuthorizeSynologyWebhook({
        req,
        res,
        account,
        invalidTokenRateLimiter,
        rateLimiter,
        log,
        bodyTimeoutMs: deps.bodyTimeoutMs,
      });
    } finally {
      // Only bound the pre-auth request pipeline; async reply delivery is outside webhook ingress.
      requestLifecycle.release();
    }
    if (!authorized.ok) {
      return;
    }

    log?.info(
      `Message from ${authorized.message.payload.username} (${authorized.message.payload.user_id}): ${authorized.message.preview}`,
    );

    // ACK immediately so Synology Chat won't remain in "Processing..."
    respondNoContent(res);
    await processAuthorizedSynologyWebhook({
      account,
      deliver,
      log,
      message: authorized.message,
    });
  };
}
