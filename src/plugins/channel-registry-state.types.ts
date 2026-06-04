/** Runtime shape needed to expose an active plugin channel registration. */
export type ActiveChannelPluginRuntimeShape = {
  id?: string | null;
  meta?: {
    aliases?: readonly string[];
    markdownCapable?: boolean;
    order?: number;
  } | null;
  messaging?: {
    targetPrefixes?: readonly string[];
  } | null;
  capabilities?: {
    nativeCommands?: boolean;
  } | null;
  conversationBindings?: {
    supportsCurrentConversationBinding?: boolean;
  } | null;
};

/** Active channel registration with owning plugin metadata. */
export type ActivePluginChannelRegistration = {
  plugin: ActiveChannelPluginRuntimeShape;
  pluginId?: string | null;
  origin?: string | null;
};

/** Active runtime channel registry snapshot. */
export type ActivePluginChannelRegistry = {
  channels: ActivePluginChannelRegistration[];
};
