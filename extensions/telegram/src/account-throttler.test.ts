// Telegram tests cover account throttler plugin behavior.
import { Api } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";

type TelegramTransform = ReturnType<typeof getOrCreateAccountThrottler>;
type TelegramPreviousCall = Parameters<TelegramTransform>[0];

function callLooseSendMessage(
  throttler: TelegramTransform,
  prev: TelegramPreviousCall,
  payload: Record<string, unknown>,
) {
  const loose = throttler as (
    prev: TelegramPreviousCall,
    method: "sendMessage",
    payload: unknown,
    signal: undefined,
  ) => ReturnType<TelegramTransform>;
  return loose(prev, "sendMessage", payload, undefined);
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve: resolve! };
}

describe("getOrCreateAccountThrottler", () => {
  beforeEach(() => {
    resetTelegramAccountThrottlersForTest();
  });

  it("shares throttlers per bot token", () => {
    const first = getOrCreateAccountThrottler("tok");
    const second = getOrCreateAccountThrottler("tok");
    const other = getOrCreateAccountThrottler("other");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("preserves the group message budget while sending topic actions", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const api = new Api("123:typing-budget", {
      fetch: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.slice(url.lastIndexOf("/") + 1);
        sent.push(method);
        return new Response(
          JSON.stringify({
            ok: true,
            result:
              method === "sendChatAction"
                ? true
                : {
                    message_id: sent.length,
                    date: 0,
                    chat: { id: -100123, type: "supergroup", title: "Topics" },
                    text: "Complete",
                  },
          }),
        );
      },
    });
    api.config.use(getOrCreateAccountThrottler("typing-budget"));
    const actions = Array.from({ length: 21 }, (_, index) =>
      api.sendChatAction(-100123, "typing", { message_thread_id: index + 1 }),
    );
    const replies = Array.from({ length: 21 }, () => api.sendMessage(-100123, "Complete"));
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(sent.filter((method) => method === "sendChatAction")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(sent.filter((method) => method === "sendChatAction")).toHaveLength(21);
      expect(sent.filter((method) => method === "sendMessage")).toHaveLength(20);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(sent.filter((method) => method === "sendMessage")).toHaveLength(21);
    } finally {
      await vi.advanceTimersByTimeAsync(180_000);
      await Promise.all([...actions, ...replies]);
      vi.useRealTimers();
    }
  });

  it("round-robins group topic requests before entering the Telegram throttler", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "round-robin",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    );
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { message_thread_id?: number; text?: string };
      entered.push(`${request.message_thread_id}:${request.text}`);
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = throttler(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: 10, text: "first" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["10:first"]));

    const secondSameTopic = throttler(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: 10, text: "second" },
      undefined,
    );
    const otherTopic = throttler(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: 20, text: "other" },
      undefined,
    );
    await Promise.resolve();

    expect(entered).toEqual(["10:first"]);
    firstGate.resolve();
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
    expect(entered[1]).toBe("20:other");
    await Promise.all([first, secondSameTopic, otherTopic]);

    expect(entered).toEqual(["10:first", "20:other", "10:second"]);
  });

  it("uses edited message ids as lanes when Telegram omits topic ids", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "edited-message",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    );
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { message_id?: number; text?: string };
      entered.push(`${request.message_id}:${request.text}`);
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = throttler(
      prev,
      "editMessageText",
      { chat_id: -100123, message_id: 101, text: "first-edit" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["101:first-edit"]));

    const secondSameMessage = throttler(
      prev,
      "editMessageText",
      { chat_id: -100123, message_id: 101, text: "second-edit" },
      undefined,
    );
    const otherMessage = throttler(
      prev,
      "editMessageText",
      { chat_id: -100123, message_id: 202, text: "other-edit" },
      undefined,
    );

    firstGate.resolve();
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
    expect(entered[1]).toBe("202:other-edit");
    await Promise.all([first, secondSameMessage, otherMessage]);

    expect(entered).toEqual(["101:first-edit", "202:other-edit", "101:second-edit"]);
  });

  it("does not group-throttle fractional chat ids", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "direct-topic",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    );
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { text?: string };
      entered.push(request.text ?? "");
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = throttler(
      prev,
      "sendMessage",
      { chat_id: "-100123.5", message_thread_id: 10, text: "first" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["first"]));

    const second = throttler(
      prev,
      "sendMessage",
      { chat_id: "-100123.5", message_thread_id: 20, text: "second" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["first", "second"]));

    firstGate.resolve();
    await Promise.all([first, second]);
  });

  it("uses strict decimal string ids for fair group lanes", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "private-chat",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    );
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { message_thread_id?: string; text?: string };
      entered.push(`${request.message_thread_id}:${request.text}`);
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = callLooseSendMessage(throttler, prev, {
      chat_id: "-100123",
      message_thread_id: "+10",
      text: "first",
    });
    await vi.waitFor(() => expect(entered).toEqual(["+10:first"]));

    const sameTopic = callLooseSendMessage(throttler, prev, {
      chat_id: "-100123",
      message_thread_id: "+10",
      text: "second",
    });
    const otherTopic = callLooseSendMessage(throttler, prev, {
      chat_id: "-100123",
      message_thread_id: "0x20",
      text: "hex",
    });

    firstGate.resolve();
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
    expect(entered[1]).toBe("0x20:hex");
    await Promise.all([first, sameTopic, otherTopic]);

    expect(entered).toEqual(["+10:first", "0x20:hex", "+10:second"]);
  });
});
