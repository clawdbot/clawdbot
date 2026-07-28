// Mattermost tests cover real REST client timeout behavior.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  fetchMattermostMe,
} from "./client.js";

type OperationOutcome =
  | { status: "resolved" }
  | { status: "rejected"; error: unknown }
  | {
      status: "pending";
    };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<OperationOutcome> {
  return await Promise.race([
    promise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    delay(timeoutMs).then(() => ({ status: "pending" as const })),
  ]);
}

async function expectTimeoutRejection(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  const outcome = await settleWithin(promise, timeoutMs);
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
    async (baseUrl) => run({ baseUrl, received, requestCount: () => requestCount }),
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

      await server.received;
      expect(server.requestCount()).toBe(1);
      await expectTimeoutRejection(request, 750);
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

      await server.received;
      controller.abort();
      await expectTimeoutRejection(request, 750);
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
      request.catch(() => undefined);

      await server.received;
      expect(await settleWithin(request, 120)).toEqual({ status: "pending" });
      await expectTimeoutRejection(request, 600);
    });
  });
});
