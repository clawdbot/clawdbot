// Memory Host SDK tests cover embeddings remote client behavior.
import { describe, expect, it, vi } from "vitest";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import type { EmbeddingProviderOptions } from "./embeddings.types.js";

const configuredProvider = {
  baseUrl: "https://provider.example.test/v1",
  apiKey: "provider-key",
  headers: { "X-Provider-Tenant": "provider-a" },
  models: [],
};

describe("resolveRemoteEmbeddingBearerClient", () => {
  it.each<{
    name: string;
    remote?: EmbeddingProviderOptions["remote"];
    authorization: string;
    tenant: string;
  }>([
    {
      name: "keeps provider credentials on the configured provider destination",
      remote: undefined,
      authorization: "Bearer provider-key",
      tenant: "provider-a",
    },
    {
      name: "uses only destination-owned remote credentials",
      remote: {
        baseUrl: "https://remote.example.test/v1",
        apiKey: "remote-key",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      authorization: "Bearer remote-key",
      tenant: "remote-b",
    },
    {
      name: "accepts a destination-owned Authorization header without an API key",
      remote: {
        baseUrl: "https://remote.example.test/v1",
        headers: { Authorization: "Bearer remote-header-key", "X-Remote-Tenant": "remote-b" },
      },
      authorization: "Bearer remote-header-key",
      tenant: "remote-b",
    },
  ])("$name", async ({ remote, authorization, tenant }) => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: { models: { providers: { openai: configuredProvider } } } as never,
        model: "text-embedding-3-small",
        remote,
      },
    });

    expect(client.baseUrl).toBe(remote?.baseUrl ?? configuredProvider.baseUrl);
    expect(client.headers.Authorization).toBe(authorization);
    expect(client.headers[remote ? "X-Remote-Tenant" : "X-Provider-Tenant"]).toBe(tenant);
    if (remote) {
      expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
    }
  });

  it("fails before egress when a remote destination has no destination-owned auth", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: { models: { providers: { openai: configuredProvider } } } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://remote.example.test/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("treats loopback address families as distinct credential destinations", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "http://localhost:12345/v1",
        options: {
          config: {
            models: {
              providers: {
                openai: { ...configuredProvider, baseUrl: "http://localhost:12345/v1" },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "http://127.0.0.1:12345/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("treats query-distinct URLs as different credential destinations", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://provider.example.test/v1?tenant=provider",
        options: {
          config: {
            models: {
              providers: {
                openai: {
                  ...configuredProvider,
                  baseUrl: "https://provider.example.test/v1?tenant=provider",
                },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://provider.example.test/v1?tenant=remote" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
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
