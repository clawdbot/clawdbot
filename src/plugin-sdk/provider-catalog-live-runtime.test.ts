import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelIds,
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import { buildLiveCatalogFetchGuard } from "./provider-catalog-live-runtime.test-support.js";

type CompatibleFetchGuardForTest = (params: Parameters<LiveModelCatalogFetchGuard>[0]) => Promise<
  Omit<Awaited<ReturnType<LiveModelCatalogFetchGuard>>, "finalUrl" | "requestHeaders"> & {
    finalUrl?: string;
    requestHeaders?: HeadersInit;
  }
>;

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and dedupes OpenAI-style live model ids with resolved discovery auth", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { fetchGuard, fetchGuardMock, release } = buildLiveCatalogFetchGuard({
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
    const { fetchGuard, fetchGuardMock } = buildLiveCatalogFetchGuard({ data: [] });
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
    const { fetchGuard } = buildLiveCatalogFetchGuard([
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

  it("uses the response URL for redirected pagination when guard metadata is omitted", async () => {
    const release = vi.fn(async () => undefined);
    const firstResponse = new Response(
      JSON.stringify({
        data: [{ id: "model-a", object: "model" }],
        links: { next: "?page=2" },
      }),
    );
    Object.defineProperty(firstResponse, "url", {
      value: "https://redirected.example.test/v1/models/",
    });
    const fetchGuard: CompatibleFetchGuardForTest = vi
      .fn(async ({ url }: Parameters<LiveModelCatalogFetchGuard>[0]) => ({
        response:
          url === "https://provider.example.test/v1/models"
            ? firstResponse
            : new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        release,
      }))
      .mockName("fetchGuard");

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuard as LiveModelCatalogFetchGuard,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(vi.mocked(fetchGuard).mock.calls[1]?.[0].url).toBe(
      "https://redirected.example.test/v1/models/?page=2",
    );
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
    const { fetchGuard, fetchGuardMock } = buildLiveCatalogFetchGuard({
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
