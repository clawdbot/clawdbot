/**
 * Synology Chat HTTP client.
 * Sends messages TO Synology Chat via the incoming webhook URL.
 */

import * as http from "node:http";
import * as https from "node:https";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { readByteStreamWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  formatErrorMessage,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";

const MIN_SEND_INTERVAL_MS = 500;
/** user_list JSON can be larger than inbound webhook pre-auth payloads. */
const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
/** Wall-clock budget for user_list fetch including response body. */
const USER_LIST_REQUEST_TIMEOUT_MS = 15_000;
/** Wall-clock budget for outgoing webhook requests including response body. */
const POST_REQUEST_TIMEOUT_MS = 30_000;
let lastSendTime = 0;
let sendQueue: Promise<void> = Promise.resolve();

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

  // Retry with exponential backoff (3 attempts, 300ms base)
  const maxRetries = 3;
  const baseDelay = 300;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await waitForSendSlot();
      const ok = await doPost(incomingUrl, body, allowInsecureSsl);
      if (ok) {
        return true;
      }
    } catch {
      // will retry
    }

    if (attempt < maxRetries - 1) {
      await sleep(baseDelay * 2 ** attempt);
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

    await waitForSendSlot();
    const ok = await doPost(incomingUrl, body, allowInsecureSsl);
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
async function fetchChatUsers(
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
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const finish = (users: ChatUser[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearDeadline();
      resolve(users);
    };
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(listUrl);
    } catch {
      log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
      finish(cached?.users ?? []);
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const requestOptions: http.RequestOptions | https.RequestOptions =
      parsedUrl.protocol === "https:" ? { rejectUnauthorized: !allowInsecureSsl } : {};

    const req = transport
      .get(listUrl, requestOptions, (res) => {
        void (async () => {
          try {
            const data = await readByteStreamWithLimit(res, {
              maxBytes: USER_LIST_RESPONSE_MAX_BYTES,
              onOverflow: ({ maxBytes }) =>
                new Error(`user_list response exceeded ${maxBytes} bytes`),
            });
            if (settled) {
              return;
            }
            const result = safeParseJsonWithSchema(
              ChatUserListResponseSchema,
              data.toString("utf8"),
            );
            if (!result) {
              log?.warn("fetchChatUsers: failed to parse user_list response");
              finish(cached?.users ?? []);
              return;
            }

            if (result.success) {
              const users = result.data?.users ?? [];
              chatUserCache.set(listUrl, {
                users,
                cachedAt: now,
              });
              finish(users);
              return;
            }

            log?.warn(`fetchChatUsers: API returned success=${result.success}, using cached data`);
            finish(cached?.users ?? []);
          } catch (err) {
            if (settled) {
              return;
            }
            log?.warn(`fetchChatUsers: ${formatErrorMessage(err)}, using cached data`);
            finish(cached?.users ?? []);
          }
        })();
      })
      .on("error", (err) => {
        if (settled) {
          return;
        }
        log?.warn(`fetchChatUsers: HTTP error — ${err instanceof Error ? err.message : err}`);
        finish(cached?.users ?? []);
      });
    // Use a wall-clock deadline, not ClientRequest.setTimeout. Node's socket
    // idle timer resets on every data chunk, so a slow drip can hang user_list
    // past the intended budget while body reads have no separate idle bound.
    deadlineTimer = setTimeout(() => {
      log?.warn("fetchChatUsers: request timed out, using cached data");
      req.destroy?.();
      finish(cached?.users ?? []);
    }, USER_LIST_REQUEST_TIMEOUT_MS);
    deadlineTimer.unref?.();
  });
}

async function waitForSendSlot(): Promise<void> {
  const next = sendQueue.then(async () => {
    const elapsed = Date.now() - lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - elapsed);
    }
    lastSendTime = Date.now();
  });
  sendQueue = next.catch(() => {});
  await next;
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
  if (typeof userId === "number") {
    return Number.isSafeInteger(userId) ? userId : undefined;
  }
  return parseStrictNonNegativeInteger(userId);
}

function doPost(url: string, body: string, allowInsecureSsl = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok?: boolean; error?: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (result.error) {
        reject(result.error);
        return;
      }
      resolve(result.ok === true);
    };
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
        // Synology NAS may use self-signed certs on local network.
        // Set allowInsecureSsl: true in channel config to skip verification.
        rejectUnauthorized: !allowInsecureSsl,
      },
      (res) => {
        response = res;
        res.on("end", () => {
          finish({ ok: res.statusCode === 200 });
        });
        res.on("error", (error) => finish({ error }));
        res.resume();
      },
    );

    req.on("error", (error) => finish({ error }));
    // ClientRequest timeout is socket-idle based. Keep one absolute budget
    // across connect, upload, and response drain so trickling bodies terminate.
    deadlineTimer = setTimeout(() => {
      const error = new Error("Request timeout");
      finish({ error });
      response?.destroy();
      req.destroy();
    }, POST_REQUEST_TIMEOUT_MS);
    deadlineTimer.unref?.();
    req.write(body);
    req.end();
  });
}
