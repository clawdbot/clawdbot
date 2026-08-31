import { createServer } from "node:http";
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
import { fetchWithSsrFGuard } from "./ssrf-runtime.js";

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["resolved-provider-key", "ollama-local", "OLLAMA_API_KEY", NON_ENV_SECRETREF_MARKER])(
    "fetches and dedupes live model ids with opaque resolved auth %s",
    async (discoveryApiKey) => {
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
          apiKey: NON_ENV_SECRETREF_MARKER,
          discoveryApiKey,
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
      expect((headers as Headers).get("authorization")).toBe(`Bearer ${discoveryApiKey}`);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

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

  it.each([
    ["first", false, 1],
    ["second", true, 2],
  ] as const)(
    "contextualizes malformed JSON on the %s catalog page",
    async (_name, paginate, calls) => {
      const credential = "reflected-fake-catalog-credential";
      const release = vi.fn(async () => undefined);
      const malformed = {
        response: new Response(credential),
        finalUrl: paginate
          ? "https://provider.example.test/v1/models?page=2"
          : "https://provider.example.test/v1/models",
        release,
      };
      const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = paginate
        ? vi
            .fn()
            .mockResolvedValueOnce({
              response: new Response(
                JSON.stringify({
                  data: [{ id: "model-a", object: "model" }],
                  next: "/v1/models?page=2",
                }),
              ),
              finalUrl: "https://provider.example.test/v1/models",
              release,
            })
            .mockResolvedValueOnce(malformed)
        : vi.fn().mockResolvedValueOnce(malformed);

      const error = await fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: credential,
        fetchGuard: fetchGuardMock,
      }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        message: "provider model discovery: malformed JSON response",
      });
      expect(String((error as Error).cause)).not.toContain(credential);
      expect(fetchGuardMock).toHaveBeenCalledTimes(calls);
      expect(release).toHaveBeenCalledTimes(calls);
    },
  );

  it("contextualizes paginated malformed JSON through the guarded network path", async () => {
    const credential = "reflected-fake-network-credential";
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      expect(request.headers.authorization).toBe(`Bearer ${credential}`);
      response.setHeader("content-type", "application/json");
      response.end(
        requests === 1
          ? JSON.stringify({
              data: [{ id: "model-a", object: "model" }],
              next: "/models?page=2",
            })
          : credential,
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected local test server address");
    }
    const endpoint = `http://127.0.0.1:${address.port}/models`;
    const fetchGuard: LiveModelCatalogFetchGuard = async (params) =>
      await fetchWithSsrFGuard({
        ...params,
        dispatcherPolicy: { mode: "direct" },
      });

    try {
      const error = await fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint,
        apiKey: credential,
        fetchGuard,
        policy: { allowPrivateNetwork: true, allowedOrigins: [new URL(endpoint).origin] },
        requireHttps: false,
      }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        message: "provider model discovery: malformed JSON response",
      });
      expect(String((error as Error).cause)).not.toContain(credential);
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
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

});
