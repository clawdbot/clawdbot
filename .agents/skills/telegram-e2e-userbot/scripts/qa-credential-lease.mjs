#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import os from "node:os";

const ENDPOINT_PREFIX = "/qa-credentials/v1";
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);
const TERMINAL_LEASE_CODES = new Set(["LEASE_EXPIRED", "LEASE_NOT_OWNER"]);

export class QaCredentialBrokerError extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.name = "QaCredentialBrokerError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function brokerConfig(env = process.env) {
  const siteUrl = env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  const secret = env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  if (!siteUrl || !secret) {
    throw new Error(
      "Missing OPENCLAW_QA_CONVEX_SITE_URL / OPENCLAW_QA_CONVEX_SECRET_CI. " +
        "Both are in Bitwarden SM as OPENCLAW_RTT_TEST_CONVEX_SITE_URL / _SECRET_CI.",
    );
  }
  return { siteUrl: siteUrl.replace(/\/+$/u, ""), secret };
}

async function callBroker(suffix, body, env, fetchImpl) {
  const { siteUrl, secret } = brokerConfig(env);
  const response = await fetchImpl(`${siteUrl}${ENDPOINT_PREFIX}/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "ok") {
    const code = typeof payload.code === "string" ? payload.code : "BROKER_REQUEST_FAILED";
    const message =
      typeof payload.message === "string" ? payload.message : "Broker request failed.";
    const retryAfterMs = Number.isFinite(payload.retryAfterMs) ? payload.retryAfterMs : undefined;
    throw new QaCredentialBrokerError(code, `${suffix} failed: ${code} ${message}`, retryAfterMs);
  }
  return payload;
}

export async function acquireQaLease({
  kind,
  ownerId = `qa-lease-${os.hostname()}-${process.pid}-${randomUUID()}`,
  leaseTtlMs = 20 * 60_000,
  heartbeatIntervalMs = 30_000,
  acquireTimeoutMs = 90_000,
  env = process.env,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!kind) throw new Error("acquireQaLease requires a credential kind.");
  const startedAt = Date.now();
  let acquired;
  for (;;) {
    try {
      acquired = await callBroker(
        "acquire",
        { kind, ownerId, actorRole: "ci", leaseTtlMs, heartbeatIntervalMs },
        env,
        fetchImpl,
      );
      break;
    } catch (error) {
      if (!(error instanceof QaCredentialBrokerError) || !RETRYABLE_ACQUIRE_CODES.has(error.code)) {
        throw error;
      }
      const remainingMs = acquireTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw error;
      }
      await sleepImpl(Math.min(error.retryAfterMs ?? 1_000, remainingMs));
    }
  }
  const identity = {
    kind,
    ownerId,
    actorRole: "ci",
    credentialId: acquired.credentialId,
    leaseToken: acquired.leaseToken,
  };
  let heartbeatError;
  let heartbeatInFlight;
  const timer = setInterval(() => {
    if (heartbeatInFlight || heartbeatError) return;
    heartbeatInFlight = callBroker("heartbeat", { ...identity, leaseTtlMs }, env, fetchImpl)
      .catch((error) => {
        if (error instanceof QaCredentialBrokerError && TERMINAL_LEASE_CODES.has(error.code)) {
          heartbeatError = error;
        }
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, heartbeatIntervalMs);
  timer.unref?.();
  let released = false;
  return {
    payload: acquired.payload,
    credentialId: acquired.credentialId,
    assertHealthy: () => {
      if (heartbeatError) throw heartbeatError;
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await heartbeatInFlight;
      await callBroker("release", identity, env, fetchImpl);
    },
  };
}
