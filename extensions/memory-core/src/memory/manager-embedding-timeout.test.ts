import { describe, expect, it } from "vitest";
import { resolveEmbeddingTimeoutMs } from "./manager-embedding-ops.js";

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
