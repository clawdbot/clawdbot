import { vi, type Mock } from "vitest";
import "./test-runtime-mocks.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
type EmbedBatchMock = Mock<(texts: string[]) => Promise<number[][]>>;
type EmbedQueryMock = Mock<() => Promise<number[]>>;

const hoisted = vi.hoisted(() => ({
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  embedQuery: vi.fn(async () => [0, 1, 0]),
}));

export function getEmbedBatchMock(): EmbedBatchMock {
  return hoisted.embedBatch;
}

export function getEmbedQueryMock(): EmbedQueryMock {
  return hoisted.embedQuery;
}

export function resetEmbeddingMocks(): void {
  hoisted.embedBatch.mockReset();
  hoisted.embedQuery.mockReset();
  hoisted.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
  hoisted.embedQuery.mockImplementation(async () => [0, 1, 0]);
}

vi.mock("./embeddings.js", () => ({
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
