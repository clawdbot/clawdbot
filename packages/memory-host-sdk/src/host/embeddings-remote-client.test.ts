// Memory Host SDK tests cover embeddings remote client behavior.
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

  it("keeps provider credentials on the provider-owned destination", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://provider.example.test/v1",
                apiKey: "provider-key",
                headers: { "X-Provider-Tenant": "provider-a" },
                models: [],
              },
            },
          },
        } as never,
        model: "text-embedding-3-small",
      },
    });

    expect(client.baseUrl).toBe("https://provider.example.test/v1");
    expect(client.headers).toMatchObject({
      Authorization: "Bearer provider-key",
      "X-Provider-Tenant": "provider-a",
    });
  });

  it("does not inherit provider credentials across a remote destination override", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://provider.example.test/v1",
                apiKey: "provider-key",
                headers: { "X-Provider-Tenant": "provider-a" },
                models: [],
              },
            },
          },
        } as never,
        model: "text-embedding-3-small",
        remote: {
          baseUrl: "https://remote.example.test/v1",
          apiKey: "remote-key",
          headers: { "X-Remote-Tenant": "remote-b" },
        },
      },
    });

    expect(client.baseUrl).toBe("https://remote.example.test/v1");
    expect(client.headers).toMatchObject({
      Authorization: "Bearer remote-key",
      "X-Remote-Tenant": "remote-b",
    });
    expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
  });

  it("fails before egress when a remote destination has no destination-owned auth", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: {
            models: {
              providers: {
                openai: {
                  baseUrl: "https://provider.example.test/v1",
                  apiKey: "provider-key",
                  models: [],
                },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://remote.example.test/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it.each(["$OTHER_SECRET", "${OTHER_SECRET}"])(
    "preserves a resolved template-looking remote credential %s",
    async (apiKey) => {
      const client = await resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: { models: {} } as never,
          model: "text-embedding-3-small",
          remote: { apiKey },
        },
      });

      expect(client.headers.Authorization).toBe(`Bearer ${apiKey}`);
    },
  );

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
