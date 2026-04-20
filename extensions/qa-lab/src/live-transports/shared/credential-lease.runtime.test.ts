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
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall?.[0]).toContain("/qa-credentials/v1/acquire");
    const firstInit = firstCall?.[1];
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer maintainer-secret");
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

    const firstCall = fetchImpl.mock.calls[0];
    const firstInit = firstCall?.[1];
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

    const firstCall = fetchImpl.mock.calls[0];
    const firstInit = firstCall?.[1];
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

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall?.[0]).toBe("http://127.0.0.1:3210/qa-credentials/v1/acquire");
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
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
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
});
