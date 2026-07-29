// Mattermost plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "./channel-api.js";
import {
  describeMattermostAccount,
  isMattermostConfigured,
  mattermostConfigAdapter,
  mattermostMeta,
  resolveMattermostGatewayAuthBypassPaths,
} from "./channel-config-shared.js";
import { MattermostChannelConfigSchema } from "./config-surface.js";
import type { ResolvedMattermostAccount } from "./mattermost/accounts.js";
import { mattermostSetupAdapter, mattermostSetupContract } from "./setup-core.js";
import { mattermostSetupWizard } from "./setup-surface.js";

export const mattermostSetupPlugin: ChannelPlugin<ResolvedMattermostAccount> = {
  id: "mattermost",
  meta: {
    ...mattermostMeta,
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  reload: {
    configPrefixes: ["channels.mattermost"],
    /**
     * accounts.default is promoted; named resolution merges only channel-wide fields
     * plus the selected account. Runtime monitor, debounce, and ingress use accountId.
     */
    accountScopedRestart: true,
  },
  configSchema: MattermostChannelConfigSchema,
  config: {
    ...mattermostConfigAdapter,
    isConfigured: isMattermostConfigured,
    describeAccount: describeMattermostAccount,
  },
  gateway: {
    resolveGatewayAuthBypassPaths: resolveMattermostGatewayAuthBypassPaths,
  },
  setup: mattermostSetupAdapter,
  setupContract: mattermostSetupContract,
  setupWizard: mattermostSetupWizard,
};
