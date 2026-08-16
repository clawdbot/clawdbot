import { readConfigFileSnapshot } from "../config/config.js";
import { redactConfigSnapshot } from "../config/redact-snapshot.js";
import { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";

type ConfigGetResponse = ReturnType<typeof createConfigGetResponse>;
let configGetResponseCache:
  | {
      getHotReloadStatus: () => GatewayHotReloadStatus | undefined;
      appliedConfigHash: string | null;
      pluginRegistryVersion: number;
      promise: Promise<ConfigGetResponse>;
    }
  | undefined;

function createConfigGetResponse(
  snapshot: ConfigFileSnapshot,
  uiHints: Parameters<typeof redactConfigSnapshot>[1],
) {
  return {
    ...redactConfigSnapshot(snapshot, uiHints),
    configRevisionHash: hashRuntimeConfigValue(snapshot.sourceConfig),
    appliedConfigHash: getRuntimeConfigAppliedHash(),
  };
}

/** Reads and projects config.get once per watcher-owned runtime and plugin-schema revision. */
export async function readConfigGetResponse(params: {
  getHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
  loadUiHints: () => Parameters<typeof redactConfigSnapshot>[1];
}): Promise<ConfigGetResponse> {
  const getHotReloadStatus = params.getHotReloadStatus;
  if (!getHotReloadStatus || getHotReloadStatus() !== "active") {
    return createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints());
  }
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  // With an active watcher, cache hits never re-read the file. External edits
  // become visible after its successful commit; the write path invalidates early.
  if (
    configGetResponseCache?.getHotReloadStatus === getHotReloadStatus &&
    configGetResponseCache.appliedConfigHash === appliedConfigHash &&
    configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion
  ) {
    return await configGetResponseCache.promise;
  }

  const promise = (async () =>
    createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints()))();
  configGetResponseCache = {
    getHotReloadStatus,
    appliedConfigHash,
    // Metadata notification precedes registry activation; this version changes at handoff.
    pluginRegistryVersion,
    promise,
  };
  try {
    return await promise;
  } catch (error) {
    if (configGetResponseCache?.promise === promise) {
      configGetResponseCache = undefined;
    }
    throw error;
  }
}

/** Invalidates cached config.get work after the watcher accepts a config candidate. */
export function invalidateConfigGetResponseCache(): void {
  configGetResponseCache = undefined;
}
