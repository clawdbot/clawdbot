import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, assert, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { fetchLmstudioModels } from "./models.fetch.js";
import { discoverLmstudioProvider } from "./setup.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.unstubAllGlobals();
});

describe("LM Studio catalog acquisition", () => {
  function context(headers?: Record<string, string>): ProviderCatalogContext {
    return {
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/api/v1/",
              apiKey: "configured-key",
              headers,
              models: [],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "LM_API_TOKEN",
        discoveryApiKey: "profile-key",
        profileId: "lmstudio:profile",
      }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
  }

  function catalog() {
    const provider = capturePluginRegistration(plugin).providers[0];
    assert(provider?.catalog);
    return provider.catalog.run;
  }

  it.each([401, 403, 503, "disconnect", "invalid-json", "missing-models"])(
    "reports %s as failed acquisition while preserving the public advisory helper",
    async (failure) => {
      const fetchMock = vi.fn(async () => {
        if (failure === "disconnect") {
          throw new Error("connection reset");
        }
        return new Response(failure === "invalid-json" ? "{" : "{}", {
          status: typeof failure === "number" ? failure : 200,
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const ctx = context();
      const rejected = failure === 401 || failure === 403;
      await expect(catalog()(ctx)).resolves.toEqual({
        providers: {},
        outcomes: [
          {
            provider: "lmstudio",
            profileId: "lmstudio:profile",
            status: rejected ? "auth-rejected" : "unavailable",
            ...(rejected ? { rejectionScope: "catalog" } : {}),
          },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:1234/api/v1/models", {
        headers: { Authorization: "Bearer profile-key" },
        signal: expect.any(AbortSignal),
      });
      await expect(discoverLmstudioProvider(ctx)).resolves.toMatchObject({
        provider: { models: [] },
      });
    },
  );

  it("attributes header authentication to the request rather than an unused profile", async () => {
    const fetchMock = vi.fn(async () => new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(catalog()(context({ Authorization: "Bearer header-key" }))).resolves.toEqual({
      providers: {},
      outcomes: [{ provider: "lmstudio", status: "auth-rejected", rejectionScope: "catalog" }],
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:1234/api/v1/models", {
      headers: { Authorization: "Bearer header-key" },
      signal: expect.any(AbortSignal),
    });
  });

  it("distinguishes configured keyless empty inventory from quiet optional discovery", async () => {
    const fetchMock = vi.fn(async () => Response.json({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();
    ctx.resolveProviderApiKey = () => ({ apiKey: undefined });
    const provider = ctx.config.models?.providers?.lmstudio;
    assert(provider);
    delete provider.apiKey;
    await expect(catalog()(ctx)).resolves.toMatchObject({
      provider: { models: [] },
      outcomes: [{ provider: "lmstudio", status: "ready" }],
    });
    await expect(discoverLmstudioProvider(ctx)).resolves.toBeNull();
    ctx.config = {};
    await expect(catalog()(ctx)).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("optional server offline"));
    await expect(catalog()(ctx)).resolves.toBeNull();
    fetchMock.mockClear();
    await expect(
      catalog()({ ...context(), providerIds: ["another-provider"] }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LM Studio model response release", () => {
  const cancelTrackedResponse = (
    text: string,
    init: ResponseInit,
  ): {
    response: Response;
    wasCanceled: () => boolean;
  } => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        canceled = true;
      },
    });
    return {
      response: new Response(stream, init),
      wasCanceled: () => canceled,
    };
  };

  it.each([false, true])(
    "releases guarded non-ok discovery without waiting for capture (retained clone: %s)",
    async (retainCaptureClone) => {
      const tracked = cancelTrackedResponse("unavailable", { status: 503 });
      const captureClone = retainCaptureClone ? tracked.response.clone() : undefined;
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValue({ response: tracked.response, release });
      const request = fetchLmstudioModels({
        baseUrl: "http://localhost:1234/v1",
        ssrfPolicy: {},
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("LM Studio cleanup waited for the capture clone")),
              500,
            );
          }),
        ]);
        expect(result).toMatchObject({ reachable: true, status: 503, models: [] });
        expect(tracked.response.bodyUsed).toBe(true);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        clearTimeout(timeout);
        await captureClone?.body?.cancel().catch(() => undefined);
        await request;
      }
      expect(tracked.wasCanceled()).toBe(true);
    },
  );
});
