import { describe, expect, it, vi } from "vitest";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";

describe("fetchRemoteEmbeddingVectors", () => {
  it("maps remote embedding response data through an injected fetch", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, {}, { embedding: [0.3] }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as typeof fetch;

    const vectors = await fetchRemoteEmbeddingVectors({
      url: "https://example.com/v1/embeddings",
      headers: { Authorization: "Bearer test" },
      ssrfPolicy: { allowedHostnames: ["example.com"] },
      fetchImpl,
      body: { input: ["one", "two", "three"] },
      errorPrefix: "embedding fetch failed",
    });

    expect(vectors).toEqual([[0.1, 0.2], [], [0.3]]);
  });
});
