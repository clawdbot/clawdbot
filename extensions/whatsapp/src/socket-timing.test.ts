// Whatsapp tests cover socket timing plugin behavior.
import type { AnyMessageContent, WAMessage } from "baileys";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  WhatsAppSocketOperationTimeoutError,
  createWhatsAppSocketOperationTimeoutAdapter,
  isWhatsAppSocketOperationTimeoutError,
  resolveWhatsAppSocketOperationTimeoutMs,
  resolveWhatsAppSocketTiming,
  withWhatsAppSocketOperationTimeout,
} from "./socket-timing.js";

describe("resolveWhatsAppSocketTiming", () => {
  it("uses OpenClaw's explicit WhatsApp Web socket defaults", () => {
    expect(resolveWhatsAppSocketTiming({})).toEqual(DEFAULT_WHATSAPP_SOCKET_TIMING);
  });

  it("reads Baileys timing values from web.whatsapp config", () => {
    expect(
      resolveWhatsAppSocketTiming({
        web: {
          whatsapp: {
            keepAliveIntervalMs: 10_000,
            connectTimeoutMs: 90_000,
            defaultQueryTimeoutMs: 120_000,
          },
        },
      }),
    ).toEqual({
      keepAliveIntervalMs: 10_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });
  });

  it("lets call-site overrides take precedence over config", () => {
    expect(
      resolveWhatsAppSocketTiming(
        {
          web: {
            whatsapp: {
              keepAliveIntervalMs: 10_000,
              connectTimeoutMs: 90_000,
              defaultQueryTimeoutMs: 120_000,
            },
          },
        },
        {
          keepAliveIntervalMs: 20_000,
        },
      ),
    ).toEqual({
      keepAliveIntervalMs: 20_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });
  });

  it("rejects invalid numeric timing values", () => {
    expect(
      resolveWhatsAppSocketTiming(
        {
          web: {
            whatsapp: {
              keepAliveIntervalMs: 0,
              connectTimeoutMs: Number.NaN,
              defaultQueryTimeoutMs: 1.5,
            },
          },
        },
        {
          keepAliveIntervalMs: -1,
          connectTimeoutMs: Number.POSITIVE_INFINITY,
          defaultQueryTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
        },
      ),
    ).toEqual(DEFAULT_WHATSAPP_SOCKET_TIMING);
  });

  it("marks operation timeout errors as unknown delivery state", () => {
    const error = new WhatsAppSocketOperationTimeoutError(
      "sendMessage",
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );

    expect(error).toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "sendMessage",
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      deliveryState: "unknown",
    });
    expect(isWhatsAppSocketOperationTimeoutError(error)).toBe(true);
  });

  it("clamps oversized operation timeouts before scheduling timers", async () => {
    expect(resolveWhatsAppSocketOperationTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

describe("withWhatsAppSocketOperationTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a stalled readMessages socket operation with a typed timeout", async () => {
    vi.useFakeTimers();
    // A WhatsApp read-receipt call that never resolves (socket stall).
    const stalled = new Promise<void>(() => {});
    const bounded = withWhatsAppSocketOperationTimeout(
      "readMessages",
      stalled,
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );
    const rejection = expect(bounded).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "readMessages",
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      deliveryState: "unknown",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
    await rejection;
    // The bounding timer is cleared once the operation settles.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves the operation value when it settles before the bound", async () => {
    vi.useFakeTimers();
    const bounded = withWhatsAppSocketOperationTimeout(
      "readMessages",
      Promise.resolve("read"),
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );
    await expect(bounded).resolves.toBe("read");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createWhatsAppSocketOperationTimeoutAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes sendMessage calls across adapter instances for the same socket", async () => {
    const started: string[] = [];
    const resolves: Array<(value: WAMessage) => void> = [];
    const sock = {
      sendMessage: vi.fn(
        async (jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> =>
          await new Promise((resolve) => {
            const text =
              typeof content === "object" && content && "text" in content ? content.text : "";
            started.push(`${jid}:${text}`);
            resolves.push(resolve);
          }),
      ),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };

    const first = createWhatsAppSocketOperationTimeoutAdapter(sock, 30_000).sendMessage(
      "111@s.whatsapp.net",
      { text: "first" },
    );
    await vi.waitFor(() => expect(started).toEqual(["111@s.whatsapp.net:first"]));

    const second = createWhatsAppSocketOperationTimeoutAdapter(sock, 30_000).sendMessage(
      "222@s.whatsapp.net",
      { text: "second" },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["111@s.whatsapp.net:first"]);

    resolves[0]?.({ key: { id: "msg-1" } } as WAMessage);
    await expect(first).resolves.toMatchObject({ key: { id: "msg-1" } });
    await vi.waitFor(() =>
      expect(started).toEqual(["111@s.whatsapp.net:first", "222@s.whatsapp.net:second"]),
    );

    resolves[1]?.({ key: { id: "msg-2" } } as WAMessage);
    await expect(second).resolves.toMatchObject({ key: { id: "msg-2" } });
  });

  it("releases the send queue after a socket operation timeout", async () => {
    vi.useFakeTimers();
    const sendMessage = vi
      .fn<(jid: string, content: AnyMessageContent) => Promise<WAMessage | undefined>>()
      .mockImplementationOnce(async () => await new Promise(() => {}))
      .mockResolvedValueOnce({ key: { id: "msg-2" } } as WAMessage);
    const sock = {
      sendMessage,
      sendPresenceUpdate: vi.fn(async () => undefined),
    };

    const first = createWhatsAppSocketOperationTimeoutAdapter(sock, 1_000).sendMessage(
      "111@s.whatsapp.net",
      { text: "first" },
    );
    const firstRejection = expect(first).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "sendMessage",
    });
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const second = createWhatsAppSocketOperationTimeoutAdapter(sock, 1_000).sendMessage(
      "222@s.whatsapp.net",
      { text: "second" },
    );
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await firstRejection;
    await expect(second).resolves.toMatchObject({ key: { id: "msg-2" } });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
