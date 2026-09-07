import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import {
  fetchBrowserScreenshotDataUrl,
  requestBrowserScreencast,
  isBrowserScreencastUnsupportedError,
} from "./browser-client.ts";

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

describe("fetchBrowserScreenshotDataUrl", () => {
  it("returns the fetched screenshot as a data URL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const screenshot = new Blob(["image-bytes"], { type: "image/png" });
    const fetchMock = vi.fn<typeof fetch>(
      async () => ({ ok: true, blob: async () => screenshot }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "",
        authToken: null,
        path: "/tmp/browser shot.png",
      }),
    ).resolves.toBe("data:image/png;base64,aW1hZ2UtYnl0ZXM=");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/__openclaw__/assistant-media?source=%2Ftmp%2Fbrowser+shot.png",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsuccessful screenshot responses", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("Screenshot fetch failed (404).");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an unsuccessful screenshot response body", async () => {
    vi.useFakeTimers();
    const response = new Response("not found", { status: 404 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("Screenshot fetch failed (404).");
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an unsuccessful screenshot without waiting for stream cancellation", async () => {
    vi.useFakeTimers();
    const response = new Response("not found", { status: 404 });
    const cancel = vi
      .spyOn(response.body!, "cancel")
      .mockImplementation(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("Screenshot fetch failed (404).");
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled screenshot fetch after the request deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing screenshot fetch signal");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            // Fetch rejects with the exact abort reason. DOM types define it as an Error,
            // although jsdom does not preserve that prototype relationship at runtime.
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBrowserScreenshotDataUrl({
      resourceBasePath: "/openclaw",
      authToken: null,
      path: "/tmp/browser shot.png",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fbrowser+shot.png");
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
  });

  it("aborts a stalled screenshot body after the request deadline", async () => {
    vi.useFakeTimers();
    let bodyReadStarted = false;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing screenshot fetch signal");
      }
      return {
        ok: true,
        blob: async () => {
          bodyReadStarted = true;
          return await new Promise<Blob>((_resolve, reject) => {
            const rejectWithAbortReason = () => reject(signal.reason as Error);
            if (signal.aborted) {
              rejectWithAbortReason();
              return;
            }
            signal.addEventListener("abort", rejectWithAbortReason, { once: true });
          });
        },
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBrowserScreenshotDataUrl({
      resourceBasePath: "/openclaw",
      authToken: null,
      path: "/tmp/browser shot.png",
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyReadStarted).toBe(true);
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
  });

  it("localizes screenshot failures while preserving the HTTP status", async () => {
    i18n.registerTranslation("pt-BR", {
      browser: {
        errors: {
          screenshotFetchFailed: "Falha ao buscar captura de tela ({status}).",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("Falha ao buscar captura de tela (503).");
  });
});

describe("browser screencast requests", () => {
  it.each([
    null,
    {},
    { token: "", wsPath: "/browser/screencast" },
    { token: 123, wsPath: "/browser/screencast" },
    { token: "token" },
    { token: "token", wsPath: "" },
    { token: "token", wsPath: 123 },
  ])("rejects a malformed mint response (%j)", async (response) => {
    await expect(
      requestBrowserScreencast(
        { request: vi.fn().mockResolvedValue(response) },
        { targetId: "tab-a", maxWidth: 1280, maxHeight: 1600 },
      ),
    ).rejects.toThrow("browser screencast response is malformed");
  });

  it("normalizes absent or invalid optional metadata to empty strings", async () => {
    const response = { token: "token", wsPath: "/browser/screencast?token=token", url: 123 };
    await expect(
      requestBrowserScreencast(
        { request: vi.fn().mockResolvedValue(response) },
        { targetId: "tab-a", maxWidth: 1280, maxHeight: 1600 },
      ),
    ).resolves.toEqual({ ...response, targetId: "", url: "" });
  });

  it("mints an HTTP-shaped request with the requested target and size", async () => {
    const response = {
      token: "token",
      wsPath: "/browser/screencast?token=token",
      targetId: "raw-a",
      url: "https://example.test",
    };
    const request = vi.fn().mockResolvedValue(response);
    await expect(
      requestBrowserScreencast({ request }, { targetId: "tab-a", maxWidth: 1280, maxHeight: 1600 }),
    ).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith("browser.request", {
      method: "POST",
      path: "/screencast",
      body: { targetId: "tab-a", maxWidth: 1280, maxHeight: 1600 },
    });
  });

  it.each([
    [
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Unsupported",
        details: { code: "SCREENCAST_UNSUPPORTED", reason: "node" },
      }),
      true,
    ],
    [{ body: { code: "SCREENCAST_UNSUPPORTED" } }, true],
    [{ details: { body: { code: "SCREENCAST_UNSUPPORTED" } } }, true],
    [new Error("SCREENCAST_UNSUPPORTED"), false],
    [{ details: { code: "OTHER" } }, false],
  ])("recognizes structured unsupported failures (%s)", (error, expected) => {
    expect(isBrowserScreencastUnsupportedError(error)).toBe(expected);
  });
});
