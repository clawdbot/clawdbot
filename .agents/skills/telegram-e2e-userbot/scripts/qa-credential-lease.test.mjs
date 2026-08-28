import assert from "node:assert/strict";
import test from "node:test";
import { acquireQaLease, QaCredentialBrokerError } from "./qa-credential-lease.mjs";

const env = {
  OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test/",
  OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
};

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
