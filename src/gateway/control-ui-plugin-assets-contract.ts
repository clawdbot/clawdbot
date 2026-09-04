import { normalizeControlUiBasePath } from "./control-ui-shared.js";

/** Reserved namespace for authenticated, immutable native plugin browser assets. */
export const CONTROL_UI_PLUGIN_ASSET_PREFIX = "/__openclaw__/plugins/control-ui/";

export function controlUiPluginAssetRoot(basePath?: string | null): string {
  return `${normalizeControlUiBasePath(basePath)}${CONTROL_UI_PLUGIN_ASSET_PREFIX}`;
}

export function controlUiPluginAssetPrefix(pluginId: string, basePath?: string | null): string {
  return `${controlUiPluginAssetRoot(basePath)}${encodeURIComponent(pluginId)}/`;
}
