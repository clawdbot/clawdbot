import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAccountThrottlersForTest,
  createTelegramAccountThrottler,
  getOrCreateAccountThrottler,
} from "./account-throttler.js";

type TelegramPreviousCall = Parameters<ReturnType<typeof createTelegramAccountThrottler>>[0];

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve: resolve! };
}

describe("getOrCreateAccountThrottler", () => {
  beforeEach(() => {
    clearAccountThrottlersForTest();
  });

  it("shares throttlers per bot token", () => {
    const first = getOrCreateAccountThrottler("tok");
    const second = getOrCreateAccountThrottler("tok");
    const other = getOrCreateAccountThrottler("other");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("round-robins group topic requests before entering the Telegram throttler", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = createTelegramAccountThrottler(
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
    const throttler = createTelegramAccountThrottler(
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
});
