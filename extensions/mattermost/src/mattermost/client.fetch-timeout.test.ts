// Mattermost tests cover real REST client timeout behavior.
import { createRequire } from "node:module";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  fetchMattermostMe,
} from "./client.js";

// Undici's testing-only reset releases timers that retain Vitest's retired clock.
const undiciTimers: { reset: () => void } = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
);

type OperationOutcome =
  | { status: "resolved" }
  | { status: "rejected"; error: unknown }
  | {
      status: "pending";
    };

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<OperationOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<OperationOutcome>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function expectTimeoutOutcome(outcome: OperationOutcome): void {
  expect(outcome.status).toBe("rejected");
  if (outcome.status !== "rejected") {
    throw new Error(`expected timeout rejection, got ${outcome.status}`);
  }
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.error instanceof Error ? outcome.error.name : "").toMatch(
    /^(AbortError|TimeoutError)$/,
  );
}

async function withHangingMattermostServer(
  run: (server: {
    baseUrl: string;
    received: Promise<void>;
    requestCount: () => number;
  }) => Promise<void>,
): Promise<void> {
  let requestCount = 0;
  let notifyRequest: () => void = () => {};
  const received = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  await withServer(
    (request) => {
      requestCount += 1;
      notifyRequest();
      request.resume();
    },
    async (baseUrl) => {
      // Keep real socket I/O, but advance deadlines only after the request arrives.
      // A loaded worker can otherwise exhaust the 50ms deadline before connecting.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        await run({ baseUrl, received, requestCount: () => requestCount });
      } finally {
        undiciTimers.reset();
        vi.useRealTimers();
      }
    },
  );
}

describe("Mattermost REST client fetch timeout", () => {
  it("rejects a hanging real loopback request at the configured client timeout", async () => {
    await withHangingMattermostServer(async (server) => {
      const client = createMattermostClient({
        baseUrl: server.baseUrl,
        botToken: "bot-token",
        allowPrivateNetwork: true,
        timeoutMs: 50,
      });
      const request = fetchMattermostMe(client);
      const outcome = settleWithin(request, 750);

      await Promise.race([server.received, request]);
      expect(server.requestCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(750);
      expectTimeoutOutcome(await outcome);
    });
  });

  it("preserves a caller AbortSignal while applying the default request timeout", async () => {
    await withHangingMattermostServer(async (server) => {
      const client = createMattermostClient({
        baseUrl: server.baseUrl,
        botToken: "bot-token",
        allowPrivateNetwork: true,
        timeoutMs: 30_000,
      });
      const controller = new AbortController();
      const request = client.request("/users/me", { signal: controller.signal });
      const outcome = settleWithin(request, 750);

      await Promise.race([server.received, request]);
      controller.abort();
      await vi.advanceTimersByTimeAsync(750);
      expectTimeoutOutcome(await outcome);
    });
  });

  it("preserves caller cancellation through a custom fetch response body", async () => {
    let notifyFetchResolved: () => void = () => {};
    const fetchResolved = new Promise<void>((resolve) => {
      notifyFetchResolved = resolve;
    });
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"id":"partial');
      },
      async (baseUrl) => {
        const fetchImpl: typeof fetch = async (input, init) => {
          const response = await fetch(input, init);
          notifyFetchResolved();
          return response;
        };
        const client = createMattermostClient({
          baseUrl,
          botToken: "bot-token",
          fetchImpl,
          timeoutMs: 30_000,
        });
        const controller = new AbortController();
        const reason = new Error("caller stopped after headers");
        const request = client.request("/users/me", { signal: controller.signal });

        await fetchResolved;
        // Let the client's post-fetch cleanup run before cancellation so this
        // specifically covers the response-body phase.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        controller.abort(reason);

        const outcome = await settleWithin(request, 750);
        expect(outcome).toEqual({ status: "rejected", error: reason });
      },
    );
  });

  it("preserves configured DM retry timeouts longer than the client default", async () => {
    await withHangingMattermostServer(async (server) => {
      const client = createMattermostClient({
        baseUrl: server.baseUrl,
        botToken: "bot-token",
        allowPrivateNetwork: true,
        timeoutMs: 50,
      });
      const request = createMattermostDirectChannelWithRetry(client, ["bot-user", "dm-user"], {
        maxRetries: 0,
        timeoutMs: 250,
      });
      const earlyOutcome = settleWithin(request, 120);

      await Promise.race([server.received, request]);
      await vi.advanceTimersByTimeAsync(120);
      expect(await earlyOutcome).toEqual({ status: "pending" });
      const outcome = settleWithin(request, 600);
      await vi.advanceTimersByTimeAsync(600);
      expectTimeoutOutcome(await outcome);
    });
  });
});
