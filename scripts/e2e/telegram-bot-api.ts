type JsonObject = Record<string, unknown>;

type TelegramBotApiOptions = {
  baseUrl?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL =
  process.env.OPENCLAW_TELEGRAM_USER_BOT_API_BASE_URL ?? "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_TELEGRAM_USER_BOT_API_TIMEOUT_MS,
  30000,
);

function readPositiveInt(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(source: JsonObject, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function telegramBotApi(
  token: string,
  method: string,
  body: JsonObject = {},
  options: TelegramBotApiOptions = {},
) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutError = Object.assign(
    new Error(`Telegram Bot API ${method} timed out after ${timeoutMs}ms`),
    { code: "ETIMEDOUT" },
  );
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
    const payload = (await Promise.race([response.json(), timeoutPromise])) as JsonObject;
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
