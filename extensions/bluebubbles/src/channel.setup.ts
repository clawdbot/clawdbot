import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { type ResolvedBlueBubblesAccount } from "./accounts.js";
import {
  bluebubblesCapabilities,
  bluebubblesConfigAdapter,
  bluebubblesConfigSchema,
  bluebubblesMeta,
  bluebubblesReload,
  describeBlueBubblesAccount,
} from "./channel-shared.js";
import { blueBubblesSetupAdapter } from "./setup-core.js";
import { blueBubblesSetupWizard } from "./setup-surface.js";

export const bluebubblesSetupPlugin: ChannelPlugin<ResolvedBlueBubblesAccount> = {
  id: "bluebubbles",
  meta: {
    ...bluebubblesMeta,
    aliases: [...bluebubblesMeta.aliases],
    preferOver: [...bluebubblesMeta.preferOver],
  },
  capabilities: bluebubblesCapabilities,
  reload: bluebubblesReload,
  configSchema: bluebubblesConfigSchema,
  setupWizard: blueBubblesSetupWizard,
  config: {
    ...bluebubblesConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => describeBlueBubblesAccount(account),
  },
  setup: blueBubblesSetupAdapter,
};
