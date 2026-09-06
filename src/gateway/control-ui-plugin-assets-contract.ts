import { normalizeControlUiBasePath } from "./control-ui-shared.js";

/** Reserved namespace for authenticated, immutable native plugin browser assets. */
export function controlUiPluginAssetRoot(basePath?: string | null): string {
  return `${normalizeControlUiBasePath(basePath)}/__openclaw__/plugins/control-ui/`;
}

export function controlUiPluginAssetPrefix(pluginId: string, basePath?: string | null): string {
  return `${controlUiPluginAssetRoot(basePath)}${encodeURIComponent(pluginId)}/`;
}
