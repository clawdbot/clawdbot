// Telegram tests cover stalled diagnostic response body handling.
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { probeTelegram, resetTelegramProbeFetcherCacheForTests } from "./probe.js";

const resolveTelegramTransport = vi.hoisted(() => vi.fn());
const makeProxyFetch = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport,
  resolveTelegramApiBase: (apiRoot?: string) =>
    apiRoot?.trim()?.replace(/\/+$/, "") || "https://api.telegram.org",
}));

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

function installFetchMock(): Mock {
  const fetchMock = vi.fn();
  resolveTelegramTransport.mockImplementation((proxyFetch?: typeof fetch) => ({
    fetch: proxyFetch ?? (fetchMock as unknown as typeof fetch),
    sourceFetch: proxyFetch ?? (fetchMock as unknown as typeof fetch),
    forceFallback: vi.fn().mockReturnValue(true),
    close: async () => {},
  }));
  makeProxyFetch.mockImplementation(() => fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function makeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeStallingJsonResponse(payload: unknown, cancel: (reason?: unknown) => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      },
      cancel,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function makeTricklingJsonResponse(cancel: (reason?: unknown) => void): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0;
        const chunks = ["{", '"ok"', ":", "true", ","];
        const enqueue = () => {
          if (cancelled) {
            return;
          }
          controller.enqueue(encoder.encode(chunks[index % chunks.length]));
          index += 1;
          timer = setTimeout(enqueue, 40);
        };
        enqueue();
      },
      cancel(reason) {
        cancelled = true;
        if (timer) {
          clearTimeout(timer);
        }
        cancel(reason);
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
  return response;
}

describe("probeTelegram response body timeouts", () => {
  afterEach(() => {
    resetTelegramProbeFetcherCacheForTests();
    resolveTelegramTransport.mockReset();
    makeProxyFetch.mockReset();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("fails quickly when getMe returns a stalled response body", async () => {
    const fetchMock = installFetchMock();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeStallingJsonResponse(
        {
          ok: true,
          result: { id: 123, is_bot: true, first_name: "Test", username: "bot" },
        },
        cancel,
      ),
    );

    vi.useFakeTimers();
    const probePromise = probeTelegram("placeholder", 50, {
      includeWebhookInfo: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);

    const result = await probePromise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Telegram diagnostic response body stalled for 25ms");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("fails on the body deadline when getMe trickles without becoming complete JSON", async () => {
    const fetchMock = installFetchMock();
    const cancel = vi.fn();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeTricklingJsonResponse(cancel));

    const probePromise = probeTelegram("placeholder", 100, {
      includeWebhookInfo: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120);

    const result = await probePromise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Telegram diagnostic response body timed out after 100ms");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("keeps webhook diagnostics best-effort when webhookInfo response body stalls", async () => {
    const fetchMock = installFetchMock();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        result: { id: 123, is_bot: true, first_name: "Test", username: "bot" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      makeStallingJsonResponse({ ok: true, result: { url: "https://example.test/hook" } }, cancel),
    );

    vi.useFakeTimers();
    const probePromise = probeTelegram("placeholder", 50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);

    const result = await probePromise;
    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
