import { describe, expect, it, vi } from "vitest";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";

describe("resolveRemoteEmbeddingBearerClient", () => {
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
            originator: "pi",
            "User-Agent": "pi",
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
