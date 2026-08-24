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
      configSnapshotSourceFingerprint: string | null;
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
  // is runtime-applied, and the registry version holds still too. A hit must prove that
  // publication or config.get keeps serving the pre-edit authored snapshot.
  //
  // The proof takes both halves of the snapshot's identity, because each covers what the other
  // cannot.
  //
  // The source fingerprint hashes the canonical source content, so it cannot recycle: the revision
  // is a session counter that `resetConfigRuntimeState` zeroes (`clearSecretsRuntimeSnapshotState`
  // reaches it on the managed-secrets failure paths without invalidating this cache), and a
  // recycled count can alias two different snapshots.
  //
  // The revision covers what the fingerprint is blind to. This response carries the snapshot's raw
  // file hash, which clients hand back as the compare-and-swap base for a write, but the
  // fingerprint hashes the PARSED config through `stableConfigStringify`. An edit that changes only
  // JSON5 comments, whitespace, or key order therefore moves the raw hash while leaving the
  // fingerprint identical, and its effective diff is empty so the watcher does not invalidate
  // either. Keyed on the fingerprint alone the cache kept serving the pre-edit raw hash, every CAS
  // write rejected it, and the retry that rejection asks for returned the same stale hash forever.
  // Every republish bumps the revision, source-only ones included, so requiring it too breaks that
  // loop.
  //
  // A snapshot without a source fingerprint proves nothing about the file, so it never hits.
  const configSnapshotMetadata = getRuntimeConfigSnapshotMetadata();
  const configSnapshotSourceFingerprint = configSnapshotMetadata?.sourceFingerprint ?? null;
  const configSnapshotRevision = configSnapshotMetadata?.revision ?? null;
  // With an active watcher, cache hits never re-read the file. External edits
  // become visible after its successful commit; the write path invalidates early.
  if (
    configGetResponseCache?.getHotReloadStatus === getHotReloadStatus &&
    configGetResponseCache.revisionProjector === params.revisionProjector &&
    configGetResponseCache.appliedConfigHash === appliedConfigHash &&
    configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion &&
    configGetResponseCache.configSnapshotSourceFingerprint !== null &&
    configGetResponseCache.configSnapshotSourceFingerprint === configSnapshotSourceFingerprint &&
    configGetResponseCache.configSnapshotRevision !== null &&
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
    configSnapshotSourceFingerprint,
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
