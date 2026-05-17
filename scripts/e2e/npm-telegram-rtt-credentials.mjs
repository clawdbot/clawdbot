#!/usr/bin/env node
import fs from "node:fs/promises";

const DEFAULT_ENDPOINT_PREFIX = "/qa-credentials/v1";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 90_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1_000;
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";
const RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000];
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);

function parseArgs(argv) {
  const command = argv[2];
  const opts = new Map();
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const value = argv[++index];
    if (!value) {
      throw new Error(`${arg} requires a value.`);
    }
    opts.set(arg.slice(2), value);
  }
  if (!command || !["acquire", "heartbeat", "release"].includes(command)) {
    throw new Error(
      "Usage: npm-telegram-rtt-credentials.mjs acquire|heartbeat|release --lease-file PATH [--credential-env-file PATH]",
    );
  }
  return { command, opts };
}

function requireOption(opts, key) {
  const value = opts.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing --${key}.`);
  }
  return value;
}

function requireString(record, key) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Credential payload is missing ${key}.`);
  }
  return value.trim();
}

class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function parsePositiveInteger(value, fallback, label) {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  return parsed;
}

function normalizeCredentialRole() {
  const raw =
    process.env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE?.trim() ||
    process.env.OPENCLAW_QA_CREDENTIAL_ROLE?.trim() ||
    (process.env.CI ? "ci" : "maintainer");
  const normalized = raw.toLowerCase();
  if (normalized === "ci" || normalized === "maintainer") {
    return normalized;
  }
  throw new Error(`Credential role must be maintainer or ci; got: ${raw}`);
}

function normalizeEndpointPrefix() {
  const raw = process.env.OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX?.trim() || DEFAULT_ENDPOINT_PREFIX;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("..")) {
    throw new Error(
      "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must be an absolute path like /qa-credentials/v1.",
    );
  }
  return raw.replace(/\/+$/u, "") || "/";
}

function resolveConfig() {
  const siteUrl = process.env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  if (!siteUrl) {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SITE_URL for --credential-source convex.");
  }
  const parsed = new URL(siteUrl);
  const allowInsecure = /^(1|true|yes)$/iu.test(process.env.OPENCLAW_QA_ALLOW_INSECURE_HTTP ?? "");
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && allowInsecure && isLoopback)
  ) {
    throw new Error("OPENCLAW_QA_CONVEX_SITE_URL must use https://.");
  }
  const role = normalizeCredentialRole();
  const authToken =
    role === "ci"
      ? process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim()
      : process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  if (!authToken) {
    throw new Error(
      role === "ci"
        ? "Missing OPENCLAW_QA_CONVEX_SECRET_CI for CI credential access."
        : "Missing OPENCLAW_QA_CONVEX_SECRET_MAINTAINER for maintainer credential access.",
    );
  }
  const endpointPrefix = normalizeEndpointPrefix();
  const ownerId =
    process.env.OPENCLAW_QA_CREDENTIAL_OWNER_ID?.trim() ||
    `npm-telegram-rtt-${process.pid}-${Date.now()}`;
  const joinEndpoint = (endpoint) =>
    `${siteUrl.replace(/\/+$/u, "")}${endpointPrefix}/${endpoint.replace(/^\/+/u, "")}`;
  return {
    acquireUrl: joinEndpoint("acquire"),
    acquireTimeoutMs: parsePositiveInteger(
      process.env.OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS,
      DEFAULT_ACQUIRE_TIMEOUT_MS,
      "OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS",
    ),
    heartbeatIntervalMs: parsePositiveInteger(
      process.env.OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS",
    ),
    heartbeatUrl: joinEndpoint("heartbeat"),
    httpTimeoutMs: parsePositiveInteger(
      process.env.OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS,
      DEFAULT_HTTP_TIMEOUT_MS,
      "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
    ),
    leaseTtlMs: parsePositiveInteger(
      process.env.OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS,
      DEFAULT_LEASE_TTL_MS,
      "OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS",
    ),
    ownerId,
    payloadChunkUrl: joinEndpoint("payload-chunk"),
    releaseUrl: joinEndpoint("release"),
    role,
    siteUrl,
    authToken,
  };
}

async function postBroker(params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const rawPayload = await response.text();
    const payload = rawPayload.trim()
      ? JSON.parse(rawPayload)
      : response.ok
        ? { status: "ok" }
        : {};
    if (!response.ok || payload?.status === "error") {
      const message =
        typeof payload?.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : `HTTP ${response.status}`;
      throw new BrokerError(message, {
        code: typeof payload?.code === "string" ? payload.code : undefined,
        retryAfterMs: Number.isInteger(payload?.retryAfterMs) ? payload.retryAfterMs : undefined,
      });
    }
    if (payload?.status !== "ok") {
      throw new Error("Convex credential broker returned an invalid response.");
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseChunkedPayloadMarker(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  if (payload[CHUNKED_PAYLOAD_MARKER] !== true) {
    return undefined;
  }
  if (!Number.isInteger(payload.chunkCount) || payload.chunkCount < 1) {
    throw new Error("Chunked credential payload has invalid chunkCount.");
  }
  if (!Number.isInteger(payload.byteLength) || payload.byteLength < 0) {
    throw new Error("Chunked credential payload has invalid byteLength.");
  }
  return { byteLength: payload.byteLength, chunkCount: payload.chunkCount };
}

function parseTelegramCredentialPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Telegram credential payload must be an object.");
  }
  const groupId = requireString(payload, "groupId");
  if (!/^-?\d+$/u.test(groupId)) {
    throw new Error("Telegram credential payload groupId must be a numeric Telegram chat id.");
  }
  return {
    groupId,
    driverToken: requireString(payload, "driverToken"),
    sutToken: requireString(payload, "sutToken"),
  };
}

async function resolveCredentialPayload(config, acquired) {
  const marker = parseChunkedPayloadMarker(acquired.payload);
  if (!marker) {
    return parseTelegramCredentialPayload(acquired.payload);
  }
  const chunks = [];
  for (let index = 0; index < marker.chunkCount; index += 1) {
    const chunk = await postBroker({
      authToken: config.authToken,
      timeoutMs: config.httpTimeoutMs,
      url: config.payloadChunkUrl,
      body: {
        kind: "telegram",
        ownerId: config.ownerId,
        actorRole: config.role,
        credentialId: requireString(acquired, "credentialId"),
        leaseToken: requireString(acquired, "leaseToken"),
        index,
      },
    });
    chunks.push(requireString(chunk, "data"));
  }
  const serialized = chunks.join("");
  if (serialized.length !== marker.byteLength) {
    throw new Error("Chunked credential payload length mismatch.");
  }
  return parseTelegramCredentialPayload(JSON.parse(serialized));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeCredentialEnv(pathname, payload) {
  await fs.writeFile(
    pathname,
    [
      `export OPENCLAW_QA_TELEGRAM_GROUP_ID=${shellQuote(payload.groupId)}`,
      `export OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN=${shellQuote(payload.driverToken)}`,
      `export OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN=${shellQuote(payload.sutToken)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function readLease(pathname) {
  return JSON.parse(await fs.readFile(pathname, "utf8"));
}

function leaseTtlMsFromLease(config, lease) {
  const value = lease.leaseTtlMs;
  if (value === undefined || value === null) {
    return config.leaseTtlMs;
  }
  return parsePositiveInteger(String(value), config.leaseTtlMs, "leaseTtlMs");
}

async function acquire(opts) {
  const config = resolveConfig();
  const leaseFile = requireOption(opts, "lease-file");
  const envFile = requireOption(opts, "credential-env-file");
  const acquired = await acquireWithRetry(config);
  const lease = {
    kind: "telegram",
    ownerId: config.ownerId,
    actorRole: config.role,
    credentialId: requireString(acquired, "credentialId"),
    leaseToken: requireString(acquired, "leaseToken"),
    heartbeatIntervalMs: acquired.heartbeatIntervalMs ?? config.heartbeatIntervalMs,
    leaseTtlMs: acquired.leaseTtlMs ?? config.leaseTtlMs,
  };
  try {
    await writeCredentialEnv(envFile, await resolveCredentialPayload(config, acquired));
    await fs.writeFile(leaseFile, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await releaseLease(config, lease).catch(() => {});
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ status: "ok", credentialId: lease.credentialId, ownerId: lease.ownerId }, null, 2)}\n`,
  );
}

async function acquireWithRetry(config) {
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await postBroker({
        authToken: config.authToken,
        timeoutMs: config.httpTimeoutMs,
        url: config.acquireUrl,
        body: {
          kind: "telegram",
          ownerId: config.ownerId,
          actorRole: config.role,
          leaseTtlMs: config.leaseTtlMs,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
        },
      });
    } catch (error) {
      const code = error instanceof BrokerError ? error.code : undefined;
      const retryable = code ? RETRYABLE_ACQUIRE_CODES.has(code) : false;
      const elapsedMs = Date.now() - startedAt;
      if (!retryable || elapsedMs >= config.acquireTimeoutMs) {
        throw error;
      }
      const fallbackDelay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      const retryAfterMs = error instanceof BrokerError ? error.retryAfterMs : undefined;
      const delayMs = retryAfterMs ?? fallbackDelay;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delayMs, Math.max(config.acquireTimeoutMs - elapsedMs, 0))),
      );
    }
  }
}

async function releaseLease(config, lease) {
  await postBroker({
    authToken: config.authToken,
    timeoutMs: config.httpTimeoutMs,
    url: config.releaseUrl,
    body: {
      kind: requireString(lease, "kind"),
      ownerId: requireString(lease, "ownerId"),
      actorRole: requireString(lease, "actorRole"),
      credentialId: requireString(lease, "credentialId"),
      leaseToken: requireString(lease, "leaseToken"),
    },
  });
}

async function release(opts) {
  const config = resolveConfig();
  const leaseFile = requireOption(opts, "lease-file");
  const lease = await readLease(leaseFile);
  await releaseLease(config, lease);
  await fs.rm(leaseFile, { force: true });
}

async function heartbeat(opts) {
  const config = resolveConfig();
  const leaseFile = requireOption(opts, "lease-file");
  while (true) {
    const lease = await readLease(leaseFile);
    await postBroker({
      authToken: config.authToken,
      timeoutMs: config.httpTimeoutMs,
      url: config.heartbeatUrl,
      body: {
        kind: requireString(lease, "kind"),
        ownerId: requireString(lease, "ownerId"),
        actorRole: requireString(lease, "actorRole"),
        credentialId: requireString(lease, "credentialId"),
        leaseTtlMs: leaseTtlMsFromLease(config, lease),
        leaseToken: requireString(lease, "leaseToken"),
      },
    });
    const intervalMs = parsePositiveInteger(
      String(lease.heartbeatIntervalMs ?? config.heartbeatIntervalMs),
      config.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const { command, opts } = parseArgs(process.argv);
if (command === "acquire") {
  await acquire(opts);
} else if (command === "heartbeat") {
  await heartbeat(opts);
} else {
  await release(opts);
}
