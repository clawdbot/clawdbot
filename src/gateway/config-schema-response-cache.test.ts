// Covers the memoized config schema response against source-only snapshot publications.
import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeConfigAppliedHash,
  getRuntimeConfigSnapshotMetadata,
  resetConfigRuntimeState,
  setAppliedRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
} from "../config/runtime-snapshot.js";
import type { ConfigSchemaResponse } from "../config/schema.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCachedConfigSchemaResponse,
  invalidateConfigSchemaResponseCache,
  setCachedConfigSchemaResponse,
} from "./config-schema-response-cache.js";

const response = {} as ConfigSchemaResponse;

afterEach(() => {
  invalidateConfigSchemaResponseCache();
  resetConfigRuntimeState();
});

describe("config schema response cache", () => {
  it("serves the entry for its registry version while nothing has been republished", () => {
    setAppliedRuntimeConfigSnapshot(
      { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
      { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
    );
    setCachedConfigSchemaResponse(7, response);

    expect(getCachedConfigSchemaResponse(7)).toBe(response);
    expect(getCachedConfigSchemaResponse(8)).toBeUndefined();
  });

  // An authored edit whose effective diff is empty never reaches `notifyCommitted`'s invalidation
  // (`config-reload.ts` gates it on changed paths); the accepted candidate is published as a new
  // source snapshot instead (`setRuntimeConfigSourceSnapshotIfCurrent`). Ownership reads explicit
  // selection from that source, so the schema answer can change while the registry version and the
  // applied hash both hold still — a hit must prove the same publication built it.
  it("misses after a source-only snapshot republish", () => {
    const runtime = { channels: { zzalpha: {} } } as unknown as OpenClawConfig;
    const sourceA = { channels: { zzalpha: {} } } as unknown as OpenClawConfig;
    setAppliedRuntimeConfigSnapshot(runtime, sourceA);
    setCachedConfigSchemaResponse(7, response);
    expect(getCachedConfigSchemaResponse(7)).toBe(response);

    const appliedBefore = getRuntimeConfigAppliedHash();
    const sourceB = {
      channels: { zzalpha: {} },
      plugins: { entries: { "zz-modern": { enabled: false } } },
    } as unknown as OpenClawConfig;
    expect(
      setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: getRuntimeConfigSnapshotMetadata()!.revision,
        sourceConfig: sourceB,
      }),
    ).toBe(true);

    // The republish is invisible to both keys the response caches held before this fix.
    expect(getRuntimeConfigAppliedHash()).toBe(appliedBefore);
    expect(getCachedConfigSchemaResponse(7)).toBeUndefined();
  });

  // `resetConfigRuntimeState` zeroes the snapshot revision counter without touching this cache
  // (`clearSecretsRuntimeSnapshotState` reaches it on the managed-secrets failure paths), so a
  // later publication can carry a previously seen revision number for different content. The
  // content-addressed key must miss where a revision key would false-hit.
  it("misses when a cleared runtime republishes different content at a recycled revision", () => {
    setAppliedRuntimeConfigSnapshot(
      { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
      { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
    );
    const revisionBefore = getRuntimeConfigSnapshotMetadata()!.revision;
    setCachedConfigSchemaResponse(7, response);
    expect(getCachedConfigSchemaResponse(7)).toBe(response);

    resetConfigRuntimeState();
    setAppliedRuntimeConfigSnapshot(
      { channels: { zzbeta: {} } } as unknown as OpenClawConfig,
      { channels: { zzbeta: {} } } as unknown as OpenClawConfig,
    );

    // Same counter value, same registry version, different snapshot content.
    expect(getRuntimeConfigSnapshotMetadata()!.revision).toBe(revisionBefore);
    expect(getCachedConfigSchemaResponse(7)).toBeUndefined();
  });

  // An entry stored while runtime state is cleared has no snapshot identity behind it, so there is
  // nothing a later hit could prove against.
  it("never hits without a published runtime snapshot to prove", () => {
    setCachedConfigSchemaResponse(7, response);
    expect(getCachedConfigSchemaResponse(7)).toBeUndefined();
  });

  // The other side of content addressing: the managed-secrets rollback republishes the pre-write
  // source through `setRuntimeConfigSourceSnapshotIfCurrent`, advancing the revision counter while
  // restoring identical content. The revision key evicted the still-correct entry; the fingerprint
  // key keeps serving it.
  it("keeps serving when a republish restores identical content", () => {
    setAppliedRuntimeConfigSnapshot(
      { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
      { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
    );
    setCachedConfigSchemaResponse(7, response);

    expect(
      setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: getRuntimeConfigSnapshotMetadata()!.revision,
        sourceConfig: { channels: { zzalpha: {} } } as unknown as OpenClawConfig,
      }),
    ).toBe(true);

    expect(getCachedConfigSchemaResponse(7)).toBe(response);
  });
});
