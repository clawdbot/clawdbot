// Telegram tests cover ingress worker runtime behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TelegramIngressWorkerCommand,
  TelegramIngressWorkerMessage,
} from "./telegram-ingress-worker.js";
import { runTelegramIngressWorkerRuntime } from "./telegram-ingress-worker.runtime.js";

type RuntimePort = Parameters<typeof runTelegramIngressWorkerRuntime>[0]["port"];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function createRuntime(
  responses: Response[],
  options: { stopAfterPollSuccesses?: number } = {},
): {
  calls: number[];
  messages: TelegramIngressWorkerMessage[];
  done: Promise<void>;
} {
  const calls: number[] = [];
  const messages: TelegramIngressWorkerMessage[] = [];
  const listeners = new Set<(message: TelegramIngressWorkerCommand) => void>();
  let pollSuccesses = 0;
  const sendCommand = (message: TelegramIngressWorkerCommand) => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const port: RuntimePort = {
    postMessage(message) {
      messages.push(message);
      if (message.type === "update") {
        sendCommand({
          type: "spool-ack",
          requestId: message.requestId,
          result: { ok: true, updateId: 42 },
        });
      }
      if (message.type === "poll-success") {
        pollSuccesses += 1;
        if (pollSuccesses >= (options.stopAfterPollSuccesses ?? 1)) {
          sendCommand({ type: "stop" });
        }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
    },
    close() {},
  };
  const fetchImpl: typeof fetch = async () => {
    calls.push(Date.now());
    const responseIndex = Math.min(calls.length - 1, responses.length - 1);
    return expectDefined(responses[responseIndex], `Telegram response ${responseIndex}`);
  };
  const done = runTelegramIngressWorkerRuntime({
    options: {
      token: "test-auth-token",
      accountId: "acct",
      initialUpdateId: null,
      spoolDir: "/tmp/openclaw-telegram-ingress-worker-test",
      apiRoot: "https://api.telegram.test",
      timeoutSeconds: 1,
    },
    port,
    deps: {
      fetch: fetchImpl,
      closeTransport: async () => {},
    },
  });
  return { calls, messages, done };
}

async function flushRuntime(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("telegram ingress worker poll cadence", () => {
  it("backs off consecutive empty polls without hot spinning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const runtime = createRuntime(
      Array.from({ length: 9 }, () => jsonResponse(200, { ok: true, result: [] })),
      { stopAfterPollSuccesses: 9 },
    );

    expect(runtime.calls).toHaveLength(1);
    await flushRuntime();
    expect(runtime.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_550);
    await runtime.done;

    const firstCall = expectDefined(runtime.calls[0], "first Telegram poll call");
    expect(runtime.calls.map((calledAt) => calledAt - firstCall)).toEqual([
      0, 0, 50, 150, 350, 750, 1_550, 2_550, 3_550,
    ]);
  });

  it("resets to immediate polling when activity resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const runtime = createRuntime(
      [
        jsonResponse(200, { ok: true, result: [] }),
        jsonResponse(200, { ok: true, result: [] }),
        jsonResponse(200, { ok: true, result: [{ update_id: 42 }] }),
        jsonResponse(200, { ok: true, result: [] }),
      ],
      { stopAfterPollSuccesses: 4 },
    );

    await flushRuntime();
    await vi.advanceTimersByTimeAsync(50);
    await runtime.done;

    const firstCall = expectDefined(runtime.calls[0], "first Telegram poll call");
    expect(runtime.calls.map((calledAt) => calledAt - firstCall)).toEqual([0, 0, 50, 50]);
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({ type: "spooled", updateId: 42 }),
    );
  });
});

describe("telegram ingress worker durable-before-offset", () => {
  it("advances getUpdates offset only after parent spool-ack commits", async () => {
    vi.useFakeTimers();
    const messages: TelegramIngressWorkerMessage[] = [];
    const listeners = new Set<(message: TelegramIngressWorkerCommand) => void>();
    const sendCommand = (message: TelegramIngressWorkerCommand) => {
      for (const listener of listeners) {
        listener(message);
      }
    };
    const pollBodies: Array<Record<string, unknown>> = [];
    let pollCount = 0;
    let releaseSpool: (() => void) | undefined;
    const spoolGate = new Promise<void>((resolve) => {
      releaseSpool = resolve;
    });
    const port: RuntimePort = {
      postMessage(message) {
        messages.push(message);
        if (message.type === "update") {
          // Parent must write spool first; offset must not advance until ack.
          void spoolGate.then(() => {
            sendCommand({
              type: "spool-ack",
              requestId: message.requestId,
              result: { ok: true, updateId: 42 },
            });
          });
        }
        if (message.type === "spooled") {
          // After one spooled update, next empty poll proves offset advanced.
        }
        if (message.type === "poll-success" && pollCount >= 2) {
          sendCommand({ type: "stop" });
        }
      },
      onMessage(listener) {
        listeners.add(listener);
      },
      close() {},
    };
    const fetchImpl: typeof fetch = async (_url, init) => {
      pollCount += 1;
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as Record<
        string,
        unknown
      >;
      pollBodies.push(body);
      if (pollCount === 1) {
        return jsonResponse(200, {
          ok: true,
          result: [{ update_id: 42, message: { text: "hi" } }],
        });
      }
      return jsonResponse(200, { ok: true, result: [] });
    };
    const done = runTelegramIngressWorkerRuntime({
      options: {
        token: "test-auth-token",
        accountId: "acct",
        initialUpdateId: null,
        spoolDir: "/tmp/openclaw-telegram-ingress-worker-offset-test",
        apiRoot: "https://api.telegram.test",
        timeoutSeconds: 1,
      },
      port,
      deps: {
        fetch: fetchImpl,
        closeTransport: async () => {},
      },
    });

    await flushRuntime();
    // First poll delivered an update; spool-ack is still held.
    expect(messages.some((m) => m.type === "update")).toBe(true);
    expect(messages.some((m) => m.type === "spooled")).toBe(false);
    expect(pollCount).toBe(1);

    releaseSpool?.();
    await flushRuntime();
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(messages).toContainEqual(expect.objectContaining({ type: "spooled", updateId: 42 }));
    // Second getUpdates must use offset = lastUpdateId + 1 only after spool-ack.
    expect(pollBodies[1]?.offset).toBe(43);
  });
});

describe("telegram ingress worker retry policy", () => {
  it("honors Telegram retry_after for getUpdates 429 responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const runtime = createRuntime([
      jsonResponse(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 0.05",
        parameters: { retry_after: 0.05 },
      }),
      jsonResponse(200, { ok: true, result: [] }),
    ]);

    expect(runtime.calls).toHaveLength(1);
    await flushRuntime();
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({ type: "poll-error", errorCode: 429 }),
    );
    await vi.advanceTimersByTimeAsync(49);
    expect(runtime.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.done;

    expect(runtime.calls).toHaveLength(2);
    const secondCall = expectDefined(runtime.calls[1], "second Telegram poll call");
    const firstCall = expectDefined(runtime.calls[0], "first Telegram poll call");
    expect(secondCall - firstCall).toBe(50);
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({ type: "poll-success", count: 0 }),
    );
  });

  it.each([500, 502])("retries getUpdates %s responses with backoff", async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const runtime = createRuntime([
      jsonResponse(status, {
        ok: false,
        error_code: status,
        description: status === 500 ? "Internal Server Error" : "Bad Gateway",
      }),
      jsonResponse(200, { ok: true, result: [] }),
    ]);

    expect(runtime.calls).toHaveLength(1);
    await flushRuntime();
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({ type: "poll-error", errorCode: status }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(runtime.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.done;

    expect(runtime.calls).toHaveLength(2);
    const secondCall = expectDefined(runtime.calls[1], "second Telegram poll call");
    const firstCall = expectDefined(runtime.calls[0], "first Telegram poll call");
    expect(secondCall - firstCall).toBe(1000);
  });

  it("retries a non-json getUpdates 502 response as a server error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const runtime = createRuntime([
      htmlResponse(502, "<html>Bad Gateway</html>"),
      jsonResponse(200, { ok: true, result: [] }),
    ]);

    expect(runtime.calls).toHaveLength(1);
    await flushRuntime();
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({
        type: "poll-error",
        errorCode: 502,
        message: "Telegram getUpdates failed with HTTP 502",
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await runtime.done;

    expect(runtime.calls).toHaveLength(2);
  });

  it.each([401, 409])("propagates getUpdates %s responses to the parent", async (status) => {
    const runtime = createRuntime([
      jsonResponse(status, {
        ok: false,
        error_code: status,
        description:
          status === 401 ? "Unauthorized" : "Conflict: terminated by other getUpdates request",
      }),
    ]);

    await expect(runtime.done).rejects.toThrow(
      status === 401 ? "Unauthorized" : "Conflict: terminated by other getUpdates request",
    );
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({ type: "poll-error", errorCode: status }),
    );
  });
});
