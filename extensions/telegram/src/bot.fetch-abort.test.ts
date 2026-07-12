// Telegram tests cover bot.fetch abort plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { getTelegramNetworkErrorOrigin } from "./network-errors.js";

const { botCtorSpy, telegramBotDepsForTest, telegramBotRuntimeForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore: createTelegramBotBase, setTelegramBotRuntimeForTest } =
  await import("./bot-core.js");
setTelegramBotRuntimeForTest(
  telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
);
const createTelegramBot = (opts: import("./bot.types.js").TelegramBotOptions) =>
  createTelegramBotBase({
    ...opts,
    telegramDeps: telegramBotDepsForTest,
  });

function createWrappedTelegramClientFetch(
  proxyFetch: typeof fetch,
  config?: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig,
) {
  const shutdown = new AbortController();
  botCtorSpy.mockClear();
  createTelegramBot({
    token: "tok",
    ...(config ? { config } : {}),
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

  it("tags wrapped Telegram fetch failures with the Bot API method", async () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const fetchSpy = vi.fn(async () => {
      throw fetchError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      fetchError,
    );
    expect(getTelegramNetworkErrorOrigin(fetchError)).toEqual({
      method: "getupdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates",
    });
  });

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

  it("lets configured timeoutSeconds extend outbound method guards", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch } = createWrappedTelegramClientFetch(
      fetchSpy as unknown as typeof fetch,
      {
        channels: { telegram: { timeoutSeconds: 90 } },
      } as never,
    );

    const observedSignalPromise = clientFetch(
      "https://api.telegram.org/bot123456:ABC/editMessageText",
    );
    await vi.advanceTimersByTimeAsync(90_000);
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
    vi.useRealTimers();
  });

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
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("Misdirected Request", { status: 421 }))
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

  it("preserves the original fetch error when tagging cannot attach metadata", async () => {
    const frozenError = Object.freeze(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect timeout"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    );
    const fetchSpy = vi.fn(async () => {
      throw toLintErrorObject(frozenError, "Non-Error thrown");
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      frozenError,
    );
    expect(getTelegramNetworkErrorOrigin(frozenError)).toBeNull();
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
