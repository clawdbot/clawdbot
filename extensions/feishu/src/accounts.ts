
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { FeishuConfig, FeishuAccount } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

export function resolveFeishuAccount(params: {
    cfg: ClawdbotConfig;
    accountId?: string;
}): FeishuAccount {
    const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;

    // Type assertion to access channel specific config
    // In a real plugin structure, config is typed, but here we access structure dynamically
    const feishuCfg = (cfg.channels as any)?.feishu;

    // Config can be at root of feishu block (default) or in accounts map
    const defaults = feishuCfg;
    const account = feishuCfg?.accounts?.[accountId];

    return {
        accountId,
        name: account?.name ?? accountId,
        enabled: account?.enabled ?? defaults?.enabled ?? true,
        // Merge defaults with account specific overrides
        config: {
            appId: account?.appId ?? defaults?.appId,
            appSecret: account?.appSecret ?? defaults?.appSecret,
            encryptKey: account?.encryptKey ?? defaults?.encryptKey,
            verificationToken: account?.verificationToken ?? defaults?.verificationToken,
        } as FeishuConfig,
    };
}

export function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
    const feishuCfg = (cfg.channels as any)?.feishu;
    if (!feishuCfg) return [];

    const ids = new Set<string>();

    // If base fields exist, "default" is an account
    if (feishuCfg.appId) {
        ids.add(DEFAULT_ACCOUNT_ID);
    }

    // Add explicit accounts
    if (feishuCfg.accounts) {
        Object.keys(feishuCfg.accounts).forEach(id => ids.add(id));
    }

    return Array.from(ids);
}

export function isFeishuConfigured(account: FeishuAccount): boolean {
    return Boolean(account.config.appId && account.config.appSecret);
}
