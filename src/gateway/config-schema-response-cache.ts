// The gateway's built config schema, memoized between requests.
//
// Ownership of a channel is decided by the config, so this response is config-dependent and cannot
// be keyed on the plugin registry version alone: a `channels.<id>` hot reload changes the answer
// without advancing that version. It lives in its own module so the reload path can invalidate it
// without importing the request handlers.
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import type { ConfigSchemaResponse } from "../config/schema.js";

let cache: {
  pluginRegistryVersion: number;
  configSnapshotRevision: number | null;
  response: ConfigSchemaResponse;
} | null = null;

// The reload path only reaches that invalidation for a commit with changed paths. An authored edit
// whose effective diff is empty is published as a new source snapshot instead
// (`setRuntimeConfigSourceSnapshotIfCurrent`), and ownership reads explicit selection from that
// source, so the answer can change while both the registry version and the invalidation hold
// still. The snapshot revision advances on every publication — rollback republish included — so
// the entry records the revision it was built at and a hit must prove it.
//
// Known edge: the revision is a session counter, not content-addressed. `resetConfigRuntimeState`
// zeroes it, and the managed-secrets failure paths reach that through
// `clearSecretsRuntimeSnapshotState` without touching this cache, so an entry stamped R can
// false-hit once the counter climbs back to R with the registry version unchanged. Keying on
// `metadata.fingerprint`/`sourceFingerprint` would close that (and stop over-invalidating on the
// rollback republish); deferred as a wider change than this fix.
function currentConfigSnapshotRevision(): number | null {
  return getRuntimeConfigSnapshotMetadata()?.revision ?? null;
}

export function getCachedConfigSchemaResponse(
  pluginRegistryVersion: number,
): ConfigSchemaResponse | undefined {
  return cache?.pluginRegistryVersion === pluginRegistryVersion &&
    cache.configSnapshotRevision === currentConfigSnapshotRevision()
    ? cache.response
    : undefined;
}

export function setCachedConfigSchemaResponse(
  pluginRegistryVersion: number,
  response: ConfigSchemaResponse,
): void {
  cache = {
    pluginRegistryVersion,
    configSnapshotRevision: currentConfigSnapshotRevision(),
    response,
  };
}

/** Drops the memoized schema. Called for every accepted config candidate, however it arrived. */
export function invalidateConfigSchemaResponseCache(): void {
  cache = null;
}
