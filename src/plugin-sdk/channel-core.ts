export type {
  ChannelConfigUiHint,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginCommandContext,
  PluginRuntime,
  ChannelOutboundSessionRouteParams,
} from "./core.js";

import { createChannelPluginBase as createChannelPluginBaseFromCore } from "./core.js";

export const createChannelPluginBase: typeof createChannelPluginBaseFromCore = (params) =>
  createChannelPluginBaseFromCore(params);

export {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  clearAccountEntryFields,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  defineSetupPluginEntry,
  parseOptionalDelimitedEntries,
  recoverCurrentThreadSessionId,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  tryReadSecretFileSync,
} from "./core.js";
