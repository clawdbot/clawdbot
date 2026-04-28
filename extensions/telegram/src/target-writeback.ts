import {
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  loadCronStore,
  resolveCronStorePath,
  saveCronStore,
} from "openclaw/plugin-sdk/cron-store-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
} from "./targets.js";

const writebackLogger = createSubsystemLogger("telegram/target-writeback");
const TELEGRAM_ADMIN_SCOPE = "operator.admin";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTelegramLookupTargetForMatch(raw: string): string | undefined {
  const normalized = normalizeTelegramLookupTarget(raw);
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith("@") ? normalizeLowercaseStringOrEmpty(normalized) : normalized;
}

function normalizeTelegramTargetForMatch(raw: string): string | undefined {
  const parsed = parseTelegramTarget(raw);
  const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
  if (!normalized) {
    return undefined;
  }
  const threadKey = parsed.messageThreadId == null ? "" : String(parsed.messageThreadId);
  return `${normalized}|${threadKey}`;
}

function buildResolvedTelegramTarget(params: {
  raw: string;
  parsed: ReturnType<typeof parseTelegramTarget>;
  resolvedChatId: string;
}): string {
  const { raw, parsed, resolvedChatId } = params;
  if (parsed.messageThreadId == null) {
    return resolvedChatId;
  }
  return raw.includes(":topic:")
    ? `${resolvedChatId}:topic:${parsed.messageThreadId}`
    : `${resolvedChatId}:${parsed.messageThreadId}`;
}

function resolveLegacyRewrite(params: {
  raw: string;
  resolvedChatId: string;
}): { matchKey: string; resolvedTarget: string } | null {
  const parsed = parseTelegramTarget(params.raw);
  if (normalizeTelegramChatId(parsed.chatId)) {
    return null;
  }
  const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
  if (!normalized) {
    return null;
  }
  const threadKey = parsed.messageThreadId == null ? "" : String(parsed.messageThreadId);
  return {
    matchKey: `${normalized}|${threadKey}`,
    resolvedTarget: buildResolvedTelegramTarget({
      raw: params.raw,
      parsed,
      resolvedChatId: params.resolvedChatId,
    }),
  };
}

function rewriteTargetIfMatch(params: {
  rawValue: unknown;
  matchKey: string;
  resolvedTarget: string;
}): string | null {
  if (typeof params.rawValue !== "string" && typeof params.rawValue !== "number") {
    return null;
  }
  const value = normalizeOptionalString(String(params.rawValue)) ?? "";
  if (!value) {
    return null;
  }
  if (normalizeTelegramTargetForMatch(value) !== params.matchKey) {
    return null;
  }
  return params.resolvedTarget;
}

function replaceTelegramDefaultToTargets(params: {
  cfg: OpenClawConfig;
  matchKey: string;
  resolvedTarget: string;
}): boolean {
  let changed = false;
  const telegram = asObjectRecord(params.cfg.channels?.telegram);
  if (!telegram) {
    return changed;
  }

  const maybeReplace = (holder: Record<string, unknown>, key: string) => {
    const nextTarget = rewriteTargetIfMatch({
      rawValue: holder[key],
      matchKey: params.matchKey,
      resolvedTarget: params.resolvedTarget,
    });
    if (!nextTarget) {
      return;
    }
    holder[key] = nextTarget;
    changed = true;
  };

  maybeReplace(telegram, "defaultTo");
  const accounts = asObjectRecord(telegram.accounts);
  if (!accounts) {
    return changed;
  }
  for (const accountId of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[accountId]);
    if (!account) {
      continue;
    }
    maybeReplace(account, "defaultTo");
  }
  return changed;
}

export async function maybePersistResolvedTelegramTarget(params: {
  cfg: OpenClawConfig;
  rawTarget: string;
  resolvedChatId: string;
  verbose?: boolean;
  gatewayClientScopes?: readonly string[];
}): Promise<void> {
  const raw = params.rawTarget.trim();
  if (!raw) {
    return;
  }
  const rewrite = resolveLegacyRewrite({
    raw,
    resolvedChatId: params.resolvedChatId,
  });
  if (!rewrite) {
    return;
  }
  const { matchKey, resolvedTarget } = rewrite;
  if (
    Array.isArray(params.gatewayClientScopes) &&
    !params.gatewayClientScopes.includes(TELEGRAM_ADMIN_SCOPE)
  ) {
    writebackLogger.warn(
      `skipping Telegram target writeback for ${raw} because gateway caller is missing ${TELEGRAM_ADMIN_SCOPE}`,
    );
    return;
  }

  try {
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    const nextConfig = structuredClone(snapshot.config ?? {});
    const configChanged = replaceTelegramDefaultToTargets({
      cfg: nextConfig,
      matchKey,
      resolvedTarget,
    });
    if (configChanged) {
      await replaceConfigFile({
        nextConfig,
        snapshot,
        writeOptions,
        afterWrite: { mode: "auto" },
      });
      if (params.verbose) {
        writebackLogger.warn(`resolved Telegram defaultTo target ${raw} -> ${resolvedTarget}`);
      }
    }
  } catch (err) {
    if (params.verbose) {
      writebackLogger.warn(`failed to persist Telegram defaultTo target ${raw}: ${String(err)}`);
    }
  }

  try {
    const storePath = resolveCronStorePath(params.cfg.cron?.store);
    const store = await loadCronStore(storePath);
    let cronChanged = false;
    for (const job of store.jobs) {
      if (job.delivery?.channel !== "telegram") {
        continue;
      }
      const nextTarget = rewriteTargetIfMatch({
        rawValue: job.delivery.to,
        matchKey,
        resolvedTarget,
      });
      if (!nextTarget) {
        continue;
      }
      job.delivery.to = nextTarget;
      cronChanged = true;
    }
    if (cronChanged) {
      await saveCronStore(storePath, store);
      if (params.verbose) {
        writebackLogger.warn(`resolved Telegram cron delivery target ${raw} -> ${resolvedTarget}`);
      }
    }
  } catch (err) {
    if (params.verbose) {
      writebackLogger.warn(`failed to persist Telegram cron target ${raw}: ${String(err)}`);
    }
  }
}
