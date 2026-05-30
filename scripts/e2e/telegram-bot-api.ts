import { readBoundedResponseText } from "../lib/bounded-response.ts";

type JsonObject = Record<string, unknown>;

type TelegramBotApiOptions = {
  baseUrl?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL =
  process.env.OPENCLAW_TELEGRAM_USER_BOT_API_BASE_URL ?? "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_TELEGRAM_USER_BOT_API_TIMEOUT_MS,
  30000,
);
const DEFAULT_BODY_MAX_BYTES = readPositiveInt(
  process.env.OPENCLAW_TELEGRAM_USER_BOT_API_BODY_MAX_BYTES,
  1024 * 1024,
);

function readPositiveInt(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_BODY_MAX_BYTES);
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
