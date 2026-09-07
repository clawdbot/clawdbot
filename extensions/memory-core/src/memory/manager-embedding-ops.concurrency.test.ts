// Memory Core tests cover manager non-batch index concurrency policy behavior.
import { describe, expect, it } from "vitest";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

type IndexConcurrencyHarness = { getIndexConcurrency: () => number };

// Exercise the real concurrency policy without opening a memory index or
// acquiring an external embedding provider (same seam as
// manager-embedding-ops.retry.test.ts).
function createIndexConcurrencyHarness(params: {
  providerId?: string;
  batch?: { enabled: boolean; concurrency: number };
  /** Full rebuilds resolve the id through an active sync generation instead. */
  generationProviderId?: string;
}): IndexConcurrencyHarness {
  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    batch: params.batch ?? { enabled: false, concurrency: 8 },
    // Resolved settings carry no non-batch override; kept so the harness also loads
    // against pre-fix code, which read this field.
    settings: { remote: undefined },
    provider: params.providerId
      ? { id: params.providerId, model: `${params.providerId}-model` }
      : undefined,
    syncProviderGeneration: params.generationProviderId
      ? { provider: { id: params.generationProviderId } }
      : undefined,
  }) as IndexConcurrencyHarness;
}

describe("memory index concurrency", () => {
  it("indexes one job at a time for local embedding providers", () => {
    expect(createIndexConcurrencyHarness({ providerId: "local" }).getIndexConcurrency()).toBe(1);
  });

  it("keeps the single-job default for ollama embedding providers", () => {
    expect(createIndexConcurrencyHarness({ providerId: "ollama" }).getIndexConcurrency()).toBe(1);
  });

  it("keeps the parallel default for remote embedding providers", () => {
    expect(createIndexConcurrencyHarness({ providerId: "openai" }).getIndexConcurrency()).toBe(4);
  });

  it("indexes one job at a time when a full rebuild runs under a local sync generation", () => {
    // The full-rebuild path this fixes reads the id from the active generation,
    // not from `provider`, so pin that branch too.
    expect(
      createIndexConcurrencyHarness({
        providerId: "openai",
        generationProviderId: "local",
      }).getIndexConcurrency(),
    ).toBe(1);
  });

  it("keeps the batch concurrency when batch embedding is enabled", () => {
    expect(
      createIndexConcurrencyHarness({
        providerId: "local",
        batch: { enabled: true, concurrency: 3 },
      }).getIndexConcurrency(),
    ).toBe(3);
  });
});
