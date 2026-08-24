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
  configSnapshotIdentity: string | null;
  response: ConfigSchemaResponse;
} | null = null;

// The reload path only reaches that invalidation for a commit with changed paths. An authored edit
// whose effective diff is empty is published as a new source snapshot instead
// (`setRuntimeConfigSourceSnapshotIfCurrent`), and ownership reads explicit selection from that
// source, so the answer can change while both the registry version and the invalidation hold
// still. The entry therefore records the snapshot identity it was built from, and a hit must
// prove it.
//
// That identity is the metadata's content fingerprints, not its revision: the revision is a
// session counter that `resetConfigRuntimeState` zeroes (the managed-secrets failure paths reach
// it through `clearSecretsRuntimeSnapshotState` without touching this cache), so a recycled count
// can alias two different snapshots. The fingerprints hash content, so they cannot recycle — and
// a republish that restores identical content restores the same key, so a rollback no longer
// evicts an entry that is still correct. Both halves are load-bearing: the schema is built from
// the runtime config (`getRuntimeConfig` and the registry resolved from it) while ownership reads
// explicit selection from the source snapshot, and either can change while the other holds still.
// No published snapshot means nothing to prove, so a null identity never hits.
function currentConfigSnapshotIdentity(): string | null {
  const metadata = getRuntimeConfigSnapshotMetadata();
  if (!metadata) {
    return null;
  }
  // Fingerprints are base64url, so ":" appears in neither half and the join is unambiguous. A
  // snapshot published without a source config keys as the empty marker rather than missing:
  // "no source snapshot" is itself deterministic ownership-policy input, not unproven state.
  return `${metadata.fingerprint}:${metadata.sourceFingerprint ?? ""}`;
}

export function getCachedConfigSchemaResponse(
  pluginRegistryVersion: number,
): ConfigSchemaResponse | undefined {
  const identity = currentConfigSnapshotIdentity();
  return identity !== null &&
    cache?.pluginRegistryVersion === pluginRegistryVersion &&
    cache.configSnapshotIdentity === identity
    ? cache.response
    : undefined;
}

export function setCachedConfigSchemaResponse(
  pluginRegistryVersion: number,
  response: ConfigSchemaResponse,
): void {
  cache = {
    pluginRegistryVersion,
    configSnapshotIdentity: currentConfigSnapshotIdentity(),
    response,
  };
}

/** Drops the memoized schema. Called for every accepted config candidate, however it arrived. */
export function invalidateConfigSchemaResponseCache(): void {
  cache = null;
}
