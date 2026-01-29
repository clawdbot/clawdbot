import fs from "node:fs";
import path from "node:path";

import { normalizeAccountId } from "clawdbot/plugin-sdk";
import { getTelegramUserRuntime } from "./runtime.js";

export function resolveTelegramUserSessionPath(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  const stateDir = getTelegramUserRuntime().state.resolveStateDir();
  return path.join(stateDir, "telegram-user", `session-${normalized}.sqlite`);
}

export function ensureTelegramUserSessionDir(params?: {
  accountId?: string | null;
  sessionPath?: string;
}): void {
  const sessionPath =
    params?.sessionPath ?? resolveTelegramUserSessionPath(params?.accountId);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
}
