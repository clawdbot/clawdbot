import fs from "node:fs";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveOAuthDir } from "../config/paths.js";
import type { DmPolicy, GroupPolicy, WhatsAppAccountConfig } from "../config/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { hasWebCredsSync } from "./auth-store.js";

export type ResolvedWhatsAppAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  sendReadReceipts: boolean;
  messagePrefix?: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  selfChatMode?: boolean;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  dmPolicy?: DmPolicy;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  blockStreaming?: boolean;
  ackReaction?: WhatsAppAccountConfig["ackReaction"];
  groups?: WhatsAppAccountConfig["groups"];
  debounceMs?: number;
};

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = cfg.channels?.whatsapp?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWhatsAppAuthDirs(cfg: ClawdbotConfig): string[] {
  const oauthDir = resolveOAuthDir();
  const whatsappDir = path.join(oauthDir, "whatsapp");
  const authDirs = new Set<string>([oauthDir, path.join(whatsappDir, DEFAULT_ACCOUNT_ID)]);

  const accountIds = listConfiguredAccountIds(cfg);
  for (const accountId of accountIds) {
    authDirs.add(resolveWhatsAppAuthDir({ cfg, accountId }).authDir);
  }

  try {
    const entries = fs.readdirSync(whatsappDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      authDirs.add(path.join(whatsappDir, entry.name));
    }
  } catch {
    // ignore missing dirs
  }

  return Array.from(authDirs);
}

export function hasAnyWhatsAppAuth(cfg: ClawdbotConfig): boolean {
  return listWhatsAppAuthDirs(cfg).some((authDir) => hasWebCredsSync(authDir));
}

export function listWhatsAppAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWhatsAppAccountId(cfg: ClawdbotConfig): string {
  const ids = listWhatsAppAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): WhatsAppAccountConfig | undefined {
  const accounts = cfg.channels?.whatsapp?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const entry = accounts[accountId] as WhatsAppAccountConfig | undefined;
  return entry;
}

function resolveDefaultAuthDir(accountId: string): string {
  return path.join(resolveOAuthDir(), "whatsapp", accountId);
}

function resolveLegacyAuthDir(): string {
  // Legacy Baileys creds lived in the same directory as OAuth tokens.
  return resolveOAuthDir();
}

function legacyAuthExists(authDir: string): boolean {
  try {
    return fs.existsSync(path.join(authDir, "creds.json"));
  } catch {
    return false;
  }
}

export function resolveWhatsAppAuthDir(params: { cfg: ClawdbotConfig; accountId: string }): {
  authDir: string;
  isLegacy: boolean;
} {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveAccountConfig(params.cfg, accountId);
  const configured = account?.authDir?.trim();
  if (configured) {
    return { authDir: resolveUserPath(configured), isLegacy: false };
  }

  const defaultDir = resolveDefaultAuthDir(accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const legacyDir = resolveLegacyAuthDir();
    if (legacyAuthExists(legacyDir) && !legacyAuthExists(defaultDir)) {
      return { authDir: legacyDir, isLegacy: true };
    }
  }

  return { authDir: defaultDir, isLegacy: false };
}

export function resolveWhatsAppAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedWhatsAppAccount {
  const rootCfg = params.cfg.channels?.whatsapp;
  const accountId = params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
  const accountCfg = resolveAccountConfig(params.cfg, accountId);
  const enabled = accountCfg?.enabled !== false;
  const { authDir, isLegacy } = resolveWhatsAppAuthDir({
    cfg: params.cfg,
    accountId,
  });
  return {
    accountId,
    name: accountCfg?.name?.trim() || undefined,
    enabled,
    sendReadReceipts: accountCfg?.sendReadReceipts ?? rootCfg?.sendReadReceipts ?? true,
    messagePrefix:
      accountCfg?.messagePrefix ?? rootCfg?.messagePrefix ?? params.cfg.messages?.messagePrefix,
    authDir,
    isLegacyAuthDir: isLegacy,
    selfChatMode: accountCfg?.selfChatMode ?? rootCfg?.selfChatMode,
    dmPolicy: accountCfg?.dmPolicy ?? rootCfg?.dmPolicy,
    allowFrom: accountCfg?.allowFrom ?? rootCfg?.allowFrom,
    groupAllowFrom: accountCfg?.groupAllowFrom ?? rootCfg?.groupAllowFrom,
    groupPolicy: accountCfg?.groupPolicy ?? rootCfg?.groupPolicy,
    textChunkLimit: accountCfg?.textChunkLimit ?? rootCfg?.textChunkLimit,
    chunkMode: accountCfg?.chunkMode ?? rootCfg?.chunkMode,
    mediaMaxMb: accountCfg?.mediaMaxMb ?? rootCfg?.mediaMaxMb,
    blockStreaming: accountCfg?.blockStreaming ?? rootCfg?.blockStreaming,
    ackReaction: accountCfg?.ackReaction ?? rootCfg?.ackReaction,
    groups: accountCfg?.groups ?? rootCfg?.groups,
    debounceMs: accountCfg?.debounceMs ?? rootCfg?.debounceMs,
  };
}

export function listEnabledWhatsAppAccounts(cfg: ClawdbotConfig): ResolvedWhatsAppAccount[] {
  return listWhatsAppAccountIds(cfg)
    .map((accountId) => resolveWhatsAppAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
