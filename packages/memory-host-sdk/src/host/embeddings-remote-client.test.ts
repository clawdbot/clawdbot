// Memory Host SDK tests cover embeddings remote client behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";

const authMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("./openclaw-runtime-auth.js", () => ({
  requireApiKey: (auth: { apiKey?: string }, provider: string) => {
    const apiKey = auth.apiKey?.trim();
    if (!apiKey) {
      throw new Error(`No API key resolved for provider "${provider}".`);
    }
    return apiKey;
  },
  resolveApiKeyForProvider: authMocks.resolveApiKeyForProvider,
}));

describe("resolveRemoteEmbeddingBearerClient", () => {
  beforeEach(() => {
    authMocks.resolveApiKeyForProvider.mockReset();
  });

  it("uses configured OpenAI provider baseUrl for memory embeddings", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://proxy.example.test/openai/v1",
              },
            },
          },
        } as never,
        model: "text-embedding-3-small",
        remote: {
          apiKey: "sk-test",
        },
      },
    });

    expect(client.baseUrl).toBe("https://proxy.example.test/openai/v1");
  });

  it("resolves native OpenAI embeddings with direct platform auth", async () => {
    authMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "sk-resolved",
      source: "profile:openai",
      mode: "api-key",
    });

    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        agentDir: "/tmp/openclaw-agent",
        config: { models: {} } as never,
        model: "text-embedding-3-small",
      },
    });

    expect(authMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "openai",
      cfg: { models: {} },
      agentDir: "/tmp/openclaw-agent",
      modelId: "text-embedding-3-small",
      modelApi: "openai-responses",
    });
    expect(client.headers.Authorization).toBe("Bearer sk-resolved");
  });

  it("adds OpenClaw attribution to native OpenAI embedding requests", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: { models: {} } as never,
        model: "text-embedding-3-large",
        remote: {
          apiKey: "sk-test",
          headers: {
            originator: "openclaw",
            "User-Agent": "openclaw",
          },
        },
      },
    });

    expect(client.headers).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });
});
