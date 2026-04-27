import { describe, expect, it } from "vitest";
import {
  resolveEmbeddingTimeoutMs,
  resolveMemoryIndexConcurrency,
} from "./manager-embedding-ops.js";

describe("memory embedding timeout resolution", () => {
  it("uses hosted defaults for inline embedding calls", () => {
    expect(resolveEmbeddingTimeoutMs({ kind: "query", providerId: "openai" })).toBe(60_000);
    expect(resolveEmbeddingTimeoutMs({ kind: "batch", providerId: "openai" })).toBe(120_000);
  });

  it("uses local defaults for the builtin local provider", () => {
    expect(resolveEmbeddingTimeoutMs({ kind: "query", providerId: "local" })).toBe(300_000);
    expect(resolveEmbeddingTimeoutMs({ kind: "batch", providerId: "local" })).toBe(600_000);
  });

  it("uses runtime batch defaults for local-server providers", () => {
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "batch",
        providerId: "ollama",
        providerRuntime: { inlineBatchTimeoutMs: 600_000 },
      }),
    ).toBe(600_000);
  });

  it("lets configured batch timeout override provider defaults", () => {
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "batch",
        providerId: "ollama",
        providerRuntime: { inlineBatchTimeoutMs: 600_000 },
        configuredBatchTimeoutSeconds: 45,
      }),
    ).toBe(45_000);
  });
});

describe("memory index concurrency resolution", () => {
  it("uses the default index concurrency when batch mode is disabled and unconfigured", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 2 },
      }),
    ).toBe(4);
  });

  it("respects configured concurrency even when batch mode is disabled", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 1 },
        configuredConcurrency: 1,
      }),
    ).toBe(1);
  });

  it("uses resolved batch concurrency when batch mode is enabled", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: true, concurrency: 3 },
      }),
    ).toBe(3);
  });
});
