import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export function listMatrixAccountIds(_cfg: ClawdbotConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMatrixAccountId(cfg: ClawdbotConfig): string {
  const ids = listMatrixAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
