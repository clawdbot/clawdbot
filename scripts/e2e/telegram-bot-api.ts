// Telegram Bot Api script supports OpenClaw repository automation.
import { readBoundedResponseText } from "../lib/bounded-response.ts";
import { readPositiveIntEnv } from "./lib/env-limits.mjs";

type JsonObject = Record<string, unknown>;

type TelegramBotApiOptions = {
  baseUrl?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL =
  process.env.OPENCLAW_TELEGRAM_USER_BOT_API_BASE_URL ?? "https://api.telegram.org";
type TelegramBotApiLimits = {
  bodyMaxBytes: number;
  timeoutMs: number;
};

export function readTelegramBotApiLimits(
  env: NodeJS.ProcessEnv = process.env,
): TelegramBotApiLimits {
  return {
    bodyMaxBytes: readPositiveIntEnv(
      "OPENCLAW_TELEGRAM_USER_BOT_API_BODY_MAX_BYTES",
      1024 * 1024,
      env,
    ),
    timeoutMs: readPositiveIntEnv("OPENCLAW_TELEGRAM_USER_BOT_API_TIMEOUT_MS", 30000, env),
  };
}

const DEFAULT_LIMITS = readTelegramBotApiLimits();

function optionalString(source: JsonObject, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taggedError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function parseJsonPayload(rawPayload: string, label: string) {
  try {
    return JSON.parse(rawPayload) as JsonObject;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

export async function telegramBotApi(
  token: string,
  method: string,
  body: JsonObject = {},
  options: TelegramBotApiOptions = {},
) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_LIMITS.bodyMaxBytes);
  const label = `Telegram Bot API ${method}`;
  const timeoutError = taggedError(`${label} timed out after ${timeoutMs}ms`, "ETIMEDOUT");
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    const rawPayload = await readBoundedResponseText(response, label, maxBodyBytes, {
      createTooLargeError(message) {
        return taggedError(message, "ETOOBIG");
      },
      timeoutPromise,
    });
    const payload = parseJsonPayload(rawPayload, label);
    if (!response.ok || payload.ok !== true) {
      throw new Error(
        optionalString(payload, "description") ?? `${method} failed with HTTP ${response.status}`,
      );
    }
    return payload.result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
