/**
 * Synology Chat HTTP client.
 * Sends messages TO Synology Chat via the incoming webhook URL.
 */

import * as http from "node:http";
import * as https from "node:https";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import {
  formatErrorMessage,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";

const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// --- Chat user_id resolution ---
// Synology Chat uses two different user_id spaces:
//   - Outgoing webhook user_id: per-integration sequential ID (e.g. 1)
//   - Chat API user_id: global internal ID (e.g. 4)
// The chatbot API (method=chatbot) requires the Chat API user_id in the
// user_ids array. We resolve via the user_list API and cache the result.

interface ChatUser {
  user_id: number;
  username: string;
  nickname: string;
}

type ChatUserCacheEntry = {
  users: ChatUser[];
  cachedAt: number;
};

type ChatWebhookPayload = {
  text?: string;
  file_url?: string;
  user_ids?: number[];
};

const ChatUserSchema = z
  .object({
    user_id: z.number(),
    username: z.string().optional(),
    nickname: z.string().optional(),
  })
  .transform(
    (user): ChatUser => ({
      user_id: user.user_id,
      username: user.username ?? "",
      nickname: user.nickname ?? "",
    }),
  );

const ChatUserListResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      users: z
        .array(z.unknown())
        .optional()
        .transform((users) =>
          (users ?? []).flatMap((user) => {
            const parsed = safeParseWithSchema(ChatUserSchema, user);
            return parsed ? [parsed] : [];
          }),
        ),
    })
    .optional(),
});

// Cache user lists per bot endpoint to avoid cross-account bleed.
const chatUserCache = new Map<string, ChatUserCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Send a text message to Synology Chat via the incoming webhook.
 *
 * @param incomingUrl - Synology Chat incoming webhook URL
 * @param text - Message text to send
 * @param userId - Optional user ID to mention with @
 * @returns true if sent successfully
 */
export async function sendMessage(
  incomingUrl: string,
  text: string,
  userId?: string | number,
  allowInsecureSsl = false,
): Promise<boolean> {
  // Synology Chat API requires user_ids (numeric) to specify the recipient
  // The @mention is optional but user_ids is mandatory
  const body = buildWebhookBody({ text }, userId);

  // Internal rate limit: min 500ms between sends
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < MIN_SEND_INTERVAL_MS) {
    await sleep(MIN_SEND_INTERVAL_MS - elapsed);
  }

  // Retry with exponential backoff (3 attempts, 300ms base)
  const maxRetries = 3;
  const baseDelay = 300;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const ok = await doPost(incomingUrl, body, allowInsecureSsl);
      lastSendTime = Date.now();
      if (ok) {
        return true;
      }
    } catch {
      // will retry
    }

    if (attempt < maxRetries - 1) {
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }

  return false;
}

/**
 * Send a file URL to Synology Chat.
 */
export async function sendFileUrl(
  incomingUrl: string,
  fileUrl: string,
  userId?: string | number,
  allowInsecureSsl = false,
): Promise<boolean> {
  try {
    const safeFileUrl = await assertSafeWebhookFileUrl(fileUrl);
    const body = buildWebhookBody({ file_url: safeFileUrl }, userId);

    const now = Date.now();
    const elapsed = now - lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - elapsed);
    }

    const ok = await doPost(incomingUrl, body, allowInsecureSsl);
    lastSendTime = Date.now();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the list of Chat users visible to this bot via the user_list API.
 * Results are cached for CACHE_TTL_MS to avoid excessive API calls.
 *
 * The user_list endpoint uses the same base URL as the chatbot API but
 * with method=user_list instead of method=chatbot.
 */
export async function fetchChatUsers(
  incomingUrl: string,
  allowInsecureSsl = false,
  log?: { warn: (...args: unknown[]) => void },
): Promise<ChatUser[]> {
  const now = Date.now();
  const listUrl = incomingUrl.replace(/method=\w+/, "method=user_list");
  const cached = chatUserCache.get(listUrl);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.users;
  }

  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(listUrl);
    } catch {
      log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
      resolve(cached?.users ?? []);
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const requestOptions: http.RequestOptions | https.RequestOptions =
      parsedUrl.protocol === "https:" ? { rejectUnauthorized: !allowInsecureSsl } : {};

    transport
      .get(listUrl, requestOptions, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString();
        });
        res.on("end", () => {
          const result = safeParseJsonWithSchema(ChatUserListResponseSchema, data);
          if (!result) {
            log?.warn("fetchChatUsers: failed to parse user_list response");
            resolve(cached?.users ?? []);
            return;
          }

          if (result.success) {
            const users = result.data?.users ?? [];
            chatUserCache.set(listUrl, {
              users,
              cachedAt: now,
            });
            resolve(users);
            return;
          }

          log?.warn(`fetchChatUsers: API returned success=${result.success}, using cached data`);
          resolve(cached?.users ?? []);
        });
      })
      .on("error", (err) => {
        log?.warn(`fetchChatUsers: HTTP error — ${err instanceof Error ? err.message : err}`);
        resolve(cached?.users ?? []);
      });
  });
}

async function assertSafeWebhookFileUrl(fileUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch (err) {
    throw new Error(`Invalid Synology Chat file URL: ${formatErrorMessage(err)}`, { cause: err });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Synology Chat file URL must use HTTP or HTTPS");
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname);
  return parsed.toString();
}

/**
 * Resolve a mutable webhook username/nickname to the correct Chat API user_id.
 *
 * Synology Chat outgoing webhooks send a user_id that may NOT match the
 * Chat-internal user_id needed by the chatbot API (method=chatbot).
 * The webhook's "username" field corresponds to the Chat user's "nickname".
 *
 * @returns The correct Chat user_id, or undefined if not found
 */
export async function resolveLegacyWebhookNameToChatUserId(params: {
  incomingUrl: string;
  mutableWebhookUsername: string;
  allowInsecureSsl?: boolean;
  log?: { warn: (...args: unknown[]) => void };
}): Promise<number | undefined> {
  const users = await fetchChatUsers(params.incomingUrl, params.allowInsecureSsl, params.log);
  const lower = normalizeLowercaseStringOrEmpty(params.mutableWebhookUsername);

  // Match by nickname first (webhook "username" field = Chat "nickname")
  const byNickname = users.find((u) => normalizeLowercaseStringOrEmpty(u.nickname) === lower);
  if (byNickname) {
    return byNickname.user_id;
  }

  // Then by username
  const byUsername = users.find((u) => normalizeLowercaseStringOrEmpty(u.username) === lower);
  if (byUsername) {
    return byUsername.user_id;
  }

  return undefined;
}

function buildWebhookBody(payload: ChatWebhookPayload, userId?: string | number): string {
  const numericId = parseNumericUserId(userId);
  if (numericId !== undefined) {
    payload.user_ids = [numericId];
  }
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function parseNumericUserId(userId?: string | number): number | undefined {
  if (userId === undefined) {
    return undefined;
  }
  const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
  return Number.isNaN(numericId) ? undefined : numericId;
}

function doPost(url: string, body: string, allowInsecureSsl = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
        // Synology NAS may use self-signed certs on local network.
        // Set allowInsecureSsl: true in channel config to skip verification.
        rejectUnauthorized: !allowInsecureSsl,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve(res.statusCode === 200);
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
