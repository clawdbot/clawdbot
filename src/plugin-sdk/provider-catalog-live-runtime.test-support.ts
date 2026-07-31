import { vi, type MockedFunction } from "vitest";
import type { LiveModelCatalogFetchGuard } from "./provider-catalog-live-runtime.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

export function buildLiveCatalogTestModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

export function buildLiveCatalogFetchGuard(body: unknown): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://provider.example.test/v1/models",
    release,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock, release };
}
