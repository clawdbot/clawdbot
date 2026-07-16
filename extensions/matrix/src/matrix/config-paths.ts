import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig } from "../types.js";

export function shouldStoreMatrixAccountAtTopLevel(cfg: CoreConfig, accountId: string): boolean {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (normalizedAccountId !== DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const accounts = cfg.channels?.matrix?.accounts;
  return !accounts || Object.keys(accounts).length === 0;
}

export function resolveMatrixConfigPath(cfg: CoreConfig, accountId: string): string {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (shouldStoreMatrixAccountAtTopLevel(cfg, normalizedAccountId)) {
    return "channels.matrix";
  }
  return `channels.matrix.accounts.${normalizedAccountId}`;
}

export function resolveMatrixConfigFieldPath(
  cfg: CoreConfig,
  accountId: string,
  fieldPath: string,
): string {
  const suffix = fieldPath.trim().replace(/^\.+/, "");
  if (!suffix) {
    return resolveMatrixConfigPath(cfg, accountId);
  }
  return `${resolveMatrixConfigPath(cfg, accountId)}.${suffix}`;
}
