import type { MoltbotConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

/**
 * Shared account resolution utilities for channels that follow the standard
 * accounts pattern: cfg.channels.<channelKey>.accounts with base+account merging.
 *
 * Channels with unique resolution logic (Telegram agent-bindings, WhatsApp auth
 * directories, LINE custom listing) should not use this factory.
 */
export function createAccountBase<TAccountConfig extends Record<string, unknown>>(
  channelKey: string,
) {
  type ChannelSection = { enabled?: boolean; accounts?: Record<string, unknown> } & Record<
    string,
    unknown
  >;

  function getChannelSection(cfg: MoltbotConfig): ChannelSection | undefined {
    return (cfg.channels as Record<string, unknown> | undefined)?.[channelKey] as
      | ChannelSection
      | undefined;
  }

  function listConfiguredAccountIds(cfg: MoltbotConfig): string[] {
    const accounts = getChannelSection(cfg)?.accounts;
    if (!accounts || typeof accounts !== "object") return [];
    return Object.keys(accounts).filter(Boolean);
  }

  function listAccountIds(cfg: MoltbotConfig): string[] {
    const ids = listConfiguredAccountIds(cfg);
    if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
    return ids.sort((a, b) => a.localeCompare(b));
  }

  function resolveDefaultAccountId(cfg: MoltbotConfig): string {
    const ids = listAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
  }

  function resolveAccountConfig(cfg: MoltbotConfig, accountId: string): TAccountConfig | undefined {
    const accounts = getChannelSection(cfg)?.accounts;
    if (!accounts || typeof accounts !== "object") return undefined;
    return accounts[accountId] as TAccountConfig | undefined;
  }

  function mergeAccountConfig(cfg: MoltbotConfig, accountId: string): TAccountConfig {
    const { accounts: _ignored, ...base } = (getChannelSection(cfg) ?? {}) as TAccountConfig & {
      accounts?: unknown;
    };
    const account = resolveAccountConfig(cfg, accountId) ?? {};
    return { ...base, ...account } as TAccountConfig;
  }

  function isBaseEnabled(cfg: MoltbotConfig): boolean {
    return getChannelSection(cfg)?.enabled !== false;
  }

  function listEnabledAccounts<TResolved extends { enabled: boolean }>(
    cfg: MoltbotConfig,
    resolve: (params: { cfg: MoltbotConfig; accountId?: string | null }) => TResolved,
  ): TResolved[] {
    return listAccountIds(cfg)
      .map((accountId) => resolve({ cfg, accountId }))
      .filter((account) => account.enabled);
  }

  return {
    listConfiguredAccountIds,
    listAccountIds,
    resolveDefaultAccountId,
    resolveAccountConfig,
    mergeAccountConfig,
    isBaseEnabled,
    listEnabledAccounts,
    normalizeAccountId,
  };
}
