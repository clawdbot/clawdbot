/** Reserved namespace for authenticated, immutable native plugin browser assets. */
export const CONTROL_UI_PLUGIN_ASSET_PREFIX = "/__openclaw__/plugins/control-ui/";
export const CONTROL_UI_PLUGIN_MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const CONTROL_UI_PLUGIN_MAX_BUILD_BYTES = 8 * 1024 * 1024;

export function controlUiPluginAssetPrefix(pluginId: string): string {
  return `${CONTROL_UI_PLUGIN_ASSET_PREFIX}${encodeURIComponent(pluginId)}/`;
}
