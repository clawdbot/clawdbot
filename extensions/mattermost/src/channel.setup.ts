import type { ChannelPlugin } from "./channel-api.js";
import {
  describeMattermostAccount,
  isMattermostConfigured,
  mattermostConfigAdapter,
  mattermostMeta,
  resolveMattermostGatewayAuthBypassPaths,
} from "./channel-config-shared.js";
import { MattermostChannelConfigSchema } from "./config-surface.js";
import { type ResolvedMattermostAccount } from "./mattermost/accounts.js";
import { mattermostSetupAdapter } from "./setup-core.js";
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
  reload: { configPrefixes: ["channels.mattermost"] },
  configSchema: MattermostChannelConfigSchema,
  config: {
    ...mattermostConfigAdapter,
    isConfigured: isMattermostConfigured,
    describeAccount: describeMattermostAccount,
  },
  gateway: {
    resolveGatewayAuthBypassPaths: ({ cfg }) => resolveMattermostGatewayAuthBypassPaths(cfg),
  },
  setup: mattermostSetupAdapter,
  setupWizard: mattermostSetupWizard,
};
