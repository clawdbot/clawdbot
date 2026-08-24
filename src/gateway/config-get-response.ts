import { readConfigFileSnapshot } from "../config/config.js";
import { redactConfigSnapshot } from "../config/redact-snapshot.js";
import {
  getRuntimeConfigAppliedHash,
  getRuntimeConfigSnapshotMetadata,
  hashRuntimeConfigValue,
} from "../config/runtime-snapshot.js";
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
      configSnapshotRevision: number | null;
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
  // Takes the snapshot's own config: redaction hints depend on which plugin owns each channel,
  // which the config decides, so a hint set built without it can describe the previous owner.
  loadUiHints: (
    config: ConfigFileSnapshot["sourceConfig"],
  ) => Parameters<typeof redactConfigSnapshot>[1];
  revisionProjector: GatewayConfigRevisionProjector;
}): Promise<ConfigGetResponse> {
  const getHotReloadStatus = params.getHotReloadStatus;
  if (!getHotReloadStatus || getHotReloadStatus() !== "active") {
    const snapshot = await readConfigFileSnapshot();
    return createConfigGetResponse(
      snapshot,
      params.loadUiHints(snapshot.sourceConfig),
      params.revisionProjector,
    );
  }
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  // An authored edit whose effective diff is empty is committed as a source-only publication: the
  // watcher's invalidation is gated on changed paths, the applied hash moves only when a candidate
  // is runtime-applied, and the registry version holds still too. The snapshot revision advances
  // on every publication (`setRuntimeConfigSourceSnapshotIfCurrent` republishes through
  // `setRuntimeConfigSnapshot`, rollback included), so a hit must prove it or config.get keeps
  // serving the pre-edit authored snapshot. Known edge: the revision is a session counter, not
  // content-addressed — a snapshot clear (`clearSecretsRuntimeSnapshotState` on the
  // managed-secrets failure paths) zeroes it without invalidating this cache, so a recycled count
  // can false-hit; keying on the metadata fingerprints would close that and is the follow-up, not
  // this change.
  const configSnapshotRevision = getRuntimeConfigSnapshotMetadata()?.revision ?? null;
  // With an active watcher, cache hits never re-read the file. External edits
  // become visible after its successful commit; the write path invalidates early.
  if (
    configGetResponseCache?.getHotReloadStatus === getHotReloadStatus &&
    configGetResponseCache.revisionProjector === params.revisionProjector &&
    configGetResponseCache.appliedConfigHash === appliedConfigHash &&
    configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion &&
    configGetResponseCache.configSnapshotRevision === configSnapshotRevision
  ) {
    return await configGetResponseCache.promise;
  }

  const promise = (async () => {
    const snapshot = await readConfigFileSnapshot();
    return createConfigGetResponse(
      snapshot,
      params.loadUiHints(snapshot.sourceConfig),
      params.revisionProjector,
    );
  })();
  configGetResponseCache = {
    getHotReloadStatus,
    revisionProjector: params.revisionProjector,
    appliedConfigHash,
    // Metadata notification precedes registry activation; this version changes at handoff.
    pluginRegistryVersion,
    configSnapshotRevision,
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
