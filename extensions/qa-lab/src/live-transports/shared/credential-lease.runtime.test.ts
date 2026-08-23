// Qa Lab tests cover credential lease plugin behavior.
import { createServer } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "./credential-lease.runtime.js";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = { mock: { calls: Parameters<typeof fetch>[] } };

function fetchCall(fetchImpl: FetchMock, index = 0): Parameters<typeof fetch> {
  const call = fetchImpl.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call;
}

function fetchUrl(fetchImpl: FetchMock, index = 0): string {
  const url = fetchCall(fetchImpl, index)[0];
  if (typeof url !== "string") {
    throw new Error(`expected fetch call ${index} URL`);
  }
  return url;
}

function fetchInit(fetchImpl: FetchMock, index = 0): RequestInit {
  const init = fetchCall(fetchImpl, index)[1];
  if (!init || typeof init !== "object") {
    throw new Error(`expected fetch call ${index} init`);
  }
  return init;
}

async function startStreamingFailureBroker(params: {
  chunkBytes?: number;
  intervalMs?: number;
  totalBytes?: number;
}) {
  const chunkBytes = params.chunkBytes ?? 64 * 1024;
  const intervalMs = params.intervalMs ?? 1;
  const totalBytes = params.totalBytes ?? 4 * 1024 * 1024;
  let bytesWritten = 0;
  let requestCount = 0;
  let resolveClose: () => void = () => {};
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500, { "content-type": "text/plain" });
    const interval = setInterval(() => {
      if (bytesWritten >= totalBytes || res.destroyed) {
        clearInterval(interval);
        if (!res.destroyed) {
          res.end();
        }
        return;
      }
      const nextBytes = Math.min(chunkBytes, totalBytes - bytesWritten);
      bytesWritten += nextBytes;
      res.write("x".repeat(nextBytes));
    }, intervalMs);
    res.on("close", () => {
      clearInterval(interval);
      resolveClose();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected streaming broker address");
  }
  return {
    closePromise,
    getBytesWritten: () => bytesWritten,
    getRequestCount: () => requestCount,
    totalBytes,
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe("credential lease runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses env credentials by default", async () => {
    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      resolveEnvPayload: () => ({ groupId: "-100123", driverToken: "driver", sutToken: "sut" }),
      parsePayload: () => {
        throw new Error("should not parse convex payload in env mode");
      },
      env: {},
    });

    expect(lease.source).toBe("env");
    expect(lease.payload).toEqual({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
  });

  it("acquires, heartbeats, and releases convex credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-1",
          leaseToken: "lease-1",
          payload: { groupId: "-100123", driverToken: "driver", sutToken: "sut" },
          leaseTtlMs: 1_200_000,
          heartbeatIntervalMs: 30_000,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      role: "maintainer",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(lease.source).toBe("convex");
    expect(lease.credentialId).toBe("cred-1");
    expect(lease.payload.groupId).toBe("-100123");

    await lease.heartbeat();
    await lease.release();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchImpl)).toContain("/qa-credentials/v1/acquire");
    const firstInit = fetchInit(fetchImpl);
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer maintainer-secret");
  });

  it("bounds oversized convex broker failure bodies before parsing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("x".repeat(1_048_577), {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        role: "maintainer",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
        },
        fetchImpl,
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("Convex credential broker: text response exceeds 1048576 bytes");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a streaming convex broker failure body after the response cap", async () => {
    const broker = await startStreamingFailureBroker({});
    try {
      await expect(
        acquireQaCredentialLease({
          kind: "telegram",
          source: "convex",
          role: "maintainer",
          env: {
            OPENCLAW_QA_CONVEX_SITE_URL: broker.url,
            OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
            OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
          },
          resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
          parsePayload: (payload) =>
            payload as { groupId: string; driverToken: string; sutToken: string },
        }),
      ).rejects.toThrow("Convex credential broker: text response exceeds 1048576 bytes");

      await broker.closePromise;
      expect(broker.getRequestCount()).toBe(1);
      expect(broker.getBytesWritten()).toBeLessThan(broker.totalBytes);
    } finally {
      await broker.stop();
    }
  });

  it("hydrates chunked convex credential payloads after acquire", async () => {
    const serialized = JSON.stringify({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-chunked",
          leaseToken: "lease-chunked",
          payload: {
            __openclawQaCredentialPayloadChunksV1: true,
            byteLength: serialized.length,
            chunkCount: 2,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok", data: serialized.slice(0, 20) }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", data: serialized.slice(20) }));

    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      role: "ci",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(lease.payload).toEqual({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchImpl, 1)).toBe(
      "https://qa-cred.example.convex.site/qa-credentials/v1/payload-chunk",
    );
    const chunkRequestBody = fetchInit(fetchImpl, 1).body;
    expect(chunkRequestBody).toBeTypeOf("string");
    const chunkRequest = JSON.parse(chunkRequestBody as string) as {
      credentialId?: string;
      index?: number;
      leaseToken?: string;
    };
    expect(chunkRequest.credentialId).toBe("cred-chunked");
    expect(chunkRequest.index).toBe(0);
    expect(chunkRequest.leaseToken).toBe("lease-chunked");
  });

  it("validates chunked convex payload length as utf8 bytes", async () => {
    const serialized = JSON.stringify({
      groupId: "-100123",
      driverToken: "driv\u00e9r",
      sutToken: "sut",
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-utf8",
          leaseToken: "lease-utf8",
          payload: {
            __openclawQaCredentialPayloadChunksV1: true,
            byteLength: Buffer.byteLength(serialized, "utf8"),
            chunkCount: 1,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok", data: serialized }));

    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      role: "ci",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(lease.payload.driverToken).toBe("driv\u00e9r");
  });

  it("rejects chunked convex payload markers above the configured chunk cap", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-many-chunks",
          leaseToken: "lease-many-chunks",
          payload: {
            __openclawQaCredentialPayloadChunksV1: true,
            byteLength: 1,
            chunkCount: 3,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        role: "ci",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
          OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_CHUNKS: "2",
        },
        fetchImpl,
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("Chunked credential payload marker exceeds 2 chunks.");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetchImpl, 1)).toBe(
      "https://qa-cred.example.convex.site/qa-credentials/v1/release",
    );
  });

  it("rejects chunked convex payload markers above the configured byte cap", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-large-payload",
          leaseToken: "lease-large-payload",
          payload: {
            __openclawQaCredentialPayloadChunksV1: true,
            byteLength: 33,
            chunkCount: 1,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        role: "ci",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
          OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES: "32",
        },
        fetchImpl,
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("Chunked credential payload marker exceeds 32 bytes.");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetchImpl, 1)).toBe(
      "https://qa-cred.example.convex.site/qa-credentials/v1/release",
    );
  });

  it("stops chunked convex payload hydration when chunk data exceeds the marker", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-overrun",
          leaseToken: "lease-overrun",
          payload: {
            __openclawQaCredentialPayloadChunksV1: true,
            byteLength: 2,
            chunkCount: 2,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok", data: "abc" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        role: "ci",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
        },
        fetchImpl,
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("Chunked credential payload exceeded declared byteLength.");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchImpl, 1)).toBe(
      "https://qa-cred.example.convex.site/qa-credentials/v1/payload-chunk",
    );
    expect(fetchUrl(fetchImpl, 2)).toBe(
      "https://qa-cred.example.convex.site/qa-credentials/v1/release",
    );
  });

  it("defaults convex credential role to maintainer outside CI", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        credentialId: "cred-maintainer-default",
        leaseToken: "lease-maintainer-default",
        payload: { groupId: "-100123", driverToken: "driver", sutToken: "sut" },
      }),
    );

    await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    const firstInit = fetchInit(fetchImpl);
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer maintainer-secret");
  });

  it("defaults convex credential role to ci when CI=true", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        credentialId: "cred-ci-default",
        leaseToken: "lease-ci-default",
        payload: { groupId: "-100123", driverToken: "driver", sutToken: "sut" },
      }),
    );

    await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      env: {
        CI: "true",
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    const firstInit = fetchInit(fetchImpl);
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ci-secret");
  });

  it("retries convex acquire while the pool is exhausted", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "error",
          code: "POOL_EXHAUSTED",
          message: "wait",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "error",
          code: "POOL_EXHAUSTED",
          message: "wait",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-2",
          leaseToken: "lease-2",
          payload: { groupId: "-100456", driverToken: "driver-2", sutToken: "sut-2" },
        }),
      );

    const sleeps: number[] = [];
    let nowMs = 0;

    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
        OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS: "90000",
      },
      fetchImpl,
      randomImpl: () => 0,
      timeImpl: () => nowMs,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(lease.credentialId).toBe("cred-2");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it("retries transient convex acquire transport failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new Error("fetch failed | Connect Timeout Error | UND_ERR_CONNECT_TIMEOUT"),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-after-timeout",
          leaseToken: "test",
          payload: { groupId: "-100789", driverToken: "test", sutToken: "test" },
        }),
      );
    const sleeps: number[] = [];
    let nowMs = 0;

    const lease = await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "test",
        OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS: "90000",
      },
      fetchImpl,
      randomImpl: () => 0,
      timeImpl: () => nowMs,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(lease.credentialId).toBe("cred-after-timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
  });

  it("rejects non-https convex site URLs unless local insecure opt-in is enabled", async () => {
    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "http://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
        },
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("must use https://");
  });

  it("allows loopback http URLs when OPENCLAW_QA_ALLOW_INSECURE_HTTP is enabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        credentialId: "cred-local",
        leaseToken: "lease-local",
        payload: { groupId: "-100123", driverToken: "driver", sutToken: "sut" },
      }),
    );

    await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      role: "maintainer",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "http://127.0.0.1:3210",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
        OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(fetchUrl(fetchImpl)).toBe("http://127.0.0.1:3210/qa-credentials/v1/acquire");
  });

  it("caps oversized convex HTTP timeouts before creating abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        credentialId: "cred-timeout",
        leaseToken: "lease-timeout",
        payload: { groupId: "-100123", driverToken: "driver", sutToken: "sut" },
      }),
    );

    await acquireQaCredentialLease({
      kind: "telegram",
      source: "convex",
      role: "maintainer",
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
        OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      },
      fetchImpl,
      resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
      parsePayload: (payload) =>
        payload as { groupId: string; driverToken: string; sutToken: string },
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchInit(fetchImpl).signal).toBe(timeoutController.signal);
  });

  it("rejects unsafe endpoint prefix overrides", async () => {
    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
          OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX: "//evil.example",
        },
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must be an absolute path");
  });

  it("releases acquired lease when payload parsing fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          credentialId: "cred-parse-fail",
          leaseToken: "lease-parse-fail",
          payload: { broken: true },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        role: "maintainer",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maintainer-secret",
        },
        fetchImpl,
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: () => {
          throw new Error("bad payload shape");
        },
      }),
    ).rejects.toThrow("bad payload shape");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetchImpl, 1)).toBe(
      "https://qa-cred.example.convex.site/qa-credentials/v1/release",
    );
  });

  it("fails convex mode when auth secret is missing", async () => {
    await expect(
      acquireQaCredentialLease({
        kind: "telegram",
        source: "convex",
        role: "maintainer",
        env: {
          OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-cred.example.convex.site",
        },
        resolveEnvPayload: () => ({ groupId: "-1", driverToken: "unused", sutToken: "unused" }),
        parsePayload: (payload) =>
          payload as { groupId: string; driverToken: string; sutToken: string },
      }),
    ).rejects.toThrow("OPENCLAW_QA_CONVEX_SECRET_MAINTAINER");
  });

  it("captures heartbeat failures for fail-fast checks", async () => {
    vi.useFakeTimers();
    const heartbeat = startQaCredentialLeaseHeartbeat(
      {
        source: "convex",
        kind: "telegram",
        heartbeatIntervalMs: 50,
        heartbeat: async () => {
          throw new Error("heartbeat-down");
        },
      },
      { intervalMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(55);
    expect(heartbeat.getFailure()).toBeInstanceOf(Error);
    expect(() => heartbeat.throwIfFailed()).toThrow("heartbeat-down");
    await heartbeat.stop();
  });

  it("retries transient heartbeat transport failures", async () => {
    vi.useFakeTimers();
    const heartbeatRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("fetch failed | Connect Timeout Error | UND_ERR_CONNECT_TIMEOUT"),
      )
      .mockResolvedValueOnce(undefined);
    const heartbeat = startQaCredentialLeaseHeartbeat(
      {
        source: "convex",
        kind: "telegram",
        heartbeatIntervalMs: 50,
        heartbeat: heartbeatRequest,
      },
      { intervalMs: 50, retryDelaysMs: [10] },
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(heartbeatRequest).toHaveBeenCalledTimes(1);
    expect(heartbeat.getFailure()).toBeNull();

    await vi.advanceTimersByTimeAsync(10);
    expect(heartbeatRequest).toHaveBeenCalledTimes(2);
    expect(heartbeat.getFailure()).toBeNull();
    await heartbeat.stop();
  });

  it("fails closed after transient heartbeat retries are exhausted", async () => {
    vi.useFakeTimers();
    const heartbeatRequest = vi.fn(async () => {
      throw new Error("fetch failed | ETIMEDOUT");
    });
    const heartbeat = startQaCredentialLeaseHeartbeat(
      {
        source: "convex",
        kind: "telegram",
        heartbeatIntervalMs: 50,
        heartbeat: heartbeatRequest,
      },
      { intervalMs: 50, retryDelaysMs: [10, 20] },
    );

    await vi.advanceTimersByTimeAsync(80);
    expect(heartbeatRequest).toHaveBeenCalledTimes(3);
    expect(() => heartbeat.throwIfFailed()).toThrow("ETIMEDOUT");
    await heartbeat.stop();
  });
});
