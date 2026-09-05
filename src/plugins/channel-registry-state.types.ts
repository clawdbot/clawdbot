/** Validated channel plugin retained by the active runtime registry. */
export type ActiveChannelPluginRuntimeShape =
  import("../channels/plugins/types.plugin.js").ChannelPlugin & {
    meta: NonNullable<import("../channels/plugins/types.plugin.js").ChannelPlugin["meta"]>;
  };

/** Active channel registration with owning plugin metadata. */
export type ActivePluginChannelRegistration = {
  plugin: ActiveChannelPluginRuntimeShape;
  pluginId?: string | null;
  origin?: import("./plugin-origin.types.js").PluginOrigin | null;
  resolveChannelRuntime?: () => import("./runtime/types-channel.js").PluginRuntimeChannel;
};

/** Active runtime channel registry snapshot. */
export type ActivePluginChannelRegistry = {
  channels: ActivePluginChannelRegistration[];
};
