import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/github-copilot-token.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { createGitHubCopilotEmbeddingProvider } from "./embeddings-github-copilot.js";

function mockFetchResponse(spec: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  fetchWithSsrFGuardMock.mockImplementationOnce(async () => ({
    response: {
      ok: spec.ok,
      status: spec.status ?? (spec.ok ? 200 : 500),
      json: async () => spec.json,
      text: async () => spec.text ?? "",
    },
    release: vi.fn(async () => {}),
  }));
}

describe("createGitHubCopilotEmbeddingProvider", () => {
  beforeEach(() => {
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: "copilot-token-a",
      expiresAt: Date.now() + 3_600_000,
      source: "test",
      baseUrl: "https://api.githubcopilot.test",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveCopilotApiTokenMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("normalizes embeddings returned for queries", async () => {
    mockFetchResponse({
      ok: true,
      json: {
        data: [{ index: 0, embedding: [3, 4] }],
      },
    });

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      githubToken: "gh_test",
      model: "text-embedding-3-small",
    });

    await expect(provider.embedQuery("hello")).resolves.toEqual([0.6, 0.8]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.githubcopilot.test/embeddings",
      }),
    );
  });

  it("preserves input order by explicit response index", async () => {
    mockFetchResponse({
      ok: true,
      json: {
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [1, 0] },
        ],
      },
    });

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      githubToken: "gh_test",
      model: "text-embedding-3-small",
    });

    await expect(provider.embedBatch(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("uses a fresh Copilot token for later requests", async () => {
    resolveCopilotApiTokenMock
      .mockResolvedValueOnce({
        token: "copilot-token-create",
        expiresAt: Date.now() + 3_600_000,
        source: "test",
        baseUrl: "https://api.githubcopilot.test",
      })
      .mockResolvedValueOnce({
        token: "copilot-token-first",
        expiresAt: Date.now() + 3_600_000,
        source: "test",
        baseUrl: "https://api.githubcopilot.test",
      })
      .mockResolvedValueOnce({
        token: "copilot-token-second",
        expiresAt: Date.now() + 3_600_000,
        source: "test",
        baseUrl: "https://api.githubcopilot.test",
      });
    mockFetchResponse({
      ok: true,
      json: { data: [{ index: 0, embedding: [1, 0] }] },
    });
    mockFetchResponse({
      ok: true,
      json: { data: [{ index: 0, embedding: [0, 1] }] },
    });

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      githubToken: "gh_test",
      model: "text-embedding-3-small",
    });

    await provider.embedQuery("first");
    await provider.embedQuery("second");

    const firstHeaders = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.init?.headers as Record<
      string,
      string
    >;
    const secondHeaders = fetchWithSsrFGuardMock.mock.calls[1]?.[0]?.init?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders.Authorization).toBe("Bearer copilot-token-first");
    expect(secondHeaders.Authorization).toBe("Bearer copilot-token-second");
  });

  it("honors custom baseUrl and header overrides", async () => {
    mockFetchResponse({
      ok: true,
      json: { data: [{ index: 0, embedding: [1, 0] }] },
    });

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      githubToken: "gh_test",
      model: "text-embedding-3-small",
      baseUrl: "https://proxy.example/v1",
      headers: { "X-Proxy-Token": "proxy" },
    });

    await provider.embedQuery("hello");

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
      init: { headers: Record<string, string> };
      url: string;
    };
    expect(call.url).toBe("https://proxy.example/v1/embeddings");
    expect(call.init.headers["X-Proxy-Token"]).toBe("proxy");
    expect(call.init.headers.Authorization).toBe("Bearer copilot-token-a");
  });

  it("fails fast on sparse or malformed embedding payloads", async () => {
    mockFetchResponse({
      ok: true,
      json: {
        data: [{ index: 1, embedding: [1, 0] }],
      },
    });

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      githubToken: "gh_test",
      model: "text-embedding-3-small",
    });

    await expect(provider.embedBatch(["first", "second"])).rejects.toThrow(
      "GitHub Copilot embeddings response missing vectors for some inputs",
    );
  });
});
