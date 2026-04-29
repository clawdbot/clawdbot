import type { OpenClawConfig } from "./config-types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

/**
 * @deprecated Compatibility type for the `openclaw/plugin-sdk/telegram-account` facade.
 * New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
 */
export type TelegramAccountConfig = NonNullable<
  NonNullable<OpenClawConfig["channels"]>["telegram"]
>;

/**
 * @deprecated Compatibility type for the `openclaw/plugin-sdk/telegram-account` facade.
 * New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
 */
export type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
};

type TelegramAccountFacadeModule = {
  resolveTelegramAccount: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ResolvedTelegramAccount;
};

function loadTelegramAccountFacadeModule(): TelegramAccountFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<TelegramAccountFacadeModule>({
    dirName: "telegram",
    artifactBasename: "api.js",
  });
}

/**
 * @deprecated Compatibility facade for plugin code that needs Telegram account resolution.
 * New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
 */
export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  return loadTelegramAccountFacadeModule().resolveTelegramAccount(params);
}
