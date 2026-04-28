import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputStringMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveFirstGithubTokenMock,
}));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputString: resolveConfiguredSecretInputStringMock,
}));

vi.mock("./token.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";

const TEST_BASE_URL = "https://api.githubcopilot.test";

function buildModelsResponse(models: Array<{ id: string; supported_endpoints?: unknown }>) {
  return { data: models };
}

function mockDiscoveryResponse(spec: {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}) {
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

function defaultCreateOptions() {
  return {
    config: {} as Record<string, unknown>,
    agentDir: "/tmp/test-agent",
    model: "",
  };
}

describe("githubCopilotMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    resolveConfiguredSecretInputStringMock.mockResolvedValue({});
    resolveFirstGithubTokenMock.mockResolvedValue({
      githubToken: "gh_test_token_123",
      hasProfile: false,
    });
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: "copilot_test_token_abc",
      expiresAt: Date.now() + 3_600_000,
      source: "test",
      baseUrl: TEST_BASE_URL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveConfiguredSecretInputStringMock.mockReset();
    resolveFirstGithubTokenMock.mockReset();
    resolveCopilotApiTokenMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers the expected adapter metadata", () => {
    expect(githubCopilotMemoryEmbeddingProviderAdapter.id).toBe("github-copilot");
    expect(githubCopilotMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(githubCopilotMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(15);
    expect(githubCopilotMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(true);
  });

  it("picks text-embedding-3-small when available", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-large", supported_endpoints: ["/v1/embeddings"] },
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
        { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.provider?.model).toBe("text-embedding-3-small");
    expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "gh_test_token_123" }),
    );
  });

  it("matches embedding-capable models when supported_endpoints is missing or malformed", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "gpt-4o", supported_endpoints: { broken: true } },
        { id: "text-embedding-3-small", supported_endpoints: [] },
        { id: "text-embedding-ada-002" },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.provider?.model).toBe("text-embedding-3-small");
  });

  it("strips the provider prefix from a user-selected model", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      model: "github-copilot/text-embedding-3-small",
    } as never);

    expect(result.provider?.model).toBe("text-embedding-3-small");
  });

  it("throws when the user-selected model is unavailable", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create({
        ...defaultCreateOptions(),
        model: "gpt-4o",
      } as never),
    ).rejects.toThrow('GitHub Copilot embedding model "gpt-4o" is not available');
  });

  it("throws when discovery finds no embedding models", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([{ id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] }]),
    });

    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow("No embedding models available from GitHub Copilot");
  });

  it("wraps invalid discovery JSON as a setup error", async () => {
    fetchWithSsrFGuardMock.mockImplementationOnce(async () => ({
      response: {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
        text: async () => "",
      },
      release: vi.fn(async () => {}),
    }));

    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow("GitHub Copilot model discovery returned invalid JSON");
  });

  it("honors remote overrides when creating the provider", async () => {
    resolveConfiguredSecretInputStringMock.mockResolvedValue({ value: "gh_remote_token" });
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    await githubCopilotMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      remote: {
        apiKey: "ignored-at-runtime",
        baseUrl: "https://proxy.example/v1",
        headers: { "X-Proxy-Token": "proxy" },
      },
    } as never);

    expect(resolveFirstGithubTokenMock).toHaveBeenCalled();
    expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: process.env,
        githubToken: "gh_remote_token",
      }),
    );

    const discoveryCall = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
      init: { headers: Record<string, string> };
      url: string;
    };
    expect(discoveryCall.url).toBe("https://proxy.example/v1/models");
    expect(discoveryCall.init.headers["X-Proxy-Token"]).toBe("proxy");
  });

  it("includes provider, baseUrl, and model in runtime cache data", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.runtime).toEqual({
      id: "github-copilot",
      cacheKeyData: {
        provider: "github-copilot",
        baseUrl: TEST_BASE_URL,
        model: "text-embedding-3-small",
      },
    });
  });

  it("treats token parsing and discovery failures as auto-fallback errors", () => {
    expect(
      githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(
        new Error("Copilot token response missing token"),
      ),
    ).toBe(true);
    expect(
      githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(
        new Error("Unexpected response from GitHub Copilot token endpoint"),
      ),
    ).toBe(true);
    expect(
      githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(
        new Error("GitHub Copilot model discovery returned invalid JSON"),
      ),
    ).toBe(true);
    expect(
      githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(
        new Error("Network timeout"),
      ),
    ).toBe(false);
  });
});
