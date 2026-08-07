// Proof: verifyGoogleChatRequest → fetchChatCerts through the REAL
// fetchWithSsrFGuard, exercised against a real hanging node:http loopback.
//
// This file does NOT mock openclaw/plugin-sdk/ssrf-runtime, so the production
// timeout composition and hostname policy run for every call. The auth runtime
// stays hermetic, while globalThis.fetch redirects the guarded request onto a
// loopback server that never responds. That fetch interception bypasses pinned
// DNS and dispatcher construction, but lets the real 30s deadline abort a real
// hanging HTTP request.
//
// Mirrors the Google auth transport proof (#103627) / MiniMax OAuth timeout
// proof (#102862): capture the production timeout callback and fire it only
// after the real loopback server confirms request receipt.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const GOOGLECHAT_CERT_FETCH_TIMEOUT_MS = 30_000;
const CHAT_CERTS_PATH = "/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

const mockVerifySignedJwt = vi.hoisted(() => vi.fn());
// vi.fn() used as a constructor requires a non-arrow factory.
const mockOAuth2Client = vi.hoisted(() =>
  vi.fn(function (this: { verifySignedJwtWithCertsAsync: typeof mockVerifySignedJwt }) {
    this.verifySignedJwtWithCertsAsync = mockVerifySignedJwt;
  }),
);

vi.mock("./google-auth.runtime.js", () => ({
  loadGoogleAuthRuntime: vi.fn().mockResolvedValue({ OAuth2Client: mockOAuth2Client }),
  getGoogleAuthTransport: vi.fn().mockResolvedValue({}),
  resolveValidatedGoogleChatCredentials: vi.fn().mockResolvedValue(null),
  testing: { resetGoogleAuthRuntimeForTests: vi.fn() },
}));

import { testing, verifyGoogleChatRequest } from "./auth.js";

afterEach(() => {
  testing.resetGoogleChatAuthForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Capture the production 30s deadline scheduled by buildTimeoutAbortSignal so it
// can be fired deterministically after the loopback server confirms receipt.
function captureCertFetchTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === GOOGLECHAT_CERT_FETCH_TIMEOUT_MS) {
      fireTimeout = () => callback(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(() => callback(...args), timeout);
  }) as typeof setTimeout);
  return {
    setTimeoutSpy,
    scheduled() {
      return setTimeoutSpy.mock.calls.some(
        ([, timeout]) => timeout === GOOGLECHAT_CERT_FETCH_TIMEOUT_MS,
      );
    },
    fire() {
      if (!fireTimeout) {
        throw new Error("expected Google Chat cert-fetch 30s timeout to be scheduled");
      }
      const callback = fireTimeout;
      fireTimeout = undefined;
      callback();
    },
  };
}

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function startHangingLoopbackServer(): Promise<{
  origin: string;
  requests: string[];
  waitForRequestCount: (count: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  type RequestWaiter = {
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const waiters: RequestWaiter[] = [];

  const resolveWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || requests.length < waiter.count) {
        continue;
      }
      waiters.splice(index, 1);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve();
    }
  };

  // Accept the request and deliberately never respond, so the guarded fetch
  // stays pending until the deadline aborts it.
  const server = createServer((req, _res) => {
    requests.push(req.url ?? "");
    req.resume();
    resolveWaiters();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenOnLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    waitForRequestCount: async (count: number) => {
      if (requests.length >= count) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: RequestWaiter = { count, resolve, reject };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`server received ${requests.length} request(s), expected ${count}`));
        }, 2_000);
        waiters.push(waiter);
      });
    },
    close: async () => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.reject(new Error("server closed"));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function verifyOutcomeWithin(
  promise: Promise<{ ok: boolean; reason?: string }>,
  timeoutMs: number,
): Promise<
  | { status: "resolved"; value: { ok: boolean; reason?: string } }
  | { status: "rejected"; error: unknown }
  | { status: "pending" }
> {
  return await Promise.race([
    promise.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    new Promise<{ status: "pending" }>((resolve) => {
      setTimeout(() => resolve({ status: "pending" as const }), timeoutMs);
    }),
  ]);
}

describe("googlechat cert-fetch — real guard proof", () => {
  it("times out a stalled cert fetch through the real production guard", async () => {
    const realFetch = globalThis.fetch;
    const server = await startHangingLoopbackServer();
    const certFetchTimeout = captureCertFetchTimeout();
    let pendingVerify: Promise<{ ok: boolean; reason?: string }> | undefined;

    // Redirect the request the real guard emits onto the hanging loopback
    // server while preserving the guard's composed timeout signal. The
    // googleapis.com cert URL keeps the real SSRF hostname allowlist satisfied.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await realFetch(`${server.origin}${CHAT_CERTS_PATH}`, {
        method: init?.method ?? "GET",
        signal: init?.signal,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      pendingVerify = verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "project-number",
        audience: "12345",
      });

      // The real guard scheduled its 30s deadline and dispatched the request;
      // the loopback server confirms it genuinely arrived and is now hanging.
      await server.waitForRequestCount(1);
      expect(certFetchTimeout.scheduled()).toBe(true);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

      // Mutation control: without firing the deadline the verification stays
      // pending, proving the rejection below comes from the real timeout.
      const beforeFire = await verifyOutcomeWithin(pendingVerify, 500);
      expect(beforeFire.status).toBe("pending");

      // Fire the captured production deadline; the composed signal aborts the
      // in-flight loopback request and verifyGoogleChatRequest returns ok:false.
      certFetchTimeout.fire();

      const outcome = await verifyOutcomeWithin(pendingVerify, 2_000);
      if (outcome.status !== "resolved") {
        throw new Error(`expected stalled cert fetch to resolve, got ${outcome.status}`);
      }
      expect(outcome.value.ok).toBe(false);
      expect(outcome.value.reason).toMatch(/aborted|timed out|timeout/i);
      expect(server.requests).toContain(CHAT_CERTS_PATH);
      expect(mockVerifySignedJwt).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await pendingVerify?.catch(() => undefined);
    }
  });
});
