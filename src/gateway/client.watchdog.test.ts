import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { GatewayClient, resolveGatewayClientConnectChallengeTimeoutMs } from "./client.js";
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
  MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
} from "./handshake-timeouts.js";

// Find a free localhost port for ad-hoc WS servers.
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function isIpv6UnavailableError(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL";
}

function createOpenGatewayClient(requestTimeoutMs: number): {
  client: GatewayClient;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs,
  });
  const send = vi.fn();
  (
    client as unknown as {
      ws: WebSocket | { readyState: number; send: () => void; close: () => void };
    }
  ).ws = {
    readyState: WebSocket.OPEN,
    send,
    close: vi.fn(),
  };
  return { client, send };
}

function getPendingCount(client: GatewayClient): number {
  return (client as unknown as { pending: Map<string, unknown> }).pending.size;
}

function trackSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

describe("GatewayClient", () => {
  let wss: WebSocketServer | null = null;
  let httpsServer: ReturnType<typeof createHttpsServer> | null = null;

  afterEach(async () => {
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = null;
    }
    if (httpsServer) {
      httpsServer.closeAllConnections?.();
      httpsServer.closeIdleConnections?.();
      await new Promise<void>((resolve) => httpsServer?.close(() => resolve()));
      httpsServer = null;
    }
  });

  test("prefers connectChallengeTimeoutMs and still honors the legacy alias", () => {
    expect(resolveGatewayClientConnectChallengeTimeoutMs({})).toBe(
      DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
    );
    expect(resolveGatewayClientConnectChallengeTimeoutMs({ connectDelayMs: 0 })).toBe(
      MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
    expect(resolveGatewayClientConnectChallengeTimeoutMs({ connectDelayMs: 20_000 })).toBe(
      MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        connectDelayMs: 2_000,
        connectChallengeTimeoutMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(
      resolveGatewayClientConnectChallengeTimeoutMs({
        connectChallengeTimeoutMs: 45_000,
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
  });

  test("closes on missing ticks", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });

    wss.on("connection", (socket) => {
      socket.once("message", (data) => {
        const first = JSON.parse(rawDataToString(data)) as { id?: string };
        const id = first.id ?? "connect";
        // Respond with tiny tick interval to trigger watchdog quickly.
        const helloOk = {
          type: "hello-ok",
          protocol: 2,
          server: { version: "dev", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1,
          },
          policy: {
            maxPayload: 512 * 1024,
            maxBufferedBytes: 1024 * 1024,
            tickIntervalMs: 5,
          },
        };
        socket.send(JSON.stringify({ type: "res", id, ok: true, payload: helloOk }));
      });
    });

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        connectChallengeTimeoutMs: 0,
        tickWatchMinIntervalMs: 5,
        onClose: (code, reason) => resolve({ code, reason }),
      });
      client.start();
    });

    const res = await closed;
    // Depending on auth/challenge timing in the harness, the client can either
    // hit the tick watchdog (4000) or close with policy violation (1008).
    expect([4000, 1008]).toContain(res.code);
    if (res.code === 4000) {
      expect(res.reason).toContain("tick timeout");
    }
  }, 4000);

  test("connects to IPv6 loopback while managed proxy Gateway-only mode is active", async () => {
    wss = new WebSocketServer({ host: "::1", port: 0 });
    const bind = await new Promise<{ port: number } | null>((resolve, reject) => {
      wss?.once("listening", () => {
        const address = wss?.address();
        if (address === undefined || address === null || typeof address === "string") {
          reject(new Error("IPv6 WebSocket server did not bind to a TCP port"));
          return;
        }
        resolve({ port: address.port });
      });
      wss?.once("error", (err) => {
        if (isIpv6UnavailableError(err)) {
          wss = null;
          resolve(null);
          return;
        }
        reject(err);
      });
    });
    if (bind === null) {
      return;
    }

    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const handle = await startProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:9",
      loopbackMode: "gateway-only",
    });
    const onConnectError = vi.fn();
    const connected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("IPv6 loopback Gateway client did not connect"));
      }, 2000);
      wss?.once("connection", (socket) => {
        clearTimeout(timeout);
        socket.close(1000, "done");
        resolve();
      });
    });
    const client = new GatewayClient({
      url: `ws://[::1]:${bind.port}`,
      connectChallengeTimeoutMs: 1000,
      onConnectError,
    });

    try {
      expect(client.start()).toBeUndefined();
      await connected;
      expect(onConnectError).not.toHaveBeenCalled();
    } finally {
      client.stop();
      await stopProxy(handle);
    }
  }, 5000);

  test("lets pending requests own their timeout when ticks are missing", async () => {
    vi.useFakeTimers();
    try {
      const client = new GatewayClient({
        requestTimeoutMs: 10_000,
        tickWatchMinIntervalMs: 5,
      });
      const close = vi.fn();
      const pending = (client as unknown as { pending: Map<string, unknown> }).pending;
      Object.assign(
        client as unknown as { ws: unknown; tickIntervalMs: number; lastTick: number },
        {
          ws: {
            readyState: WebSocket.OPEN,
            send: vi.fn(),
            close,
          },
          tickIntervalMs: 5,
          lastTick: Date.now(),
        },
      );
      pending.set("long-rpc", {
        resolve: vi.fn(),
        reject: vi.fn(),
        expectFinal: false,
        timeout: null,
      });

      (
        client as unknown as {
          startTickWatch: () => void;
        }
      ).startTickWatch();
      await vi.advanceTimersByTimeAsync(20);

      expect(close).not.toHaveBeenCalled();

      pending.clear();
      await vi.advanceTimersByTimeAsync(5);

      expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  test("times out unresolved requests and clears pending state", async () => {
    vi.useFakeTimers();
    try {
      const { client, send } = createOpenGatewayClient(25);

      const requestPromise = client.request("status");
      const requestExpectation = expect(requestPromise).rejects.toThrow(
        "gateway request timeout for status",
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(getPendingCount(client)).toBe(1);

      await vi.advanceTimersByTimeAsync(25);

      await requestExpectation;
      expect(getPendingCount(client)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not auto-timeout expectFinal requests", async () => {
    vi.useFakeTimers();
    try {
      const { client, send } = createOpenGatewayClient(25);

      const requestPromise = client.request("chat.send", undefined, { expectFinal: true });
      const isSettled = trackSettlement(requestPromise);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);

      expect(isSettled()).toBe(false);
      expect(getPendingCount(client)).toBe(1);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clamps oversized explicit request timeouts before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const { client } = createOpenGatewayClient(25);

      const requestPromise = client.request("status", undefined, { timeoutMs: 2_592_010_000 });
      const isSettled = trackSettlement(requestPromise);

      await vi.advanceTimersByTimeAsync(1);

      expect(isSettled()).toBe(false);
      expect(getPendingCount(client)).toBe(1);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clamps oversized default request timeouts before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const { client } = createOpenGatewayClient(2_592_010_000);

      const requestPromise = client.request("status");
      const isSettled = trackSettlement(requestPromise);

      await vi.advanceTimersByTimeAsync(1);

      expect(isSettled()).toBe(false);
      expect(getPendingCount(client)).toBe(1);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects mismatched tls fingerprint", async () => {
    const key = [
      "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDrur5CWp4psMMb",
      "DTPY1aN46HPDxRchGgh8XedNkrlc4z1KFiyLUsXpVIhuyoXq1fflpTDz7++pGEDJ",
      "Q5pEdChn3fuWgi7gC+pvd5VQ1eAX/7qVE72fhx14NxhaiZU3hCzXjG2SflTEEExk",
      "UkQTm0rdHSjgLVMhTM3Pqm6Kzfdgtm9ZyXwlAsorE/pvgbUxG3Q4xKNBGzbirZ+1",
      "EzPDwsjf3fitNtakZJkymu6Kg5lsUihQVXOP0U7f989FmevoTMvJmkvJzsoTRd7s",
      "XNSOjzOwJr8da8C4HkXi21md1yEccyW0iSh7tWvDrpWDAgW6RMuMHC0tW4bkpDGr",
      "FpbQOgzVAgMBAAECggEAIMhwf8Ve9CDVTWyNXpU9fgnj2aDOCeg3MGaVzaO/XCPt",
      "KOHDEaAyDnRXYgMP0zwtFNafo3klnSBWmDbq3CTEXseQHtsdfkKh+J0KmrqXxval",
      "YeikKSyvBEIzRJoYMqeS3eo1bddcXgT/Pr9zIL/qzivpPJ4JDttBzyTeaTbiNaR9",
      "KphGNueo+MTQMLreMqw5VAyJ44gy7Z/2TMiMEc/d95wfubcOSsrIfpOKnMvWd/rl",
      "vxIS33s95L7CjREkixskj5Yo5Wpt3Yf5b0Zi70YiEsCfAZUDrPW7YzMlylzmhMzm",
      "MARZKfN1Tmo74SGpxUrBury+iPwf1sYcRnsHR+zO8QKBgQD6ISQHRzPboZ3J/60+",
      "fRLETtrBa9WkvaH9c+woF7l47D4DIlvlv9D3N1KGkUmhMnp2jNKLIlalBNDxBdB+",
      "iwZP1kikGz4629Ch3/KF/VYscLTlAQNPE42jOo7Hj7VrdQx9zQrK9ZBLteXmSvOh",
      "bB3aXwXPF3HoTMt9gQ9thhXZJQKBgQDxQxUnQSw43dRlqYOHzPUEwnJkGkuW/qxn",
      "aRc8eopP5zUaebiDFmqhY36x2Wd+HnXrzufy2o4jkXkWTau8Ns+OLhnIG3PIU9L/",
      "LYzJMckGb75QYiK1YKMUUSQzlNCS8+TFVCTAvG2u2zCCk7oTIe8aT516BQNjWDjK",
      "gWo2f87N8QKBgHoVANO4kfwJxszXyMPuIeHEpwquyijNEap2EPaEldcKXz4CYB4j",
      "4Cc5TkM12F0gGRuRohWcnfOPBTgOYXPSATOoX+4RCe+KaCsJ9gIl4xBvtirrsqS+",
      "42ue4h9O6fpXt9AS6sii0FnTnzEmtgC8l1mE9X3dcJA0I0HPYytOvY0tAoGAAYJj",
      "7Xzw4+IvY/ttgTn9BmyY/ptTgbxSI8t6g7xYhStzH5lHWDqZrCzNLBuqFBXosvL2",
      "bISFgx9z3Hnb6y+EmOUc8C2LyeMMXOBSEygmk827KRGUGgJiwsvHKDN0Ipc4BSwD",
      "ltkW7pMceJSoA1qg/k8lMxA49zQkFtA8c97U0mECgYEAk2DDN78sRQI8RpSECJWy",
      "l1O1ikVUAYVeh5HdZkpt++ddfpo695Op9OeD2Eq27Y5EVj8Xl58GFxNk0egLUnYq",
      "YzSbjcNkR2SbVvuLaV1zlQKm6M5rfvhj4//YrzrrPUQda7Q4eR0as/3q91uzAO2O",
      "++pfnSCVCyp/TxSkhEDEawU=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const cert = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUel0Lv05cjrViyI/H3tABBJxM7NgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEyMDEyMjEzMloXDTI2MDEy
MTEyMjEzMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA67q+QlqeKbDDGw0z2NWjeOhzw8UXIRoIfF3nTZK5XOM9
ShYsi1LF6VSIbsqF6tX35aUw8+/vqRhAyUOaRHQoZ937loIu4Avqb3eVUNXgF/+6
lRO9n4cdeDcYWomVN4Qs14xtkn5UxBBMZFJEE5tK3R0o4C1TIUzNz6puis33YLZv
Wcl8JQLKKxP6b4G1MRt0OMSjQRs24q2ftRMzw8LI3934rTbWpGSZMpruioOZbFIo
UFVzj9FO3/fPRZnr6EzLyZpLyc7KE0Xe7FzUjo8zsCa/HWvAuB5F4ttZndchHHMl
tIkoe7Vrw66VgwIFukTLjBwtLVuG5KQxqxaW0DoM1QIDAQABo1MwUTAdBgNVHQ4E
FgQUwNdNkEQtd0n/aofzN7/EeYPPPbIwHwYDVR0jBBgwFoAUwNdNkEQtd0n/aofz
N7/EeYPPPbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnOnw
o8Az/bL0A6bGHTYra3L9ArIIljMajT6KDHxylR4LhliuVNAznnhP3UkcZbUdjqjp
MNOM0lej2pNioondtQdXUskZtqWy6+dLbTm1RYQh1lbCCZQ26o7o/oENzjPksLAb
jRM47DYxRweTyRWQ5t9wvg/xL0Yi1tWq4u4FCNZlBMgdwAEnXNwVWTzRR9RHwy20
lmUzM8uQ/p42bk4EvPEV4PI1h5G0khQ6x9CtkadCTDs/ZqoUaJMwZBIDSrdJJSLw
4Vh8Lqzia1CFB4um9J4S1Gm/VZMBjjeGGBJk7VSYn4ZmhPlbPM+6z39lpQGEG0x4
r1USnb+wUdA7Zoj/mQ==
-----END CERTIFICATE-----`;

    httpsServer = createHttpsServer({ key, cert });
    wss = new WebSocketServer({ server: httpsServer, maxPayload: 1024 * 1024 });
    const port = await new Promise<number>((resolve, reject) => {
      httpsServer?.once("error", reject);
      httpsServer?.listen(0, "127.0.0.1", () => {
        const address = httpsServer?.address();
        if (!address || typeof address === "string") {
          reject(new Error("https server address unavailable"));
          return;
        }
        resolve(address.port);
      });
    });

    let client: GatewayClient | null = null;
    const error = await new Promise<Error>((resolve) => {
      let settled = false;
      const finish = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(err);
      };
      const timeout = setTimeout(() => {
        client?.stop();
        finish(new Error("timeout waiting for tls error"));
      }, 2000);
      client = new GatewayClient({
        url: `wss://127.0.0.1:${port}`,
        connectChallengeTimeoutMs: 0,
        tlsFingerprint: "deadbeef",
        onConnectError: (err) => {
          clearTimeout(timeout);
          client?.stop();
          finish(err);
        },
        onClose: () => {
          clearTimeout(timeout);
          client?.stop();
          finish(new Error("closed without tls error"));
        },
      });
      client.start();
    });

    expect(String(error)).toContain("tls fingerprint mismatch");
  });
});
