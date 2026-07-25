import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return { ...actual, createMistralEmbeddingProvider: vi.fn() };
});

import { createMistralEmbeddingProvider } from "./embedding-provider.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const mockCreate = vi.mocked(createMistralEmbeddingProvider);

// Spelled out rather than imported from the module under test: the
// default-endpoint case asserts that the shipped cache identity is unchanged, so
// it has to mean the same thing with and without this patch applied.
const SHIPPED_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

function stubClient(client: {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
}): void {
  mockCreate.mockResolvedValue({
    provider: {} as never,
    client: { ssrfPolicy: undefined, ...client },
  });
}

async function cacheKeyData(): Promise<Record<string, unknown>> {
  const result = await mistralMemoryEmbeddingProviderAdapter.create({} as never);
  if (!result.runtime) {
    throw new Error("expected the adapter to expose an embedding runtime");
  }
  return result.runtime.cacheKeyData as Record<string, unknown>;
}

describe("mistralMemoryEmbeddingProviderAdapter cache identity", () => {
  beforeEach(() => mockCreate.mockReset());

  it("keeps the shipped default identity (no baseUrl) for the default endpoint", async () => {
    stubClient({
      baseUrl: SHIPPED_MISTRAL_BASE_URL,
      headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
      model: "mistral-embed",
    });
    expect(await cacheKeyData()).toEqual({ provider: "mistral", model: "mistral-embed" });
  });

  it("scopes cache identity by base URL when a custom endpoint is configured", async () => {
    stubClient({
      baseUrl: "https://mistral.proxy.internal/v1",
      headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
      model: "mistral-embed",
    });
    expect(await cacheKeyData()).toEqual({
      provider: "mistral",
      baseUrl: "https://mistral.proxy.internal/v1",
      model: "mistral-embed",
    });
  });

  it("hashes custom header identity without leaking raw values", async () => {
    stubClient({
      baseUrl: SHIPPED_MISTRAL_BASE_URL,
      headers: {
        Authorization: "Bearer redacted", // pragma: allowlist secret
        "X-Tenant": "tenant-a",
      },
      model: "mistral-embed",
    });
    const data = await cacheKeyData();
    expect(data.headersHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain("tenant-a");
  });
});
