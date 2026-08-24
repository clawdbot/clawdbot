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
});
