// Telegram tests cover bot.fetch abort plugin behavior.
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { TelegramRequestNotStartedError } from "./network-errors.js";

const { botCtorSpy, telegramBotDepsForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const createTelegramBot = (opts: import("./bot.types.js").TelegramBotOptions) =>
  createTelegramBotBase({
    ...opts,
    telegramDeps: telegramBotDepsForTest,
  });

function createWrappedTelegramClientFetch(proxyFetch: typeof fetch) {
  const shutdown = new AbortController();
  botCtorSpy.mockClear();
  createTelegramBot({
    token: "tok",
    fetchAbortSignal: shutdown.signal,
    proxyFetch,
  });
  const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
    ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
  expect(clientFetch).toBeTypeOf("function");
  return { clientFetch, shutdown };
}

function createWrappedTelegramClientFetchWithTransport(params: {
  fetch: typeof fetch;
  forceFallback?: (reason: string) => boolean;
}) {
  const shutdown = new AbortController();
  botCtorSpy.mockClear();
  createTelegramBot({
    token: "tok",
    fetchAbortSignal: shutdown.signal,
    telegramTransport: {
      fetch: params.fetch,
      sourceFetch: params.fetch,
      close: async () => undefined,
      ...(params.forceFallback ? { forceFallback: params.forceFallback } : {}),
    },
  });
  const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
    ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
  expect(clientFetch).toBeTypeOf("function");
  return { clientFetch, shutdown };
}

describe("createTelegramBot fetch abort", () => {
  it("aborts wrapped client fetch when fetchAbortSignal aborts", async () => {
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch, shutdown } = createWrappedTelegramClientFetch(
      fetchSpy as unknown as typeof fetch,
    );

    const observedSignalPromise = clientFetch("https://example.test");
    shutdown.abort(new Error("shutdown"));
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
  });

  it("keeps the getChat deadline active until its response body settles", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            observedSignal?.addEventListener(
              "abort",
              () => controller.error(observedSignal?.reason),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as typeof fetch);

    const response = (await clientFetch(
      "https://api.telegram.org/bot123456:ABC/getChat",
    )) as Response;
    const body = response.json();
    void body.catch(() => undefined);

    try {
      await vi.advanceTimersByTimeAsync(15_000);

      expect(observedSignal?.aborted).toBe(true);
      await expect(body).rejects.toThrow("Telegram getchat timed out after 15000ms");
    } finally {
      if (!observedSignal?.aborted) {
        bodyController?.error(new Error("test cleanup"));
      }
      await body.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it.each(["shutdown", "request"] as const)(
    "keeps %s cancellation attached while a response body is being read",
    async (cancellationSource) => {
      let observedSignal: AbortSignal | undefined;
      const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              observedSignal?.addEventListener(
                "abort",
                () => controller.error(observedSignal?.reason),
                { once: true },
              );
            },
          }),
        );
      });
      const { clientFetch, shutdown } = createWrappedTelegramClientFetch(fetchSpy as typeof fetch);
      const request = new AbortController();
      const response = (await clientFetch("https://api.telegram.org/bot123456:ABC/getChat", {
        signal: request.signal,
      })) as Response;
      const body = response.text();
      void body.catch(() => undefined);

      const cancellation = cancellationSource === "shutdown" ? shutdown : request;
      cancellation.abort(new Error(`${cancellationSource} cancelled`));

      expect(observedSignal?.aborted).toBe(true);
      await expect(body).rejects.toThrow(`${cancellationSource} cancelled`);
    },
  );

  it("aborts wrapped getUpdates fetch after the hard polling timeout", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    const observedSignalPromise = clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates");
    await vi.advanceTimersByTimeAsync(45_000);
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
    vi.useRealTimers();
  });

  it.each(["sendMessage", "answerCallbackQuery"])(
    "uses the 60-second outbound guard for %s",
    async (method) => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<AbortSignal>((resolve) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener("abort", () => resolve(signal), { once: true });
          }),
      );
      const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

      const observedSignalPromise = clientFetch(`https://api.telegram.org/bot123456:ABC/${method}`);
      await vi.advanceTimersByTimeAsync(60_000);
      const observedSignal = (await observedSignalPromise) as AbortSignal;

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal.aborted).toBe(true);
      vi.useRealTimers();
    },
  );

  it("retries timed-out control calls once after forcing transport fallback", async () => {
    vi.useFakeTimers();
    const forceFallback = vi.fn(() => true);
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener(
              "abort",
              () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({ ok: true } as Response);
    const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
      fetch: fetchSpy as unknown as typeof fetch,
      forceFallback,
    });

    const resultPromise = clientFetch("https://api.telegram.org/bot123456:ABC/deleteWebhook");
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(forceFallback).toHaveBeenCalledWith("request-timeout");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it.each(["deleteMyCommands", "setMyCommands"])(
    "retries timed-out command sync call %s once after forcing transport fallback",
    async (method) => {
      vi.useFakeTimers();
      const forceFallback = vi.fn(() => true);
      const fetchSpy = vi
        .fn()
        .mockImplementationOnce(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal as AbortSignal;
              signal.addEventListener(
                "abort",
                () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
                { once: true },
              );
            }),
        )
        .mockResolvedValueOnce({ ok: true } as Response);
      const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
        fetch: fetchSpy as unknown as typeof fetch,
        forceFallback,
      });

      const resultPromise = clientFetch(`https://api.telegram.org/bot123456:ABC/${method}`);
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(resultPromise).resolves.toEqual({ ok: true });
      expect(forceFallback).toHaveBeenCalledWith("request-timeout");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    },
  );

  it("retries timed-out sendChatAction once after forcing transport fallback", async () => {
    vi.useFakeTimers();
    const forceFallback = vi.fn(() => true);
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener(
              "abort",
              () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({ ok: true } as Response);
    const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
      fetch: fetchSpy as unknown as typeof fetch,
      forceFallback,
    });

    const resultPromise = clientFetch("https://api.telegram.org/bot123456:ABC/sendChatAction");
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(forceFallback).toHaveBeenCalledWith("request-timeout");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries Telegram 421 responses after forcing transport fallback", async () => {
    const forceFallback = vi.fn(() => true);
    const cancelMisdirectedBody = vi.fn();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel: cancelMisdirectedBody }), {
          status: 421,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
      fetch: fetchSpy as typeof fetch,
      forceFallback,
    });

    const result = await clientFetch("https://api.telegram.org/bot123456:ABC/sendMessage");

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(forceFallback).toHaveBeenCalledWith("misdirected-request");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(cancelMisdirectedBody).toHaveBeenCalledOnce();
  });

  it.each([
    ["without fallback", false],
    ["after one fallback", true],
  ])(
    "rejects a terminal actual 421 %s and cancels every response body",
    async (_name, fallback) => {
      const cancelBodies = Array.from({ length: fallback ? 2 : 1 }, () => vi.fn());
      const fetchSpy = vi.fn();
      for (const cancel of cancelBodies) {
        fetchSpy.mockResolvedValueOnce(
          new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 421 }),
        );
      }
      const forceFallback = fallback ? vi.fn(() => true) : undefined;
      const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
        fetch: fetchSpy as typeof fetch,
        ...(forceFallback ? { forceFallback } : {}),
      });

      await expect(
        clientFetch("https://api.telegram.org/bot123456:ABC/sendMessage"),
      ).rejects.toBeInstanceOf(TelegramRequestNotStartedError);

      expect(fetchSpy).toHaveBeenCalledTimes(cancelBodies.length);
      for (const cancel of cancelBodies) {
        expect(cancel).toHaveBeenCalledOnce();
      }
    },
  );

  it("retries Telegram 421 fetch errors after forcing transport fallback", async () => {
    const forceFallback = vi.fn(() => true);
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("421 Misdirected Request"), { status: 421 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
      fetch: fetchSpy as typeof fetch,
      forceFallback,
    });

    const result = await clientFetch("https://api.telegram.org/bot123456:ABC/sendMessage");

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(forceFallback).toHaveBeenCalledWith("misdirected-request");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps a thrown 421-shaped edge error distinct from request-not-started custody", async () => {
    const edgeError = Object.assign(new Error("421 Misdirected Request"), { status: 421 });
    const forceFallback = vi.fn(() => false);
    const fetchSpy = vi.fn().mockRejectedValue(edgeError);
    const { clientFetch } = createWrappedTelegramClientFetchWithTransport({
      fetch: fetchSpy as typeof fetch,
      forceFallback,
    });

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/sendMessage")).rejects.toBe(
      edgeError,
    );
    expect(edgeError).not.toBeInstanceOf(TelegramRequestNotStartedError);
    expect(forceFallback).toHaveBeenCalledWith("misdirected-request");
  });
});
