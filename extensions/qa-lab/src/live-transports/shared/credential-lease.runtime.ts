import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { z } from "zod";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 90_000;
const DEFAULT_ENDPOINT_PREFIX = "/qa-credentials/v1";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1_000;
const ALLOW_INSECURE_HTTP_ENV_KEY = "OPENCLAW_QA_ALLOW_INSECURE_HTTP";
const RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000] as const;
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);

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

type ConvexCredentialBrokerConfig = {
  acquireTimeoutMs: number;
  acquireUrl: string;
  authToken: string;
  heartbeatIntervalMs: number;
  heartbeatUrl: string;
  httpTimeoutMs: number;
  leaseTtlMs: number;
  ownerId: string;
  releaseUrl: string;
  role: QaCredentialRole;
};

export type QaCredentialLeaseHeartbeat = {
  getFailure(): Error | null;
  stop(): Promise<void>;
  throwIfFailed(): void;
};

export type QaCredentialRole = "ci" | "maintainer";

export type QaCredentialLeaseSource = "convex" | "env";

export type QaCredentialLease<TPayload> = {
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

export type AcquireQaCredentialLeaseOptions<TPayload> = {
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
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
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
  const defaultRole = isTruthyOptIn(env.CI) ? "ci" : "maintainer";
  const normalized = value?.trim().toLowerCase() || defaultRole;
  if (normalized === "maintainer" || normalized === "ci") {
    return normalized;
  }
  throw new Error(`Credential role must be one of maintainer or ci, got "${value}".`);
}

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

function normalizeConvexSiteUrl(raw: string, env: NodeJS.ProcessEnv): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OPENCLAW_QA_CONVEX_SITE_URL must be a valid URL, got "${raw || "<empty>"}".`);
  }
  if (url.protocol === "https:") {
    const text = url.toString();
    return text.endsWith("/") ? text.slice(0, -1) : text;
  }
  if (url.protocol !== "http:") {
    throw new Error("OPENCLAW_QA_CONVEX_SITE_URL must use https://.");
  }
  const allowInsecureHttp = isTruthyOptIn(env[ALLOW_INSECURE_HTTP_ENV_KEY]);
  if (!allowInsecureHttp || !isLoopbackHostname(url.hostname)) {
    throw new Error(
      `OPENCLAW_QA_CONVEX_SITE_URL must use https://. http:// is only allowed for loopback hosts when ${ALLOW_INSECURE_HTTP_ENV_KEY}=1.`,
    );
  }
  const text = url.toString();
  return text.endsWith("/") ? text.slice(0, -1) : text;
}

function normalizeEndpointPrefix(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_ENDPOINT_PREFIX;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    throw new Error(
      "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must be an absolute path like /qa-credentials/v1.",
    );
  }
  if (normalized.includes("\\") || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(
      "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must not contain backslashes or .. path segments.",
    );
  }
  return normalized;
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

function joinConvexEndpoint(baseUrl: string, prefix: string, suffix: string): string {
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  const url = new URL(baseUrl);
  url.pathname = `${prefix}${normalizedSuffix}`.replace(/\/{2,}/gu, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
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
    acquireUrl: joinConvexEndpoint(baseUrl, endpointPrefix, "acquire"),
    heartbeatUrl: joinConvexEndpoint(baseUrl, endpointPrefix, "heartbeat"),
    releaseUrl: joinConvexEndpoint(baseUrl, endpointPrefix, "release"),
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
  timeoutMs: number;
  url: string;
}): Promise<unknown> {
  const response = await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  const text = await response.text();
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

function computeAcquireBackoffMs(params: {
  attempt: number;
  randomImpl: () => number;
  retryAfterMs?: number;
}): number {
  if (params.retryAfterMs && params.retryAfterMs > 0) {
    return params.retryAfterMs;
  }
  const base = RETRY_BACKOFF_MS[Math.min(RETRY_BACKOFF_MS.length - 1, params.attempt - 1)];
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
    opts.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeImpl = opts.timeImpl ?? (() => Date.now());
  const randomImpl = opts.randomImpl ?? (() => Math.random());
  const startedAt = timeImpl();
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const payload = await postConvexBroker({
        fetchImpl,
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
        parsedPayload = opts.parsePayload(acquired.payload);
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
      if (error instanceof QaCredentialBrokerError && RETRYABLE_ACQUIRE_CODES.has(error.code)) {
        const elapsed = timeImpl() - startedAt;
        if (elapsed >= config.acquireTimeoutMs) {
          throw new Error(
            `Convex credential pool exhausted for kind "${opts.kind}" after ${config.acquireTimeoutMs}ms.`,
            { cause: error },
          );
        }
        const delayMs = Math.min(
          computeAcquireBackoffMs({
            attempt,
            retryAfterMs: error.retryAfterMs,
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
  let failure: Error | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const schedule = () => {
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
        } catch (error) {
          failure = new Error(
            `Credential lease heartbeat failed for kind "${lease.kind}": ${formatErrorMessage(error)}`,
          );
          return;
        } finally {
          inFlight = null;
        }
        schedule();
      })();
    }, intervalMs);
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

export const __testing = {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_ENDPOINT_PREFIX,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  computeAcquireBackoffMs,
  normalizeQaCredentialRole,
  normalizeQaCredentialSource,
  parsePositiveIntegerEnv,
  resolveConvexCredentialBrokerConfig,
};
