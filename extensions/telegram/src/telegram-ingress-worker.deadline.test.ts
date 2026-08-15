// Telegram tests cover the isolated ingress request deadline boundary.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TelegramIngressWorkerCommand,
  TelegramIngressWorkerMessage,
} from "./telegram-ingress-worker.js";
import { runTelegramIngressWorkerRuntime } from "./telegram-ingress-worker.runtime.js";

type RuntimePort = Parameters<typeof runTelegramIngressWorkerRuntime>[0]["port"];

afterEach(() => {
  vi.useRealTimers();
});

describe("telegram ingress worker request deadline", () => {
  it("aborts a stalled response body at the getUpdates deadline", async () => {
    vi.useFakeTimers();
    const messages: TelegramIngressWorkerMessage[] = [];
    const listeners = new Set<(message: TelegramIngressWorkerCommand) => void>();
    let requestSignal: AbortSignal | undefined;
    const sendCommand = (message: TelegramIngressWorkerCommand) => {
      for (const listener of listeners) {
        listener(message);
      }
    };
    const port: RuntimePort = {
      postMessage(message) {
        messages.push(message);
        if (message.type === "poll-error") {
          sendCommand({ type: "stop" });
        }
      },
      onMessage(listener) {
        listeners.add(listener);
      },
      close() {},
    };
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      const signal = requestSignal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { status: 200 },
      );
    };
    const done = runTelegramIngressWorkerRuntime({
      options: {
        token: "test-auth-token",
        accountId: "acct",
        initialUpdateId: null,
        spoolDir: "/tmp/openclaw-telegram-ingress-worker-deadline-test",
        apiRoot: "https://api.telegram.test",
      },
      port,
      deps: {
        fetch: fetchImpl,
        closeTransport: async () => {},
      },
    });

    await vi.advanceTimersByTimeAsync(44_999);
    expect(requestSignal?.aborted).toBe(false);
    expect(messages.some((message) => message.type === "poll-error")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(requestSignal?.aborted).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "poll-error",
        message: "Telegram getUpdates timed out",
      }),
    );
  });
});
