// Manual facade. Keep loader boundary explicit.
import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

type IrcAccountConfig = {
  name?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  password?: string;
  passwordFile?: string;
  channels?: string[];
  groups?: Record<string, unknown>;
};

type ResolvedIrcAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  password: string;
  passwordSource: "env" | "passwordFile" | "config" | "none";
  config: IrcAccountConfig;
};

type FacadeModule = {
  ircSetupAdapter: ChannelSetupAdapter;
  ircSetupWizard: ChannelSetupWizard;
  listIrcAccountIds: (cfg: OpenClawConfig) => string[];
  resolveDefaultIrcAccountId: (cfg: OpenClawConfig) => string;
  resolveIrcAccount: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ResolvedIrcAccount;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "irc",
    artifactBasename: "api.js",
  });
}
export const ircSetupAdapter: FacadeModule["ircSetupAdapter"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["ircSetupAdapter"] as object,
) as FacadeModule["ircSetupAdapter"];
export const ircSetupWizard: FacadeModule["ircSetupWizard"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["ircSetupWizard"] as object,
) as FacadeModule["ircSetupWizard"];
export const listIrcAccountIds: FacadeModule["listIrcAccountIds"] = ((...args) =>
  loadFacadeModule()["listIrcAccountIds"](...args)) as FacadeModule["listIrcAccountIds"];
export const resolveDefaultIrcAccountId: FacadeModule["resolveDefaultIrcAccountId"] = ((...args) =>
  loadFacadeModule()["resolveDefaultIrcAccountId"](
    ...args,
  )) as FacadeModule["resolveDefaultIrcAccountId"];
export const resolveIrcAccount: FacadeModule["resolveIrcAccount"] = ((...args) =>
  loadFacadeModule()["resolveIrcAccount"](...args)) as FacadeModule["resolveIrcAccount"];
