/**
 * Public SDK facade for core channel plugin construction helpers.
 */
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

/** Creates a channel plugin base while keeping the public import on this SDK subpath. */
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
