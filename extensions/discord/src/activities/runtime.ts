import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../accounts.js";
import { resolveDiscordProxyFetchForAccount } from "../proxy-fetch.js";
import { resolveDiscordActivitiesConfig } from "./config.js";
import type { DiscordActivityStore } from "./store.js";

type ResolvedDiscordActivityAccount = {
  accountId: string;
  applicationId: string;
  botAuth: string;
  clientSecret: string;
  config: ReturnType<typeof resolveDiscordAccount>["config"];
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
    return this.getCurrentConfig?.() ?? this.startupConfig;
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
    if (!isDiscordAccountEnabledForRuntime(account, cfg)) {
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
      config: account.config,
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

  isAccountEnabled(accountId: string, cfg = this.currentConfig()): boolean {
    const account = resolveDiscordAccount({ cfg, accountId });
    return (
      isDiscordAccountEnabledForRuntime(account, cfg) &&
      resolveDiscordActivitiesConfig(account.config, this.env).enabled
    );
  }
}

let activeRuntime: DiscordActivitiesRuntime | undefined;

export function setDiscordActivitiesRuntime(runtime: DiscordActivitiesRuntime | undefined): void {
  activeRuntime = runtime;
}

export function getDiscordActivitiesRuntime(): DiscordActivitiesRuntime | undefined {
  return activeRuntime;
}
