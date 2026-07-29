// Qa Lab plugin module implements credential lease behavior.
import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";
import { z } from "zod";
import {
  isQaCredentialTruthyOptIn,
  joinQaCredentialEndpoint,
  normalizeQaCredentialConvexSiteUrl,
  normalizeQaCredentialEndpointPrefix,
  parseQaCredentialPositiveIntegerEnv,
  QA_CREDENTIALS_DEFAULT_ENDPOINT_PREFIX,
} from "../../qa-credentials-common.runtime.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 90_000;
const DEFAULT_ENDPOINT_PREFIX = QA_CREDENTIALS_DEFAULT_ENDPOINT_PREFIX;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1_000;
const DEFAULT_CHUNKED_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHUNKED_PAYLOAD_MAX_CHUNKS = 4096;
const CONVEX_BROKER_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const CHUNKED_PAYLOAD_MAX_BYTES_ENV = "OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES";
const CHUNKED_PAYLOAD_MAX_CHUNKS_ENV = "OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_CHUNKS";
const RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000] as const;
const HEARTBEAT_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";

const convexAcquireSuccessSchema = z.object({
  status: z.literal("ok"),
  credentialId: z.string().min(1),
  leaseToken: z.string().min(1),
  payload: z.unknown(),
  leaseTtlMs: z.number().int().positive().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(),
});

const convexErrorSchema = z.object({
  status: z.literal("error"),
  code: z.string().min(1),
  message: z.string().optional(),
  retryAfterMs: z.number().int().positive().optional(),
});

const convexOkSchema = z.object({
  status: z.literal("ok"),
});

const convexPayloadChunkSuccessSchema = z.object({
  status: z.literal("ok"),
  data: z.string(),
});

type ConvexCredentialBrokerConfig = {
  acquireTimeoutMs: number;
  acquireUrl: string;
  authToken: string;
  heartbeatIntervalMs: number;
  heartbeatUrl: string;
  httpTimeoutMs: number;
  leaseTtlMs: number;
  ownerId: string;
  payloadMaxBytes: number;
  payloadMaxChunks: number;
  payloadChunkUrl: string;
  releaseUrl: string;
  role: QaCredentialRole;
};

type QaCredentialLeaseHeartbeat = {
  getFailure(): Error | null;
  stop(): Promise<void>;
  throwIfFailed(): void;
};

type QaCredentialRole = "ci" | "maintainer";

type QaCredentialLeaseSource = "convex" | "env";

type QaCredentialLease<TPayload> = {
  credentialId?: string;
  heartbeat(): Promise<void>;
  heartbeatIntervalMs: number;
  kind: string;
  leaseToken?: string;
  leaseTtlMs: number;
  ownerId?: string;
  payload: TPayload;
  release(): Promise<void>;
  role?: QaCredentialRole;
  source: QaCredentialLeaseSource;
};

type AcquireQaCredentialLeaseOptions<TPayload> = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  kind: string;
  ownerId?: string;
  parsePayload: (payload: unknown) => TPayload;
  randomImpl?: () => number;
  resolveEnvPayload: () => TPayload;
  role?: string;
  sleepImpl?: (ms: number) => Promise<unknown>;
  source?: string;
  timeImpl?: () => number;
};

class QaCredentialBrokerError extends Error {
  code: string;
  retryAfterMs?: number;

  constructor(params: { code: string; message: string; retryAfterMs?: number }) {
    super(params.message);
    this.name = "QaCredentialBrokerError";
    this.code = params.code;
    this.retryAfterMs = params.retryAfterMs;
  }
}

function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  return parseQaCredentialPositiveIntegerEnv({ env, key, fallback });
}

function normalizeQaCredentialSource(value: string | undefined): QaCredentialLeaseSource {
  const normalized = value?.trim().toLowerCase() || "env";
  if (normalized === "env" || normalized === "convex") {
    return normalized;
  }
  throw new Error(`Credential source must be one of env or convex, got "${value}".`);
}

function normalizeQaCredentialRole(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): QaCredentialRole {
  const defaultRole = isQaCredentialTruthyOptIn(env.CI) ? "ci" : "maintainer";
  const normalized = value?.trim().toLowerCase() || defaultRole;
  if (normalized === "maintainer" || normalized === "ci") {
    return normalized;
  }
  throw new Error(`Credential role must be one of maintainer or ci, got "${value}".`);
}

function normalizeConvexSiteUrl(raw: string, env: NodeJS.ProcessEnv): string {
  return normalizeQaCredentialConvexSiteUrl({ raw, env });
}

function normalizeEndpointPrefix(value: string | undefined): string {
  return normalizeQaCredentialEndpointPrefix({
    value,
    fallback: DEFAULT_ENDPOINT_PREFIX,
    invalidAbsoluteMessage:
      "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must be an absolute path like /qa-credentials/v1.",
    invalidSegmentsMessage:
      "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must not contain backslashes or .. path segments.",
  });
}

function resolveConvexAuthToken(env: NodeJS.ProcessEnv, role: QaCredentialRole): string {
  const roleToken =
    role === "ci"
      ? env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim()
      : env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  const token = roleToken;
  if (token) {
    return token;
  }
  if (role === "ci") {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SECRET_CI for CI credential access.");
  }
  throw new Error("Missing OPENCLAW_QA_CONVEX_SECRET_MAINTAINER for maintainer credential access.");
}

function resolveConvexCredentialBrokerConfig(params: {
  env: NodeJS.ProcessEnv;
  ownerId?: string;
  role: QaCredentialRole;
}): ConvexCredentialBrokerConfig {
  const siteUrl = params.env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  if (!siteUrl) {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SITE_URL for --credential-source convex.");
  }
  const baseUrl = normalizeConvexSiteUrl(siteUrl, params.env);
  const endpointPrefix = normalizeEndpointPrefix(params.env.OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX);
  const ownerId =
    params.ownerId?.trim() ||
    params.env.OPENCLAW_QA_CREDENTIAL_OWNER_ID?.trim() ||
    `qa-lab-${params.role}-${process.pid}-${randomUUID().slice(0, 8)}`;
  return {
    role: params.role,
    ownerId,
    authToken: resolveConvexAuthToken(params.env, params.role),
    leaseTtlMs: parsePositiveIntegerEnv(
      params.env,
      "OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS",
      DEFAULT_LEASE_TTL_MS,
    ),
    heartbeatIntervalMs: parsePositiveIntegerEnv(
      params.env,
      "OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS",
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    acquireTimeoutMs: parsePositiveIntegerEnv(
      params.env,
      "OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS",
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    ),
    httpTimeoutMs: parsePositiveIntegerEnv(
      params.env,
      "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
      DEFAULT_HTTP_TIMEOUT_MS,
    ),
    payloadMaxBytes: parsePositiveIntegerEnv(
      params.env,
      CHUNKED_PAYLOAD_MAX_BYTES_ENV,
      DEFAULT_CHUNKED_PAYLOAD_MAX_BYTES,
    ),
    payloadMaxChunks: parsePositiveIntegerEnv(
      params.env,
      CHUNKED_PAYLOAD_MAX_CHUNKS_ENV,
      DEFAULT_CHUNKED_PAYLOAD_MAX_CHUNKS,
    ),
    acquireUrl: joinQaCredentialEndpoint(baseUrl, endpointPrefix, "acquire"),
    heartbeatUrl: joinQaCredentialEndpoint(baseUrl, endpointPrefix, "heartbeat"),
    payloadChunkUrl: joinQaCredentialEndpoint(baseUrl, endpointPrefix, "payload-chunk"),
    releaseUrl: joinQaCredentialEndpoint(baseUrl, endpointPrefix, "release"),
  };
}

function parseChunkedPayloadMarker(
  payload: unknown,
  limits: { maxBytes: number; maxChunks: number },
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record[CHUNKED_PAYLOAD_MARKER] !== true) {
    return null;
  }
  if (
    typeof record.chunkCount !== "number" ||
    !Number.isInteger(record.chunkCount) ||
    record.chunkCount < 1
  ) {
    throw new Error("Chunked credential payload marker has an invalid chunkCount.");
  }
  if (record.chunkCount > limits.maxChunks) {
    throw new Error(`Chunked credential payload marker exceeds ${limits.maxChunks} chunks.`);
  }
  if (
    typeof record.byteLength !== "number" ||
    !Number.isInteger(record.byteLength) ||
    record.byteLength < 0
  ) {
    throw new Error("Chunked credential payload marker has an invalid byteLength.");
  }
  if (record.byteLength > limits.maxBytes) {
    throw new Error(`Chunked credential payload marker exceeds ${limits.maxBytes} bytes.`);
  }
  return {
    chunkCount: record.chunkCount,
    byteLength: record.byteLength,
  };
}

function toBrokerError(params: {
  payload: unknown;
  fallback: string;
}): QaCredentialBrokerError | null {
  const parsed = convexErrorSchema.safeParse(params.payload);
  if (!parsed.success) {
    return null;
  }
  return new QaCredentialBrokerError({
    code: parsed.data.code,
    message: parsed.data.message?.trim() || params.fallback,
    retryAfterMs: parsed.data.retryAfterMs,
  });
}

async function postConvexBroker(params: {
  authToken: string;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  maxBytes: number;
  timeoutMs: number;
  url: string;
}): Promise<unknown> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const response = await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Keep ordinary broker responses small, while allowing chunk payloads to use
  // the larger declared payload ceiling.
  const text = await readProviderTextResponse(response, "Convex credential broker", {
    maxBytes: params.maxBytes,
  });
  const payload: unknown = (() => {
    if (!text.trim()) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  })();

  const brokerError = toBrokerError({
    payload,
    fallback: `Convex credential broker request failed (${response.status}).`,
  });
  if (brokerError) {
    throw brokerError;
  }
  if (!response.ok) {
    throw new Error(
      `Convex credential broker request to ${params.url} failed with HTTP ${response.status}.`,
    );
  }
  return payload;
}

async function resolveConvexCredentialPayload(params: {
  acquired: z.infer<typeof convexAcquireSuccessSchema>;
  config: ConvexCredentialBrokerConfig;
  fetchImpl: typeof fetch;
  kind: string;
}) {
  const marker = parseChunkedPayloadMarker(params.acquired.payload, {
    maxBytes: params.config.payloadMaxBytes,
    maxChunks: params.config.payloadMaxChunks,
  });
  if (!marker) {
    return params.acquired.payload;
  }
  const chunks: string[] = [];
  let serializedBytes = 0;
  for (let index = 0; index < marker.chunkCount; index += 1) {
    const payload = await postConvexBroker({
      fetchImpl: params.fetchImpl,
      maxBytes: params.config.payloadMaxBytes,
      timeoutMs: params.config.httpTimeoutMs,
      authToken: params.config.authToken,
      url: params.config.payloadChunkUrl,
      body: {
        kind: params.kind,
        ownerId: params.config.ownerId,
        actorRole: params.config.role,
        credentialId: params.acquired.credentialId,
        leaseToken: params.acquired.leaseToken,
        index,
      },
    });
    const parsed = convexPayloadChunkSuccessSchema.parse(payload);
    serializedBytes += Buffer.byteLength(parsed.data, "utf8");
    if (serializedBytes > marker.byteLength) {
      throw new Error("Chunked credential payload exceeded declared byteLength.");
    }
    chunks.push(parsed.data);
  }
  const serialized = chunks.join("");
  if (serializedBytes !== marker.byteLength) {
    throw new Error("Chunked credential payload length mismatch.");
  }
  return JSON.parse(serialized) as unknown;
}

function computeAcquireBackoffMs(params: {
  attempt: number;
  randomImpl: () => number;
  retryAfterMs?: number;
}): number {
  if (params.retryAfterMs && params.retryAfterMs > 0) {
    return params.retryAfterMs;
  }
  const backoffIndex = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, params.attempt - 1));
  const base = expectDefined(RETRY_BACKOFF_MS[backoffIndex], "QA credential retry backoff");
  const jitter = 0.75 + params.randomImpl() * 0.5;
  return Math.max(100, Math.round(base * jitter));
}

function assertConvexOk(payload: unknown, actionLabel: string) {
  if (payload === undefined) {
    return;
  }
  if (convexOkSchema.safeParse(payload).success) {
    return;
  }
  const brokerError = toBrokerError({
    payload,
    fallback: `Convex credential ${actionLabel} failed.`,
  });
  if (brokerError) {
    throw brokerError;
  }
  throw new Error(`Convex credential ${actionLabel} failed with an invalid response payload.`);
}

function isTransientBrokerTransportError(error: unknown) {
  if (error instanceof QaCredentialBrokerError) {
    return false;
  }
  const message = formatErrorMessage(error);
  return (
    /fetch failed|connect timeout error|UND_ERR_[A-Z_]+|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/iu.test(
      message,
    ) || /failed with HTTP 5\d\d\b/iu.test(message)
  );
}

export async function acquireQaCredentialLease<TPayload>(
  opts: AcquireQaCredentialLeaseOptions<TPayload>,
): Promise<QaCredentialLease<TPayload>> {
  const env = opts.env ?? process.env;
  const source = normalizeQaCredentialSource(opts.source ?? env.OPENCLAW_QA_CREDENTIAL_SOURCE);
  if (source === "env") {
    return {
      source: "env",
      kind: opts.kind,
      payload: opts.resolveEnvPayload(),
      heartbeatIntervalMs: 0,
      leaseTtlMs: 0,
      async heartbeat() {},
      async release() {},
    };
  }

  const role = normalizeQaCredentialRole(opts.role ?? env.OPENCLAW_QA_CREDENTIAL_ROLE, env);
  const config = resolveConvexCredentialBrokerConfig({
    env,
    role,
    ownerId: opts.ownerId,
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl =
    opts.sleepImpl ??
    ((ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const timeImpl = opts.timeImpl ?? (() => Date.now());
  const randomImpl = opts.randomImpl ?? (() => Math.random());
  const startedAt = timeImpl();
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const payload = await postConvexBroker({
        fetchImpl,
        maxBytes: CONVEX_BROKER_RESPONSE_MAX_BYTES,
        timeoutMs: config.httpTimeoutMs,
        authToken: config.authToken,
        url: config.acquireUrl,
        body: {
          kind: opts.kind,
          ownerId: config.ownerId,
          actorRole: config.role,
          leaseTtlMs: config.leaseTtlMs,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
        },
      });
      const acquired = convexAcquireSuccessSchema.parse(payload);
      const releaseLease = async () => {
        const releasePayload = await postConvexBroker({
          fetchImpl,
          maxBytes: CONVEX_BROKER_RESPONSE_MAX_BYTES,
          timeoutMs: config.httpTimeoutMs,
          authToken: config.authToken,
          url: config.releaseUrl,
          body: {
            kind: opts.kind,
            ownerId: config.ownerId,
            credentialId: acquired.credentialId,
            leaseToken: acquired.leaseToken,
            actorRole: config.role,
          },
        });
        assertConvexOk(releasePayload, "release");
      };
      let parsedPayload: TPayload;
      try {
        const resolvedPayload = await resolveConvexCredentialPayload({
          acquired,
          config,
          fetchImpl,
          kind: opts.kind,
        });
        parsedPayload = opts.parsePayload(resolvedPayload);
      } catch (error) {
        try {
          await releaseLease();
        } catch (releaseError) {
          throw new Error(
            `Convex credential payload validation failed for kind "${opts.kind}" and cleanup release failed: ${formatErrorMessage(error)}; release failed: ${formatErrorMessage(releaseError)}`,
            { cause: releaseError },
          );
        }
        throw new Error(
          `Convex credential payload validation failed for kind "${opts.kind}": ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
      const leaseTtlMs = acquired.leaseTtlMs ?? config.leaseTtlMs;
      const heartbeatIntervalMs = acquired.heartbeatIntervalMs ?? config.heartbeatIntervalMs;
      return {
        source: "convex",
        kind: opts.kind,
        role,
        ownerId: config.ownerId,
        credentialId: acquired.credentialId,
        leaseToken: acquired.leaseToken,
        leaseTtlMs,
        heartbeatIntervalMs,
        payload: parsedPayload,
        async heartbeat() {
          const heartbeatPayload = await postConvexBroker({
            fetchImpl,
            maxBytes: CONVEX_BROKER_RESPONSE_MAX_BYTES,
            timeoutMs: config.httpTimeoutMs,
            authToken: config.authToken,
            url: config.heartbeatUrl,
            body: {
              kind: opts.kind,
              ownerId: config.ownerId,
              credentialId: acquired.credentialId,
              leaseToken: acquired.leaseToken,
              actorRole: config.role,
              leaseTtlMs,
            },
          });
          assertConvexOk(heartbeatPayload, "heartbeat");
        },
        async release() {
          await releaseLease();
        },
      };
    } catch (error) {
      const retryablePoolError =
        error instanceof QaCredentialBrokerError && RETRYABLE_ACQUIRE_CODES.has(error.code);
      const transientTransportError = isTransientBrokerTransportError(error);
      if (retryablePoolError || transientTransportError) {
        const elapsed = timeImpl() - startedAt;
        if (elapsed >= config.acquireTimeoutMs) {
          const message = retryablePoolError
            ? `Convex credential pool exhausted for kind "${opts.kind}" after ${config.acquireTimeoutMs}ms.`
            : `Convex credential broker remained unreachable for kind "${opts.kind}" after ${config.acquireTimeoutMs}ms.`;
          throw new Error(message, { cause: error });
        }
        const delayMs = Math.min(
          computeAcquireBackoffMs({
            attempt,
            retryAfterMs: retryablePoolError ? error.retryAfterMs : undefined,
            randomImpl,
          }),
          Math.max(0, config.acquireTimeoutMs - elapsed),
        );
        if (delayMs > 0) {
          await sleepImpl(delayMs);
        }
        continue;
      }
      if (error instanceof z.ZodError) {
        throw new Error(
          `Convex credential acquire response did not match the expected payload for kind "${opts.kind}": ${error.message}`,
          { cause: error },
        );
      }
      throw new Error(
        `Convex credential acquire failed for kind "${opts.kind}": ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

export function startQaCredentialLeaseHeartbeat(
  lease: Pick<QaCredentialLease<unknown>, "heartbeat" | "heartbeatIntervalMs" | "kind" | "source">,
  opts?: {
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
  },
): QaCredentialLeaseHeartbeat {
  if (lease.source !== "convex") {
    return {
      getFailure: () => null,
      async stop() {},
      throwIfFailed() {},
    };
  }
  const intervalMs = opts?.intervalMs ?? lease.heartbeatIntervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    return {
      getFailure: () => null,
      async stop() {},
      throwIfFailed() {},
    };
  }

  const setTimeoutImpl = opts?.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = opts?.clearTimeoutImpl ?? clearTimeout;
  const retryDelaysMs = opts?.retryDelaysMs ?? HEARTBEAT_RETRY_DELAYS_MS;
  let failure: Error | null = null;
  let retryAttempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const schedule = (delayMs = intervalMs) => {
    if (stopped || failure) {
      return;
    }
    timer = setTimeoutImpl(() => {
      timer = null;
      if (stopped || failure) {
        return;
      }
      inFlight = (async () => {
        try {
          await lease.heartbeat();
          retryAttempt = 0;
        } catch (error) {
          if (isTransientBrokerTransportError(error) && retryAttempt < retryDelaysMs.length) {
            const retryDelayMs = expectDefined(
              retryDelaysMs[retryAttempt],
              "QA credential heartbeat retry delay",
            );
            retryAttempt += 1;
            schedule(resolveTimerTimeoutMs(retryDelayMs, 1_000, 0));
            return;
          }
          failure = new Error(
            `Credential lease heartbeat failed for kind "${lease.kind}": ${formatErrorMessage(error)}`,
          );
          return;
        } finally {
          inFlight = null;
        }
        schedule();
      })();
    }, delayMs);
  };

  schedule();

  return {
    getFailure() {
      return failure;
    },
    throwIfFailed() {
      if (failure) {
        throw failure;
      }
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight.catch(() => {});
      }
    },
  };
}
