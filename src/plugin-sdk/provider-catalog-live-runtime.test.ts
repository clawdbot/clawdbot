import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelIds,
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function buildFetchGuard(body: unknown): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://provider.example.test/v1/models",
    release,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock, release };
}

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and dedupes OpenAI-style live model ids with resolved discovery auth", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { fetchGuard, fetchGuardMock, release } = buildFetchGuard({
      data: [
        { id: "model-a", object: "model" },
        { id: "model-b", object: "model" },
        { id: "embedding-a", object: "embedding" },
        { id: "model-a", object: "model" },
      ],
    });
    const controller = new AbortController();

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: "PROVIDER_API_KEY",
        discoveryApiKey: "resolved-provider-key",
        fetchGuard,
        signal: controller.signal,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    const request = fetchGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "https://provider.example.test/v1/models",
      auditContext: "provider-model-discovery",
      timeoutMs: 1234,
      signal: controller.signal,
    });
    const headers = request?.init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer resolved-provider-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not send non-secret SecretRef markers as live catalog bearer tokens", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({ data: [] });
    const buildRequestHeaders = vi.fn(({ apiKey, discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: NON_ENV_SECRETREF_MARKER,
        fetchGuard,
        buildRequestHeaders,
      }),
    ).resolves.toEqual([]);

    expect(buildRequestHeaders).toHaveBeenCalledWith({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBeNull();
    expect((headers as Headers).get("x-api-key")).toBeNull();
  });

  it("supports top-level array bodies and custom row readers", async () => {
    const { fetchGuard } = buildFetchGuard([
      { slug: "custom-a" },
      { slug: "custom-b" },
      { slug: "custom-a" },
    ]);

    await expect(
      fetchLiveProviderModelIds({
        providerId: "custom",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard,
        readModelId: (row) =>
          row && typeof row === "object" && "slug" in row && typeof row.slug === "string"
            ? row.slug
            : undefined,
      }),
    ).resolves.toEqual(["custom-a", "custom-b"]);
  });

  it("accepts UTF-8 BOM-prefixed catalog responses", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response("\uFEFF" + JSON.stringify({ data: [{ id: "model-a" }] })),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("follows next_cursor pagination before projecting model ids", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            has_more: true,
            next_cursor: "cursor-2",
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "model-b", object: "model" }], has_more: false }),
        ),
        finalUrl: "https://provider.example.test/v1/models?after=cursor-2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?after=cursor-2",
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("follows Anthropic-style last_id pagination", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            has_more: true,
            last_id: "model-a",
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "model-b", object: "model" }], has_more: false }),
        ),
        finalUrl: "https://provider.example.test/v1/models?after_id=model-a",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?after_id=model-a",
    );
  });

  it("follows absolute next links when providers return them", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            next: "https://provider.example.test/v1/models?page=2",
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models?page=2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?page=2",
    );
  });

  it("follows nested links.next pagination when providers return it", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            links: { next: "/v1/models?page=2" },
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models?page=2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?page=2",
    );
  });

  it("resolves relative pagination links against the guarded fetch final URL", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            links: { next: "?page=2" },
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models/",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models/?page=2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models/?page=2",
    );
  });

  it("does not re-add credentials to redirected-origin pagination requests", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            links: { next: "?page=2" },
          }),
        ),
        finalUrl: "https://redirected.example.test/v1/models/",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://redirected.example.test/v1/models/?page=2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        discoveryApiKey: "provider-token",
        fetchGuard: fetchGuardMock,
        buildRequestHeaders: ({ discoveryApiKey }) => ({
          Accept: "application/json",
          ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
          "ChatGPT-Account-ID": "acct-1",
        }),
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    const firstHeaders = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    const secondHeaders = fetchGuardMock.mock.calls[1]?.[0].init?.headers;
    expect(firstHeaders).toBeInstanceOf(Headers);
    expect(secondHeaders).toBeInstanceOf(Headers);
    expect((firstHeaders as Headers).get("authorization")).toBe("Bearer provider-token");
    expect((firstHeaders as Headers).get("chatgpt-account-id")).toBe("acct-1");
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://redirected.example.test/v1/models/?page=2",
    );
    expect((secondHeaders as Headers).get("authorization")).toBeNull();
    expect((secondHeaders as Headers).get("chatgpt-account-id")).toBeNull();
    expect((secondHeaders as Headers).get("accept")).toBe("application/json");
  });

  it("follows nextPageToken pagination before projecting model ids", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            nextPageToken: "page-2",
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models?pageToken=page-2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?pageToken=page-2",
    );
  });

  it("follows next_page_token pagination with the matching query parameter", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            next_page_token: "page-2",
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models?page_size=1000",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models?page_size=1000&page_token=page-2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models?page_size=1000",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?page_size=1000&page_token=page-2",
    );
  });

  it("fails truncated live catalog pagination instead of returning partial rows", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async ({ url }) => {
      const page = Number(new URL(url).searchParams.get("after") ?? "0");
      return {
        response: new Response(
          JSON.stringify({
            data: [{ id: `model-${page}`, object: "model" }],
            has_more: true,
            next_cursor: String(page + 1),
          }),
        ),
        finalUrl: url,
        release,
      };
    });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow("provider model discovery exceeded 50 pages before the catalog completed");

    expect(fetchGuardMock).toHaveBeenCalledTimes(50);
    expect(release).toHaveBeenCalledTimes(50);
  });

  it("fails explicit incomplete live catalog pagination without a supported next page", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
          has_more: true,
        }),
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses one timeout budget across paginated live catalog discovery", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => undefined);
      const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
        .fn()
        .mockImplementationOnce(async () => {
          await vi.advanceTimersByTimeAsync(800);
          return {
            response: new Response(
              JSON.stringify({
                data: [{ id: "model-a", object: "model" }],
                has_more: true,
                next_cursor: "cursor-2",
              }),
            ),
            finalUrl: "https://provider.example.test/v1/models",
            release,
          };
        })
        .mockImplementationOnce(async () => ({
          response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
          finalUrl: "https://provider.example.test/v1/models?after=cursor-2",
          release,
        }));

      await expect(
        fetchLiveProviderModelIds({
          providerId: "provider",
          endpoint: "https://provider.example.test/v1/models",
          fetchGuard: fetchGuardMock,
          timeoutMs: 1_000,
        }),
      ).resolves.toEqual(["model-a", "model-b"]);

      expect(fetchGuardMock).toHaveBeenCalledTimes(2);
      expect(fetchGuardMock.mock.calls[0]?.[0].timeoutMs).toBe(1_000);
      expect(fetchGuardMock.mock.calls[1]?.[0].timeoutMs).toBe(200);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches raw live model rows for provider-specific projection", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      models: [{ slug: "custom-a" }, { slug: "custom-b" }],
    });

    const first = await getCachedLiveProviderModelRows({
      providerId: "custom",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard,
      ttlMs: 60_000,
      readRows: (body) =>
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [],
    });
    const second = await getCachedLiveProviderModelRows({
      providerId: "custom",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard,
      ttlMs: 60_000,
      readRows: (body) =>
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [],
    });

    expect(first).toEqual([{ slug: "custom-a" }, { slug: "custom-b" }]);
    expect(second).toEqual(first);
    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("bounds an unbounded live catalog success stream and cancels the body", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelled = false;
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pullCount += 1;
            // Stream a JSON array prefix followed by an effectively endless run of
            // padding so the body never terminates under its own power.
            if (pullCount === 1) {
              controller.enqueue(encoder.encode('[{"id":"model-a","object":"model"},'));
              return;
            }
            controller.enqueue(encoder.encode("0".repeat(1024 * 1024)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard: fetchGuardMock,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Live model catalog response exceeded \d+ bytes/);
    expect(cancelled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled live catalog success stream", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let cancelReason: unknown;
      const release = vi.fn(async () => undefined);
      const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Emit a partial JSON prefix and then idle forever without closing.
              controller.enqueue(encoder.encode('[{"id":"model-a",'));
            },
            cancel(reason) {
              cancelReason = reason;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      }));

      const resultPromise = fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
        timeoutMs: 1234,
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1234);
      const error = await resultPromise;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Live model catalog response stalled: no data received for 1234ms",
      );
      expect(cancelReason).toBeInstanceOf(Error);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws structured HTTP errors after releasing guarded fetches", async () => {
    const release = vi.fn(async () => undefined);
    const response = new Response("{}", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response,
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard: fetchGuardMock,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LiveModelCatalogHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed UTF-8 bytes in live catalog responses and falls back to static rows", async () => {
    // Build raw bytes with a 0xFE byte inside the JSON payload — 0xFE is never
    // a valid UTF-8 lead byte, so fatal:true throws before JSON.parse.
    const encoder = new TextEncoder();
    const prefix = encoder.encode('{"data":[{"id":"model-a","label":"test-');
    const suffix = encoder.encode('"}]}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix, 0);
    // Inject an invalid UTF-8 byte before the suffix
    body[prefix.length] = 0xfe;
    body.set(suffix, prefix.length + 1);

    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(body),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const result = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      fetchGuard: fetchGuardMock,
      models,
    });

    // The malformed UTF-8 causes readLiveModelCatalogJson to throw.
    // buildLiveModelProviderConfig should catch it and return the static catalog.
    expect(result.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
    expect(result.apiKey).toBe("PROVIDER_API_KEY");
    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("caches live provider configs and falls back to static rows on failure", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard([
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
    ]);
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const first = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });
    const second = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("PROVIDER_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(second.models.map((model) => model.id)).toEqual(["model-b"]);

    clearLiveCatalogCacheForTests();
    fetchGuardMock.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
    });

    expect(fallback.apiKey).toBe("PROVIDER_API_KEY");
    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
  });

  it("does not cache empty live provider config discoveries", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [] })),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      });
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      fetchGuard: fetchGuardMock,
      models,
      ttlMs: 60_000,
    });
    const recovered = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      fetchGuard: fetchGuardMock,
      models,
      ttlMs: 60_000,
    });

    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(recovered.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });

  it("builds newly listed text models from OpenAI-compatible catalog metadata", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      data: [
        {
          id: "chat-v2",
          object: "model",
          active: true,
          context_window: 262_144,
          max_completion_tokens: 32_768,
          input_modalities: ["text", "image"],
          features: ["reasoning"],
        },
        { id: "text-embedding-4", object: "model" },
        { id: "gpt-image-2-oai", object: "model" },
        { id: "retired-chat", object: "model", active: false },
        { id: "archived-chat", object: "model", archived: true },
        { id: "deprecated-chat", object: "model", deprecated: true },
        {
          id: "fim-only",
          object: "model",
          capabilities: { completion_chat: false, completion_fim: true },
        },
        { id: "image-generation-v2", object: "model", features: ["image_generation"] },
        {
          id: "chat-and-image-v2",
          object: "model",
          capabilities: { completion_chat: true },
          features: ["image_generation"],
        },
        {
          id: "image-only",
          object: "model",
          output_modalities: ["image"],
        },
      ],
    });

    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1/",
        models: [buildModel("chat-v1")],
      },
      apiKey: "provider-key",
      fetchGuard,
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ id: "chat-and-image-v2" }),
      expect.objectContaining({
        id: "chat-v2",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 32_768,
      }),
    ]);
    expect(fetchGuardMock.mock.calls[0]?.[0].url).toBe("https://provider.example.test/v1/models");
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer provider-key");
  });

  it("keeps trusted static metadata for live ids already in the provider seed", async () => {
    const { fetchGuard } = buildFetchGuard({
      data: [{ id: "chat-v1", object: "model", context_window: 1 }],
    });
    const seed = buildModel("chat-v1");

    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        models: [seed],
      },
      fetchGuard,
    });

    expect(provider.models).toEqual([seed]);
  });

  it("supports provider-specific model-list paths and headers", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      data: [{ id: "claude-next", object: "model" }],
    });

    await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "anthropic-style",
      providerConfig: {
        api: "anthropic-messages",
        baseUrl: "https://provider.example.test",
        models: [buildModel("claude-current")],
      },
      apiKey: "provider-key",
      modelDiscovery: {
        endpointPath: "v1/models",
        buildRequestHeaders: ({ apiKey }) => ({
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        }),
      },
      fetchGuard,
    });

    expect(fetchGuardMock.mock.calls[0]?.[0].url).toBe("https://provider.example.test/v1/models");
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-api-key")).toBe("provider-key");
    expect((headers as Headers).get("anthropic-version")).toBe("2023-06-01");
  });

  it("does not send credentials to a fixed discovery endpoint after a base URL override", async () => {
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn();
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://private-proxy.example.test/v1",
      models: [buildModel("chat-current")],
    };

    await expect(
      buildOpenAICompatibleLiveModelProviderConfig({
        providerId: "provider",
        providerConfig,
        apiKey: "private-proxy-key",
        modelDiscovery: {
          endpointUrl: {
            url: "https://provider.example.test/v1/models",
            requireBaseUrl: "https://provider.example.test/v1",
          },
        },
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual({ ...providerConfig, apiKey: "private-proxy-key" });

    expect(fetchGuardMock).not.toHaveBeenCalled();
  });

  it("reports incomplete pagination on malformed absolute next URL with no usable fallback", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
          // Space in hostname makes this a genuinely invalid absolute URL.
          next: "http://exa mple.com/models?page=2",
          has_more: false,
        }),
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    // The provider explicitly advertised a next page via the `next` field but
    // the URL is malformed and there is no cursor fallback. The controlled
    // incomplete-pagination error prevents silently returning a truncated
    // catalog.
    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("reports incomplete pagination on malformed nested links.next URL", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
          links: { next: "http://exa mple.com/models?page=2" },
          has_more: false,
        }),
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("recovers malformed next URL via cursor fallback", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            next: "http://exa mple.com/models?page=2",
            next_cursor: "cursor-2",
            has_more: true,
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "model-b", object: "model" }], has_more: false }),
        ),
        finalUrl: "https://provider.example.test/v1/models?after=cursor-2",
        release,
      });

    // The malformed next URL is ignored; cursor-based pagination takes over.
    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?after=cursor-2",
    );
  });

  it("sets safe replay headers when final URL is unparseable", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
        }),
      ),
      // An unparseable finalUrl should trigger safe replay headers (conservative
      // cross-origin assumption), not crash.
      finalUrl: "http://exa mple.com/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("reports incomplete pagination instead of crashing on malformed next URL with has_more", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
          next: "http://exa mple.com/models?page=2",
          has_more: true,
        }),
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });
});
