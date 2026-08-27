import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnresolvedSecretInputError } from "../config/types.secrets.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

describe("OpenAI-compatible embedding destination credential ownership", () => {
  const vector = [0.25, 0.5, 0.75];
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ url?: string; headers: IncomingHttpHeaders }>;

  beforeEach(async () => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_KEY", "ambient-key-bait");
    vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER", "ambient-header-bait");
    requests = [];
    server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        requests.push({ url: request.url, headers: request.headers });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ index: 0, embedding: vector }] }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("embedding fixture did not expose a TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function createOptions(params: {
    providerOwnsDestination?: boolean;
    providerBaseUrl?: string;
    remote: NonNullable<EmbeddingProviderCreateOptions["remote"]>;
  }): EmbeddingProviderCreateOptions {
    return {
      config: {
        models: {
          providers: {
            "tenant-embeddings": {
              api: "openai-completions",
              baseUrl:
                params.providerBaseUrl ??
                (params.providerOwnsDestination ? baseUrl : "https://provider.example.test/v1"),
              apiKey: "synthetic-provider-key",
              headers: { "X-Provider-Tenant": "provider-tenant", "X-Shared": "provider-value" },
              models: [],
            },
          },
        },
      },
      provider: "tenant-embeddings",
      model: "tenant-embeddings/fixture-model",
      remote: { baseUrl, ...params.remote },
    };
  }

  it.each<{
    name: string;
    providerOwnsDestination?: boolean;
    queryDistinctDestination?: boolean;
    remote: NonNullable<EmbeddingProviderCreateOptions["remote"]>;
    authorization: string | undefined;
    expectedHeaders: Record<string, string>;
  }>([
    {
      name: "provider-owned destination receives provider credentials and remote precedence",
      providerOwnsDestination: true,
      remote: { headers: { "X-Shared": "remote-value" } },
      authorization: "Bearer synthetic-provider-key",
      expectedHeaders: { "x-provider-tenant": "provider-tenant", "x-shared": "remote-value" },
    },
    {
      name: "destination-owned Authorization takes precedence over the provider API key",
      providerOwnsDestination: true,
      remote: { headers: { Authorization: "Bearer synthetic-remote-header" } },
      authorization: "Bearer synthetic-remote-header",
      expectedHeaders: { "x-provider-tenant": "provider-tenant", "x-shared": "provider-value" },
    },
    {
      name: "different destination receives only remote-owned credentials",
      remote: { apiKey: "synthetic-remote-key", headers: { "X-Remote-Tenant": "remote-tenant" } },
      authorization: "Bearer synthetic-remote-key",
      expectedHeaders: { "x-remote-tenant": "remote-tenant" },
    },
    {
      name: "query-distinct destination preserves its tenant and excludes provider credentials",
      queryDistinctDestination: true,
      remote: { apiKey: "synthetic-remote-key", headers: { "X-Remote-Tenant": "remote-tenant" } },
      authorization: "Bearer synthetic-remote-key",
      expectedHeaders: { "x-remote-tenant": "remote-tenant" },
    },
    {
      name: "different destination accepts its own explicit Authorization header",
      remote: { headers: { Authorization: "Bearer synthetic-remote-header" } },
      authorization: "Bearer synthetic-remote-header",
      expectedHeaders: {},
    },
    {
      name: "different destination accepts its own API key header",
      remote: { headers: { "api-key": "synthetic-destination-key" } },
      authorization: undefined,
      expectedHeaders: { "api-key": "synthetic-destination-key" },
    },
    {
      name: "different destination may be intentionally unauthenticated",
      remote: {},
      authorization: undefined,
      expectedHeaders: {},
    },
    {
      name: "explicit remote Authorization takes precedence over a simultaneous remote API key",
      remote: {
        apiKey: "synthetic-ignored-remote-key",
        headers: { Authorization: "Custom synthetic-remote-header" },
      },
      authorization: "Custom synthetic-remote-header",
      expectedHeaders: {},
    },
    {
      name: "resolved template-looking remote credentials reach HTTP literally",
      remote: {
        apiKey: "${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
        headers: { "X-Literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
      },
      authorization: "Bearer ${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
      expectedHeaders: { "x-literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
    },
  ])(
    "$name",
    async ({
      providerOwnsDestination,
      queryDistinctDestination,
      remote,
      authorization,
      expectedHeaders,
    }) => {
      const result = await openAICompatibleEmbeddingProviderAdapter.create(
        createOptions({
          providerOwnsDestination,
          ...(queryDistinctDestination ? { providerBaseUrl: `${baseUrl}?tenant=provider` } : {}),
          remote: queryDistinctDestination
            ? { ...remote, baseUrl: `${baseUrl}?tenant=remote` }
            : remote,
        }),
      );

      await expect(result.provider?.embed("hello")).resolves.toEqual(vector);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: `/v1/embeddings${queryDistinctDestination ? "?tenant=remote" : ""}`,
        headers: expectedHeaders,
      });
      expect(requests[0]?.headers.authorization).toBe(authorization);
      if (!providerOwnsDestination) {
        expect(requests[0]?.headers).not.toHaveProperty("x-provider-tenant");
        expect(requests[0]?.headers).not.toHaveProperty("x-shared");
      }
    },
  );

  it.each(["apiKey", "header"])("rejects an unresolved remote %s before egress", async (field) => {
    const ref = { source: "env" as const, provider: "default", id: "MISSING_EMBEDDING_SECRET" };
    const remote: NonNullable<EmbeddingProviderCreateOptions["remote"]> =
      field === "apiKey"
        ? { apiKey: ref }
        : { apiKey: "synthetic-remote-key", headers: { "X-Remote-Secret": "" } };
    if (field === "header") {
      Object.assign(remote.headers ?? {}, { "X-Remote-Secret": ref });
    }

    await expect(
      openAICompatibleEmbeddingProviderAdapter.create(createOptions({ remote })),
    ).rejects.toBeInstanceOf(UnresolvedSecretInputError);
    expect(requests).toEqual([]);
  });
});
