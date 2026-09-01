/** Reserved namespace for authenticated, immutable native plugin browser assets. */
export const CONTROL_UI_PLUGIN_ASSET_PREFIX = "/__openclaw__/plugins/control-ui/";

export function controlUiPluginAssetPrefix(pluginId: string): string {
  return `${CONTROL_UI_PLUGIN_ASSET_PREFIX}${encodeURIComponent(pluginId)}/`;
}
