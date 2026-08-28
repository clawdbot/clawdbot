#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import os from "node:os";

const ENDPOINT_PREFIX = "/qa-credentials/v1";
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_PAYLOAD_MAX_CHUNKS = 4096;
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);

export class QaCredentialBrokerError extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.name = "QaCredentialBrokerError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function brokerConfig(env = process.env) {
  const siteUrl = env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  const secret = env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  if (!siteUrl || !secret) {
    throw new Error(
      "Missing OPENCLAW_QA_CONVEX_SITE_URL / OPENCLAW_QA_CONVEX_SECRET_CI. " +
        "Both are in Bitwarden SM as OPENCLAW_RTT_TEST_CONVEX_SITE_URL / _SECRET_CI.",
    );
  }
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error("OPENCLAW_QA_CONVEX_SITE_URL must be a valid URL.");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  const allowLoopbackHttp = /^(?:1|true|yes)$/iu.test(
    env.OPENCLAW_QA_ALLOW_INSECURE_HTTP?.trim() ?? "",
  );
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback && allowLoopbackHttp)
  ) {
    throw new Error(
      "OPENCLAW_QA_CONVEX_SITE_URL must use https://. " +
        "Loopback http:// requires OPENCLAW_QA_ALLOW_INSECURE_HTTP=1.",
    );
  }
  return { siteUrl: parsed.toString().replace(/\/+$/u, ""), secret };
}

async function readBrokerResponse(response, maxBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`Broker response exceeded ${maxBytes} bytes.`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Broker returned invalid JSON.");
  }
}

async function callBroker(
  suffix,
  body,
  { env, fetchImpl, httpTimeoutMs, maxResponseBytes = DEFAULT_RESPONSE_MAX_BYTES },
) {
  const { siteUrl, secret } = brokerConfig(env);
  const response = await fetchImpl(`${siteUrl}${ENDPOINT_PREFIX}/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs),
  });
  const payload = await readBrokerResponse(response, maxResponseBytes);
  if (!response.ok || payload.status !== "ok") {
    const code = typeof payload.code === "string" ? payload.code : "BROKER_REQUEST_FAILED";
    const message =
      typeof payload.message === "string" ? payload.message : "Broker request failed.";
    const retryAfterMs = Number.isFinite(payload.retryAfterMs) ? payload.retryAfterMs : undefined;
    throw new QaCredentialBrokerError(code, `${suffix} failed: ${code} ${message}`, retryAfterMs);
  }
  return payload;
}

function parseChunkedPayloadMarker(payload, { payloadMaxBytes, payloadMaxChunks }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload[CHUNKED_PAYLOAD_MARKER] !== true) return null;
  if (!Number.isSafeInteger(payload.chunkCount) || payload.chunkCount < 1) {
    throw new Error("Chunked credential payload has invalid chunkCount.");
  }
  if (payload.chunkCount > payloadMaxChunks) {
    throw new Error(`Chunked credential payload exceeded ${payloadMaxChunks} chunks.`);
  }
  if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0) {
    throw new Error("Chunked credential payload has invalid byteLength.");
  }
  if (payload.byteLength > payloadMaxBytes) {
    throw new Error(`Chunked credential payload exceeded ${payloadMaxBytes} bytes.`);
  }
  return { chunkCount: payload.chunkCount, byteLength: payload.byteLength };
}

async function resolveCredentialPayload(acquired, identity, requestOptions, limits, leaseHealth) {
  const marker = parseChunkedPayloadMarker(acquired.payload, limits);
  if (!marker) return acquired.payload;
  const chunks = [];
  let byteLength = 0;
  for (let index = 0; index < marker.chunkCount; index += 1) {
    leaseHealth.assertHealthy();
    const chunk = await Promise.race([
      callBroker(
        "payload-chunk",
        { ...identity, index },
        { ...requestOptions, maxResponseBytes: limits.payloadMaxBytes },
      ),
      leaseHealth.whenUnhealthy.then((error) => Promise.reject(error)),
    ]);
    leaseHealth.assertHealthy();
    if (typeof chunk.data !== "string") {
      throw new Error("Broker payload chunk is missing data.");
    }
    byteLength += Buffer.byteLength(chunk.data, "utf8");
    if (byteLength > marker.byteLength) {
      throw new Error("Chunked credential payload exceeded its declared byteLength.");
    }
    chunks.push(chunk.data);
  }
  if (byteLength !== marker.byteLength) {
    throw new Error("Chunked credential payload length mismatch.");
  }
  return JSON.parse(chunks.join(""));
}

export async function acquireQaLease({
  kind,
  ownerId = `qa-lease-${os.hostname()}-${process.pid}-${randomUUID()}`,
  leaseTtlMs = 20 * 60_000,
  heartbeatIntervalMs = 30_000,
  acquireTimeoutMs = 90_000,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  payloadMaxBytes = DEFAULT_PAYLOAD_MAX_BYTES,
  payloadMaxChunks = DEFAULT_PAYLOAD_MAX_CHUNKS,
  env = process.env,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!kind) throw new Error("acquireQaLease requires a credential kind.");
  const requestOptions = { env, fetchImpl, httpTimeoutMs };
  const startedAt = Date.now();
  let acquired;
  for (;;) {
    try {
      acquired = await callBroker(
        "acquire",
        { kind, ownerId, actorRole: "ci", leaseTtlMs, heartbeatIntervalMs },
        requestOptions,
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
  if (!identity.credentialId || !identity.leaseToken) {
    throw new Error("Broker acquire response is missing lease identity.");
  }
  let heartbeatError;
  let heartbeatInFlight;
  let resolveUnhealthy;
  const whenUnhealthy = new Promise((resolve) => {
    resolveUnhealthy = resolve;
  });
  const assertHealthy = () => {
    if (heartbeatError) throw heartbeatError;
  };
  const heartbeat = () => {
    if (heartbeatInFlight || heartbeatError) return heartbeatInFlight;
    heartbeatInFlight = callBroker("heartbeat", { ...identity, leaseTtlMs }, requestOptions)
      .catch((error) => {
        heartbeatError = error;
        resolveUnhealthy(error);
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
    return heartbeatInFlight;
  };
  const initialHeartbeat = heartbeat();
  const timer = setInterval(heartbeat, heartbeatIntervalMs);
  timer.unref?.();
  const stopHeartbeat = async () => {
    clearInterval(timer);
    const inFlight = heartbeatInFlight;
    await inFlight;
  };
  let payload;
  try {
    await initialHeartbeat;
    assertHealthy();
    payload = await resolveCredentialPayload(
      acquired,
      identity,
      requestOptions,
      {
        payloadMaxBytes,
        payloadMaxChunks,
      },
      { assertHealthy, whenUnhealthy },
    );
    assertHealthy();
  } catch (error) {
    try {
      await stopHeartbeat();
      await callBroker("release", identity, requestOptions);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Credential payload hydration and lease release failed.",
      );
    }
    throw error;
  }
  let released = false;
  return {
    payload,
    credentialId: acquired.credentialId,
    whenUnhealthy,
    assertHealthy,
    release: async () => {
      if (released) return;
      released = true;
      await stopHeartbeat();
      await callBroker("release", identity, requestOptions);
    },
  };
}
