import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./post-json.js", () => ({
  postJson: postJsonMock,
}));

function requirePostJsonParams(): {
  url?: unknown;
  headers?: unknown;
  body?: unknown;
  errorPrefix?: unknown;
} {
  const [call] = postJsonMock.mock.calls;
  if (!call) {
    throw new Error("expected postJson call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected postJson params to be an object");
  }
  return params;
}

describe("fetchRemoteEmbeddingVectors", () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it("maps remote embedding response data to vectors", async () => {
    postJsonMock.mockImplementationOnce(async (params) => {
      return await params.parse({
        data: [{ embedding: [0.1, 0.2] }, {}, { embedding: [0.3] }],
      });
    });

    const vectors = await fetchRemoteEmbeddingVectors({
      url: "https://memory.example/v1/embeddings",
      headers: { Authorization: "Bearer test" },
      body: { input: ["one", "two", "three"] },
      errorPrefix: "embedding fetch failed",
    });

    expect(vectors).toEqual([[0.1, 0.2], [], [0.3]]);
    const postJsonParams = requirePostJsonParams();
    expect(postJsonParams.url).toBe("https://memory.example/v1/embeddings");
    expect(postJsonParams.headers).toEqual({ Authorization: "Bearer test" });
    expect(postJsonParams.body).toEqual({ input: ["one", "two", "three"] });
    expect(postJsonParams.errorPrefix).toBe("embedding fetch failed");
  });

  it("throws a status-rich error on non-ok responses", async () => {
    postJsonMock.mockRejectedValueOnce(new Error("embedding fetch failed: 403 forbidden"));

    await expect(
      fetchRemoteEmbeddingVectors({
        url: "https://memory.example/v1/embeddings",
        headers: {},
        body: { input: ["one"] },
        errorPrefix: "embedding fetch failed",
      }),
    ).rejects.toThrow("embedding fetch failed: 403 forbidden");
  });
});
