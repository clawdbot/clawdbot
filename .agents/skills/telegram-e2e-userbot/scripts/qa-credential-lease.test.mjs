import assert from "node:assert/strict";
import test from "node:test";
import { acquireQaLease, QaCredentialBrokerError } from "./qa-credential-lease.mjs";

const env = {
  OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test/",
  OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
};

test("rejects remote cleartext broker URLs before fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      env: { ...env, OPENCLAW_QA_CONVEX_SITE_URL: "http://broker.example.test" },
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ status: "ok" });
      },
    }),
    /must use https/u,
  );
  assert.equal(fetchCalls, 0);
});

test("allows explicit IPv4 and IPv6 loopback HTTP for local broker development", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-loopback",
        leaseToken: "lease-token-loopback",
        payload: { schemaVersion: 1 },
      });
    }
    return Response.json({ status: "ok" });
  };
  for (const siteUrl of ["http://127.0.0.1:3210/", "http://[::1]:3210/"]) {
    const lease = await acquireQaLease({
      kind: "telegram-test-userbot",
      env: {
        ...env,
        OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
        OPENCLAW_QA_CONVEX_SITE_URL: siteUrl,
      },
      fetchImpl,
    });
    await lease.release();
  }
});

test("acquires, heartbeats, and releases one credential", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, authorization: init.headers.authorization });
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-1",
        leaseToken: "lease-token",
        payload: { schemaVersion: 1 },
      });
    }
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    ownerId: "test-owner",
    heartbeatIntervalMs: 10,
    env,
    fetchImpl,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  lease.assertHealthy();
  await lease.release();
  await lease.release();

  assert.deepEqual(lease.payload, { schemaVersion: 1 });
  assert.equal(calls[0].body.kind, "telegram-test-userbot");
  assert.equal(calls[0].authorization, "Bearer ci-secret");
  assert.ok(calls.some((call) => call.url.endsWith("/heartbeat")));
  assert.equal(calls.filter((call) => call.url.endsWith("/release")).length, 1);
});

test("accepts empty successful heartbeat and release replies", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-empty-success",
        leaseToken: "lease-token-empty-success",
        payload: { schemaVersion: 1 },
      });
    }
    return new Response(null, { status: 204 });
  };
  const lease = await acquireQaLease({ kind: "telegram-test-userbot", env, fetchImpl });
  await lease.release();
  assert.equal(calls.filter((url) => url.endsWith("/heartbeat")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("waits for a pooled credential and preserves the broker retry delay", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (!url.endsWith("/acquire")) return Response.json({ status: "ok" });
    attempts += 1;
    if (attempts === 1) {
      return Response.json(
        {
          status: "error",
          code: "POOL_EXHAUSTED",
          message: "No credential is available.",
          retryAfterMs: 2000,
        },
        { status: 409 },
      );
    }
    return Response.json({
      status: "ok",
      credentialId: "credential-2",
      leaseToken: "lease-token-2",
      payload: { schemaVersion: 1 },
    });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    env,
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  await lease.release();
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("hydrates an authenticated broker payload above the inline threshold", async () => {
  const expected = { schemaVersion: 1, archive: "x".repeat(300_000) };
  const serialized = JSON.stringify(expected);
  const chunks = [
    serialized.slice(0, 120_000),
    serialized.slice(120_000, 240_000),
    serialized.slice(240_000),
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, authorization: init.headers.authorization });
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-chunked",
        leaseToken: "lease-token-chunked",
        payload: {
          __openclawQaCredentialPayloadChunksV1: true,
          chunkCount: chunks.length,
          byteLength: Buffer.byteLength(serialized, "utf8"),
        },
      });
    }
    if (url.endsWith("/payload-chunk")) {
      return Response.json({ status: "ok", data: chunks[body.index] });
    }
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({ kind: "telegram-test-userbot", env, fetchImpl });
  assert.deepEqual(lease.payload, expected);
  const chunkCalls = calls.filter((call) => call.url.endsWith("/payload-chunk"));
  assert.deepEqual(
    chunkCalls.map((call) => call.body.index),
    [0, 1, 2],
  );
  assert.ok(chunkCalls.every((call) => call.authorization === "Bearer ci-secret"));
  await lease.release();
});

test("rejects an inline credential when its initial heartbeat fails", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-inline-expired",
        leaseToken: "lease-token-inline-expired",
        payload: { schemaVersion: 1 },
      });
    }
    if (url.endsWith("/heartbeat")) {
      return Response.json(
        { status: "error", code: "LEASE_EXPIRED", message: "Lease expired." },
        { status: 409 },
      );
    }
    return Response.json({ status: "ok" });
  };

  await assert.rejects(
    acquireQaLease({ kind: "telegram-test-userbot", env, fetchImpl }),
    (error) => error instanceof QaCredentialBrokerError && error.code === "LEASE_EXPIRED",
  );
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("heartbeat loss stops delayed chunk hydration before returning credentials", async () => {
  let heartbeatCount = 0;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-delayed-chunk",
        leaseToken: "lease-token-delayed-chunk",
        payload: {
          __openclawQaCredentialPayloadChunksV1: true,
          chunkCount: 2,
          byteLength: 4,
        },
      });
    }
    if (url.endsWith("/heartbeat")) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) return Response.json({ status: "ok" });
      return Response.json(
        { status: "error", code: "LEASE_EXPIRED", message: "Lease expired." },
        { status: 409 },
      );
    }
    if (url.endsWith("/payload-chunk")) {
      return await new Promise(() => {});
    }
    return Response.json({ status: "ok" });
  };

  await assert.rejects(
    acquireQaLease({
      kind: "telegram-test-userbot",
      heartbeatIntervalMs: 5,
      env,
      fetchImpl,
    }),
    (error) => error instanceof QaCredentialBrokerError && error.code === "LEASE_EXPIRED",
  );
  assert.equal(calls.filter((url) => url.endsWith("/payload-chunk")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("reports pool exhaustion after the acquire budget", async () => {
  const fetchImpl = async () =>
    Response.json(
      {
        status: "error",
        code: "POOL_EXHAUSTED",
        message: "No credential is available.",
        retryAfterMs: 2000,
      },
      { status: 409 },
    );
  await assert.rejects(
    acquireQaLease({ kind: "telegram-test-userbot", acquireTimeoutMs: 0, env, fetchImpl }),
    (error) =>
      error instanceof QaCredentialBrokerError &&
      error.code === "POOL_EXHAUSTED" &&
      error.retryAfterMs === 2000,
  );
});

test("surfaces terminal heartbeat loss and still releases", async () => {
  const calls = [];
  let heartbeatCount = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-3",
        leaseToken: "lease-token-3",
        payload: { schemaVersion: 1 },
      });
    }
    if (url.endsWith("/heartbeat")) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) return Response.json({ status: "ok" });
      return Response.json(
        { status: "error", code: "LEASE_EXPIRED", message: "Lease expired." },
        { status: 409 },
      );
    }
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    heartbeatIntervalMs: 5,
    env,
    fetchImpl,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(
    () => lease.assertHealthy(),
    (error) => error instanceof QaCredentialBrokerError && error.code === "LEASE_EXPIRED",
  );
  await lease.release();
  assert.equal(calls.filter((url) => url.endsWith("/release")).length, 1);
});

test("fences a stalled heartbeat and bounds lease cleanup", async () => {
  let released = false;
  let heartbeatCount = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-stalled",
        leaseToken: "lease-token-stalled",
        payload: { schemaVersion: 1 },
      });
    }
    if (url.endsWith("/heartbeat")) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) return Response.json({ status: "ok" });
      return await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    released = true;
    return Response.json({ status: "ok" });
  };
  const lease = await acquireQaLease({
    kind: "telegram-test-userbot",
    heartbeatIntervalMs: 5,
    httpTimeoutMs: 10,
    env,
    fetchImpl,
  });
  const heartbeatError = await Promise.race([
    lease.whenUnhealthy,
    new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat did not fence")), 100)),
  ]);
  assert.throws(
    () => lease.assertHealthy(),
    (error) => error === heartbeatError,
  );
  await lease.release();
  assert.equal(released, true);
});
