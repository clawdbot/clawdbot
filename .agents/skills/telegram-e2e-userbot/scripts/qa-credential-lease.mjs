#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const ENDPOINT_PREFIX = "/qa-credentials/v1";
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";
const CONVEX_BROKER_DEPLOYMENT = "reminiscent-ibex-847";
const CONVEX_BROKER_SITE_URL = `https://${CONVEX_BROKER_DEPLOYMENT}.convex.site`;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_PAYLOAD_MAX_CHUNKS = 4096;
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);
const CONVEX_WRITE_CONTENTION =
  /Documents read from or written to the "credential_sets" table changed while this mutation was being run/u;
const execFile = promisify(execFileCallback);

export class QaCredentialBrokerError extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.name = "QaCredentialBrokerError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryableAcquireError(error) {
  return (
    error instanceof QaCredentialBrokerError &&
    (RETRYABLE_ACQUIRE_CODES.has(error.code) ||
      (error.code === "INTERNAL_ERROR" && CONVEX_WRITE_CONTENTION.test(error.message)))
  );
}

function parseBrokerConfig({ siteUrl, secret, allowInsecureHttp }) {
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
  const allowLoopbackHttp = /^(?:1|true|yes)$/iu.test(allowInsecureHttp?.trim() ?? "");
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

async function defaultRunConvexCli(args, { cwd }) {
  const { stdout } = await execFile("convex", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function resolveBrokerConfig({ env, cwd, runConvexCliImpl, convexProjectDir }) {
  const siteUrl = env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  const secret = env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  if (siteUrl || secret) {
    if (!siteUrl || !secret) {
      throw new Error(
        "Set both OPENCLAW_QA_CONVEX_SITE_URL and OPENCLAW_QA_CONVEX_SECRET_CI, or leave both unset to use Convex CLI authentication.",
      );
    }
    return parseBrokerConfig({
      siteUrl,
      secret,
      allowInsecureHttp: env.OPENCLAW_QA_ALLOW_INSECURE_HTTP,
    });
  }

  const projectDir = convexProjectDir ?? path.join(cwd, "qa", "convex-credential-broker");
  try {
    const cliSecret = (
      await runConvexCliImpl(
        ["env", "--deployment", CONVEX_BROKER_DEPLOYMENT, "get", "OPENCLAW_QA_CONVEX_SECRET_CI"],
        { cwd: projectDir },
      )
    ).trim();
    if (!cliSecret) throw new Error("Convex production broker credential is missing.");
    return parseBrokerConfig({ siteUrl: CONVEX_BROKER_SITE_URL, secret: cliSecret });
  } catch (error) {
    throw new Error(
      "Could not load the QA broker through the Convex CLI. Ask the user to install and authenticate the convex command, then request access to the OpenClaw broker project.",
      { cause: error },
    );
  }
}

async function readBrokerResponse(response, maxBytes) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Broker response exceeded ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
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
  { broker, fetchImpl, httpTimeoutMs, maxResponseBytes = DEFAULT_RESPONSE_MAX_BYTES },
) {
  const { siteUrl, secret } = broker;
  const response = await fetchImpl(`${siteUrl}${ENDPOINT_PREFIX}/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs),
  });
  const payload = await readBrokerResponse(response, maxResponseBytes);
  const acceptsEmptySuccess =
    response.ok &&
    Object.keys(payload).length === 0 &&
    (suffix === "heartbeat" || suffix === "release");
  if (!response.ok || (payload.status !== "ok" && !acceptsEmptySuccess)) {
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
  kind = "",
  ownerId = `qa-lease-${os.hostname()}-${process.pid}-${randomUUID()}`,
  leaseTtlMs = 20 * 60_000,
  heartbeatIntervalMs = 30_000,
  acquireTimeoutMs = 90_000,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  payloadMaxBytes = DEFAULT_PAYLOAD_MAX_BYTES,
  payloadMaxChunks = DEFAULT_PAYLOAD_MAX_CHUNKS,
  env = process.env,
  cwd = process.cwd(),
  runConvexCliImpl = defaultRunConvexCli,
  convexProjectDir,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomImpl = Math.random,
} = {}) {
  if (!kind) throw new Error("acquireQaLease requires a credential kind.");
  const broker = await resolveBrokerConfig({
    env,
    cwd,
    runConvexCliImpl,
    convexProjectDir,
  });
  const requestOptions = { broker, fetchImpl, httpTimeoutMs };
  const startedAt = Date.now();
  let acquired;
  let confirmedAt;
  for (;;) {
    try {
      confirmedAt = { wall: Date.now(), monotonic: performance.now() };
      acquired = await callBroker(
        "acquire",
        { kind, ownerId, actorRole: "ci", leaseTtlMs, heartbeatIntervalMs },
        requestOptions,
      );
      break;
    } catch (error) {
      if (!retryableAcquireError(error)) throw error;
      const remainingMs = acquireTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw error;
      }
      const retryAfterMs =
        error.retryAfterMs ??
        (error.code === "INTERNAL_ERROR" ? 50 + Math.floor(randomImpl() * 250) : 1_000);
      await sleepImpl(Math.min(retryAfterMs, remainingMs));
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
  const invalidate = (error) => {
    if (!heartbeatError) {
      heartbeatError = error;
      resolveUnhealthy(error);
    }
  };
  const assertHealthy = () => {
    // Anchor to request start, not response receipt. Check synchronously at use:
    // a suspended worker must not forward before its heartbeat timer catches up.
    const age = Math.max(Date.now() - confirmedAt.wall, performance.now() - confirmedAt.monotonic);
    if (age >= leaseTtlMs) invalidate(new Error("Credential lease confirmation expired."));
    if (heartbeatError) throw heartbeatError;
  };
  const heartbeat = () => {
    if (heartbeatInFlight || heartbeatError) return heartbeatInFlight;
    try {
      assertHealthy();
    } catch {
      return;
    }
    const requestedAt = { wall: Date.now(), monotonic: performance.now() };
    heartbeatInFlight = callBroker("heartbeat", { ...identity, leaseTtlMs }, requestOptions)
      .then(() => {
        if (heartbeatError) return;
        confirmedAt = requestedAt;
        assertHealthy();
      })
      .catch((error) => {
        invalidate(error);
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
    abandon: async () => {
      invalidate(new Error("Credential lease abandoned; waiting for existing broker expiry."));
      await stopHeartbeat();
    },
    release: async () => {
      if (released) return;
      invalidate(new Error("Credential lease released."));
      await stopHeartbeat();
      await callBroker("release", identity, requestOptions);
      released = true;
    },
  };
}
