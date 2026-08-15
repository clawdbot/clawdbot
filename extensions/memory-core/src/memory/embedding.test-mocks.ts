// Memory Core plugin module implements embedding mocks behavior.
import { vi } from "vitest";
import "./test-runtime-mocks.js";

const hoisted = vi.hoisted(() => ({
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  embedQuery: vi.fn(async () => [0, 1, 0]),
}));

export function resetEmbeddingMocks(): void {
  hoisted.embedBatch.mockReset();
  hoisted.embedQuery.mockReset();
  hoisted.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
  hoisted.embedQuery.mockImplementation(async () => [0, 1, 0]);
}

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      maxInputTokens: 8192,
      embedQuery: hoisted.embedQuery,
      embedBatch: hoisted.embedBatch,
    },
  }),
}));
