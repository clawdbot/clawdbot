import { readConfigFileSnapshot } from "../config/config.js";
import { redactConfigSnapshot } from "../config/redact-snapshot.js";
import { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";
import type { GatewayConfigRevisionProjector } from "./config-revision-token.js";

type ConfigGetResponse = ReturnType<typeof createConfigGetResponse>;
let configGetResponseCache:
  | {
      getHotReloadStatus: () => GatewayHotReloadStatus | undefined;
      revisionProjector: GatewayConfigRevisionProjector;
      appliedConfigHash: string | null;
      pluginRegistryVersion: number;
      promise: Promise<ConfigGetResponse>;
    }
  | undefined;

function createConfigGetResponse(
  snapshot: ConfigFileSnapshot,
  uiHints: Parameters<typeof redactConfigSnapshot>[1],
  revisionProjector: GatewayConfigRevisionProjector,
) {
  const redacted = redactConfigSnapshot(snapshot, uiHints);
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  return {
    ...redacted,
    hash: redacted.hash ? revisionProjector.projectRawHash(redacted.hash) : redacted.hash,
    configRevisionHash: revisionProjector.projectResolvedHash(
      hashRuntimeConfigValue(snapshot.sourceConfig),
    ),
    appliedConfigHash: appliedConfigHash
      ? revisionProjector.projectResolvedHash(appliedConfigHash)
      : null,
  };
}

/** Reads and projects config.get once per watcher-owned runtime and plugin-schema revision. */
export async function readConfigGetResponse(params: {
  getHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
  loadUiHints: () => Parameters<typeof redactConfigSnapshot>[1];
  revisionProjector: GatewayConfigRevisionProjector;
}): Promise<ConfigGetResponse> {
  const getHotReloadStatus = params.getHotReloadStatus;
  if (!getHotReloadStatus || getHotReloadStatus() !== "active") {
    return createConfigGetResponse(
      await readConfigFileSnapshot(),
      params.loadUiHints(),
      params.revisionProjector,
    );
  }
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  // With an active watcher, cache hits never re-read the file. External edits
  // become visible after its successful commit; the write path invalidates early.
  if (
    configGetResponseCache?.getHotReloadStatus === getHotReloadStatus &&
    configGetResponseCache.revisionProjector === params.revisionProjector &&
    configGetResponseCache.appliedConfigHash === appliedConfigHash &&
    configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion
  ) {
    return await configGetResponseCache.promise;
  }

  const promise = (async () =>
    createConfigGetResponse(
      await readConfigFileSnapshot(),
      params.loadUiHints(),
      params.revisionProjector,
    ))();
  configGetResponseCache = {
    getHotReloadStatus,
    revisionProjector: params.revisionProjector,
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
