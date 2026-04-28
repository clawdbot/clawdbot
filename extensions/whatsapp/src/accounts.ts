import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveUserPath,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { DmPolicy, GroupPolicy, ReplyToMode } from "openclaw/plugin-sdk/config-types";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";
import {
  listConfiguredAccountIds,
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
} from "./account-ids.js";
import type { WhatsAppAccountConfig } from "./account-types.js";
import { hasWebCredsSync } from "./creds-files.js";

export { listWhatsAppAccountIds, resolveDefaultWhatsAppAccountId } from "./account-ids.js";

export type ResolvedWhatsAppAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  sendReadReceipts: boolean;
  messagePrefix?: string;
  defaultTo?: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  selfChatMode?: boolean;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  dmPolicy?: DmPolicy;
  historyLimit?: number;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  blockStreaming?: boolean;
  ackReaction?: WhatsAppAccountConfig["ackReaction"];
  reactionLevel?: WhatsAppAccountConfig["reactionLevel"];
  groups?: WhatsAppAccountConfig["groups"];
  direct?: WhatsAppAccountConfig["direct"];
  debounceMs?: number;
  replyToMode?: ReplyToMode;
};

export const DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50;

export function listWhatsAppAuthDirs(cfg: OpenClawConfig): string[] {
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
      if (!entry.isDirectory()) {
        continue;
      }
      authDirs.add(path.join(whatsappDir, entry.name));
    }
  } catch {
    // ignore missing dirs
  }

  return Array.from(authDirs);
}

export function hasAnyWhatsAppAuth(cfg: OpenClawConfig): boolean {
  return listWhatsAppAuthDirs(cfg).some((authDir) => hasWebCredsSync(authDir));
}

function resolveDefaultAuthDir(accountId: string): string {
  return path.join(resolveOAuthDir(), "whatsapp", normalizeAccountId(accountId));
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

export function resolveWhatsAppAuthDir(params: { cfg: OpenClawConfig; accountId: string }): {
  authDir: string;
  isLegacy: boolean;
} {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveMergedWhatsAppAccountConfig({ cfg: params.cfg, accountId });
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
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWhatsAppAccount {
  const merged = resolveMergedWhatsAppAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg),
  });
  const accountId = merged.accountId;
  const enabled = merged.enabled !== false;
  const { authDir, isLegacy } = resolveWhatsAppAuthDir({
    cfg: params.cfg,
    accountId,
  });
  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    sendReadReceipts: merged.sendReadReceipts ?? true,
    messagePrefix: merged.messagePrefix ?? params.cfg.messages?.messagePrefix,
    defaultTo: merged.defaultTo,
    authDir,
    isLegacyAuthDir: isLegacy,
    selfChatMode: merged.selfChatMode,
    dmPolicy: merged.dmPolicy,
    allowFrom: merged.allowFrom,
    groupAllowFrom: merged.groupAllowFrom,
    groupPolicy: merged.groupPolicy,
    historyLimit: merged.historyLimit,
    textChunkLimit: merged.textChunkLimit,
    chunkMode: merged.chunkMode,
    mediaMaxMb: merged.mediaMaxMb,
    blockStreaming: merged.blockStreaming,
    ackReaction: merged.ackReaction,
    reactionLevel: merged.reactionLevel,
    groups: merged.groups,
    direct: merged.direct,
    debounceMs: merged.debounceMs,
    replyToMode: merged.replyToMode,
  };
}

export function resolveWhatsAppMediaMaxBytes(
  account: Pick<ResolvedWhatsAppAccount, "mediaMaxMb">,
): number {
  const mediaMaxMb =
    typeof account.mediaMaxMb === "number" && account.mediaMaxMb > 0
      ? account.mediaMaxMb
      : DEFAULT_WHATSAPP_MEDIA_MAX_MB;
  return mediaMaxMb * 1024 * 1024;
}

export function listEnabledWhatsAppAccounts(cfg: OpenClawConfig): ResolvedWhatsAppAccount[] {
  return listWhatsAppAccountIds(cfg)
    .map((accountId) => resolveWhatsAppAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
