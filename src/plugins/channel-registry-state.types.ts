export type ActiveChannelPluginRuntimeShape = {
  id?: string | null;
  meta?: {
    aliases?: readonly string[];
    markdownCapable?: boolean;
    order?: number;
  } | null;
  capabilities?: {
    nativeCommands?: boolean;
  } | null;
  conversationBindings?: {
    supportsCurrentConversationBinding?: boolean;
  } | null;
};

export type ActivePluginChannelRegistration = {
  plugin: ActiveChannelPluginRuntimeShape;
  pluginId?: string | null;
  origin?: string | null;
};

export type ActivePluginChannelRegistry = {
  channels: ActivePluginChannelRegistration[];
};
