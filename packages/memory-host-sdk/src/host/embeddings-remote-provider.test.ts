import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRemoteEmbeddingVectors: vi.fn(),
}));

vi.mock("./embeddings-remote-fetch.js", () => ({
  fetchRemoteEmbeddingVectors: mocks.fetchRemoteEmbeddingVectors,
}));

import { createRemoteEmbeddingProvider } from "./embeddings-remote-provider.js";

function createProvider(batchQueryInputs?: boolean) {
  return createRemoteEmbeddingProvider({
    id: "fixture",
    client: {
      baseUrl: "https://embeddings.example.test/v1",
      headers: { Authorization: "Bearer fixture" },
      model: "fixture-model",
    },
    errorPrefix: "fixture embeddings failed",
    batchQueryInputs,
  });
}

beforeEach(() => {
  mocks.fetchRemoteEmbeddingVectors.mockReset();
  mocks.fetchRemoteEmbeddingVectors.mockImplementation(async ({ body }: { body: unknown }) => {
    const input = (body as { input: string[] }).input;
    return input.map((_, index) => [index]);
  });
});

describe("remote embedding provider request grouping", () => {
  it("runs query batches as one request per input by default", async () => {
    await createProvider().embedBatch(["first", "second"], { inputType: "query" });

    expect(
      mocks.fetchRemoteEmbeddingVectors.mock.calls.map(([request]) => request.body.input),
    ).toEqual([["first"], ["second"]]);
  });

  it("keeps document singleton calls on the batch-shaped request path", async () => {
    await createProvider().embed({ text: "document" }, { inputType: "document" });

    expect(mocks.fetchRemoteEmbeddingVectors).toHaveBeenCalledOnce();
    expect(mocks.fetchRemoteEmbeddingVectors.mock.calls[0]?.[0].body.input).toEqual(["document"]);
  });

  it("batches query inputs when the provider declares identical query and document payloads", async () => {
    await createProvider(true).embedBatch(["first", "second"], { inputType: "query" });

    expect(mocks.fetchRemoteEmbeddingVectors).toHaveBeenCalledOnce();
    expect(mocks.fetchRemoteEmbeddingVectors.mock.calls[0]?.[0].body.input).toEqual([
      "first",
      "second",
    ]);
  });
});
