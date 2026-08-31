import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../accounts.js";
import { resolveDiscordProxyFetchForAccount } from "../proxy-fetch.js";
import { selectDiscordActivitiesRuntimeConfig } from "../runtime-config.js";
import { resolveDiscordActivitiesConfig } from "./config.js";
import type { DiscordActivityStore } from "./store.js";

type ResolvedDiscordActivityAccount = {
  accountId: string;
  applicationId: string;
  botAuth: string;
  clientSecret: string;
  proxyFetch?: typeof fetch;
};

export class DiscordActivitiesRuntime {
  private readonly learnedApplicationIds = new Map<string, string>();

  constructor(
    readonly store: DiscordActivityStore,
    private readonly startupConfig: OpenClawConfig,
    private readonly getCurrentConfig?: () => OpenClawConfig | undefined,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  currentConfig(): OpenClawConfig {
    return selectDiscordActivitiesRuntimeConfig(this.getCurrentConfig?.() ?? this.startupConfig);
  }

  registerApplicationId(accountId: string, applicationId: string): void {
    const trimmed = applicationId.trim();
    if (trimmed) {
      this.learnedApplicationIds.set(accountId, trimmed);
    }
  }

  resolveAccount(
    accountId: string,
    cfg = this.currentConfig(),
  ): ResolvedDiscordActivityAccount | null {
    const account = resolveDiscordAccount({ cfg, accountId });
    if (
      !listDiscordAccountIds(cfg).includes(account.accountId) ||
      !isDiscordAccountEnabledForRuntime(account, cfg) ||
      account.tokenStatus !== "available"
    ) {
      return null;
    }
    const activities = resolveDiscordActivitiesConfig(account.config, this.env);
    if (!activities.enabled) {
      return null;
    }
    const applicationId =
      activities.applicationId ??
      this.learnedApplicationIds.get(account.accountId) ??
      account.config.applicationId?.trim();
    if (!applicationId) {
      return null;
    }
    const { clientSecret } = activities;
    const bot = account.token.trim();
    return {
      accountId: account.accountId,
      applicationId,
      botAuth: bot,
      clientSecret,
      proxyFetch: resolveDiscordProxyFetchForAccount(account, cfg),
    };
  }

  resolveHttpAccount(applicationId?: string): ResolvedDiscordActivityAccount | null {
    const cfg = this.currentConfig();
    const accounts = listDiscordAccountIds(cfg)
      .map((accountId) => this.resolveAccount(accountId, cfg))
      .filter((account): account is ResolvedDiscordActivityAccount => account !== null);
    if (applicationId) {
      return accounts.find((account) => account.applicationId === applicationId) ?? null;
    }
    return accounts.length === 1 ? (accounts[0] ?? null) : null;
  }

  hasEnabledAccounts(cfg = this.currentConfig()): boolean {
    return listDiscordAccountIds(cfg).some(
      (accountId) => this.resolveAccount(accountId, cfg) !== null,
    );
  }

  isAccountEnabled(accountId: string, cfg = this.currentConfig()): boolean {
    return this.resolveAccount(accountId, cfg) !== null;
  }
}

let activeRuntime: DiscordActivitiesRuntime | undefined;

export function setDiscordActivitiesRuntime(runtime: DiscordActivitiesRuntime | undefined): void {
  activeRuntime = runtime;
}

export function getDiscordActivitiesRuntime(): DiscordActivitiesRuntime | undefined {
  return activeRuntime;
}
