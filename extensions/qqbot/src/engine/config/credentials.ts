/**
 * QQBot credential management (pure logic layer).
 * QQBot 凭证管理（纯逻辑层）。
 *
 * Credential clearing and field-level cleanup for logout and setup
 * flows. All functions operate on plain objects (Record<string, unknown>)
 * and stay framework-agnostic.
 */

import { asOptionalObjectRecord as asRecord } from "../utils/string-normalize.js";
import { DEFAULT_ACCOUNT_ID } from "./resolve.js";

// ---- Logout: clear all credential fields for an account ----

interface ClearCredentialsResult {
  nextCfg: Record<string, unknown>;
  cleared: boolean;
  changed: boolean;
}

/**
 * Remove clientSecret / clientSecretFile from a QQBot account config.
 *
 * Returns a shallow-cloned config with credentials removed, plus flags
 * indicating whether anything actually changed.
 */
export function clearAccountCredentials(
  cfg: Record<string, unknown>,
  accountId: string,
): ClearCredentialsResult {
  const nextCfg = { ...cfg };
  const channels = asRecord(cfg.channels);
  const nextQQBot = channels?.qqbot ? { ...asRecord(channels.qqbot) } : undefined;
  let cleared = false;
  let changed = false;

  if (nextQQBot) {
    const qqbot = nextQQBot as Record<string, unknown>;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      if (qqbot.clientSecret) {
        delete qqbot.clientSecret;
        cleared = true;
        changed = true;
      }
      if (qqbot.clientSecretFile) {
        delete qqbot.clientSecretFile;
        cleared = true;
        changed = true;
      }
    }
    const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts && accountId in accounts) {
      const entry = accounts[accountId] as Record<string, unknown> | undefined;
      if (entry && "clientSecret" in entry) {
        delete entry.clientSecret;
        cleared = true;
        changed = true;
      }
      if (entry && "clientSecretFile" in entry) {
        delete entry.clientSecretFile;
        cleared = true;
        changed = true;
      }
      if (entry && Object.keys(entry).length === 0) {
        delete accounts[accountId];
        changed = true;
      }
    }
  }

  if (changed && nextQQBot) {
    nextCfg.channels = { ...channels, qqbot: nextQQBot };
  }

  return { nextCfg, cleared, changed };
}
