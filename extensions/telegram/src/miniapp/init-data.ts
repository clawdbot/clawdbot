// Telegram Mini App init-data validation.
import crypto from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";

const INIT_DATA_MAX_AGE_MS = 300_000;

type TelegramMiniAppInitData = {
  hash: string;
  authDateMs: number;
  userId: string;
};

export function validateTelegramMiniAppInitData(params: {
  initData: string;
  botToken: string;
  nowMs?: number;
}): TelegramMiniAppInitData | null {
  const initData = params.initData.trim();
  const botToken = params.botToken.trim();
  if (!initData || !botToken) {
    return null;
  }

  const parsed = new URLSearchParams(initData);
  const receivedHash = parsed.get("hash")?.trim() ?? "";
  const authDateRaw = parsed.get("auth_date")?.trim() ?? "";
  const userRaw = parsed.get("user")?.trim() ?? "";
  if (!receivedHash || !authDateRaw || !userRaw) {
    return null;
  }

  const authDateSeconds = Number(authDateRaw);
  if (!Number.isInteger(authDateSeconds) || authDateSeconds <= 0) {
    return null;
  }
  const authDateMs = authDateSeconds * 1000;
  const ageMs = (params.nowMs ?? Date.now()) - authDateMs;
  if (ageMs < 0 || ageMs > INIT_DATA_MAX_AGE_MS) {
    return null;
  }

  const entries = [...parsed.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .toSorted();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secret).update(entries.join("\n")).digest("hex");
  if (!safeEqualSecret(computedHash, receivedHash)) {
    return null;
  }

  const user = parseTelegramMiniAppUser(userRaw);
  if (!user?.id || !/^\d+$/.test(user.id)) {
    return null;
  }
  return { hash: receivedHash, authDateMs, userId: user.id };
}

function parseTelegramMiniAppUser(raw: string): { id: string } | null {
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === "number" && Number.isSafeInteger(parsed.id) && parsed.id > 0) {
      return { id: String(parsed.id) };
    }
    return typeof parsed.id === "string" && /^\d+$/.test(parsed.id) ? { id: parsed.id } : null;
  } catch {
    return null;
  }
}
