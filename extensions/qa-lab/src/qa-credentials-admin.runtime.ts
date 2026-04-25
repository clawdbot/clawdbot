import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { z } from "zod";
import {
  joinQaCredentialEndpoint,
  normalizeQaCredentialConvexSiteUrl,
  normalizeQaCredentialEndpointPrefix,
  parseQaCredentialPositiveIntegerEnv,
  QA_CREDENTIALS_DEFAULT_ENDPOINT_PREFIX,
} from "./qa-credentials-common.runtime.js";

const DEFAULT_ENDPOINT_PREFIX = QA_CREDENTIALS_DEFAULT_ENDPOINT_PREFIX;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

const actorRoleSchema = z.union([z.literal("ci"), z.literal("maintainer")]);
const credentialStatusSchema = z.union([z.literal("active"), z.literal("disabled")]);
const listStatusSchema = z.union([z.literal("active"), z.literal("disabled"), z.literal("all")]);

const brokerErrorSchema = z.object({
  status: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
});

const credentialLeaseSchema = z.object({
  ownerId: z.string().min(1),
  actorRole: actorRoleSchema,
  acquiredAtMs: z.number().int(),
  heartbeatAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
});

const credentialRecordSchema = z.object({
  credentialId: z.string().min(1),
  kind: z.string().min(1),
  status: credentialStatusSchema,
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  lastLeasedAtMs: z.number().int(),
  note: z.string().optional(),
  lease: credentialLeaseSchema.optional(),
  payload: z.unknown().optional(),
});

const addCredentialResponseSchema = z.object({
  status: z.literal("ok"),
  credential: credentialRecordSchema,
});

const removeCredentialResponseSchema = z.object({
  status: z.literal("ok"),
  changed: z.boolean(),
  credential: credentialRecordSchema,
});

const listCredentialsResponseSchema = z.object({
  status: z.literal("ok"),
  credentials: z.array(credentialRecordSchema),
  count: z.number().int().nonnegative().optional(),
});

export type QaCredentialAdminListStatus = z.infer<typeof listStatusSchema>;
export type QaCredentialRecord = z.infer<typeof credentialRecordSchema>;
export type QaCredentialListResponse = z.infer<typeof listCredentialsResponseSchema>;

export class QaCredentialAdminError extends Error {
  code: string;
  httpStatus?: number;

  constructor(params: { code: string; message: string; httpStatus?: number }) {
    super(params.message);
    this.name = "QaCredentialAdminError";
    this.code = params.code;
    this.httpStatus = params.httpStatus;
  }
}

type AdminConfig = {
  actorId: string;
  authToken: string;
  addUrl: string;
  endpointPrefix: string;
  httpTimeoutMs: number;
  listUrl: string;
  removeUrl: string;
  siteUrl: string;
};

type AdminBaseOptions = {
  actorId?: string;
  endpointPrefix?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  siteUrl?: string;
};

type AddQaCredentialSetOptions = AdminBaseOptions & {
  kind: string;
  note?: string;
  payload: Record<string, unknown>;
  status?: z.infer<typeof credentialStatusSchema>;
};

type RemoveQaCredentialSetOptions = AdminBaseOptions & {
  credentialId: string;
};

type ListQaCredentialSetsOptions = AdminBaseOptions & {
  includePayload?: boolean;
  kind?: string;
  limit?: number;
  status?: string;
};

export type QaCredentialDoctorCheck = {
  details?: string;
  name: string;
  status: "fail" | "pass" | "warn";
};

export type QaCredentialDoctorResult = {
  checks: QaCredentialDoctorCheck[];
  status: "fail" | "pass" | "warn";
};

function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  return parseQaCredentialPositiveIntegerEnv({
    env,
    key,
    fallback,
    toError: (message) =>
      new QaCredentialAdminError({
        code: "INVALID_ENV",
        message,
      }),
  });
}

function normalizeConvexSiteUrl(raw: string, env: NodeJS.ProcessEnv): string {
  return normalizeQaCredentialConvexSiteUrl({
    raw,
    env,
    toError: (message) =>
      new QaCredentialAdminError({
        code: "INVALID_SITE_URL",
        message,
      }),
  });
}

function normalizeEndpointPrefix(value: string | undefined): string {
  return normalizeQaCredentialEndpointPrefix({
    value,
    fallback: DEFAULT_ENDPOINT_PREFIX,
    invalidAbsoluteMessage:
      '--endpoint-prefix must be an absolute path like "/qa-credentials/v1" (not //host).',
    invalidSegmentsMessage: '--endpoint-prefix must not contain backslashes or ".." path segments.',
    toError: (message) =>
      new QaCredentialAdminError({
        code: "INVALID_ARGUMENT",
        message,
      }),
  });
}

function resolveAdminAuthToken(env: NodeJS.ProcessEnv): string {
  const token = env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  if (token) {
    return token;
  }
  throw new QaCredentialAdminError({
    code: "MISSING_MAINTAINER_SECRET",
    message: "Missing OPENCLAW_QA_CONVEX_SECRET_MAINTAINER for qa credential admin commands.",
  });
}

function addQaCredentialDoctorCheck(
  checks: QaCredentialDoctorCheck[],
  check: QaCredentialDoctorCheck,
) {
  checks.push(check);
}

function summarizeQaCredentialDoctorStatus(checks: readonly QaCredentialDoctorCheck[]) {
  if (checks.some((check) => check.status === "fail")) {
    return "fail" as const;
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn" as const;
  }
  return "pass" as const;
}

export async function diagnoseQaCredentialBroker(options: AdminBaseOptions = {}) {
  const env = options.env ?? process.env;
  const checks: QaCredentialDoctorCheck[] = [];
  const siteUrl = options.siteUrl?.trim() || env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  const endpointPrefix = options.endpointPrefix?.trim() || env.OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX;
  let normalizedSiteUrl: string | null = null;
  let normalizedEndpointPrefix: string | null = null;

  if (!siteUrl) {
    addQaCredentialDoctorCheck(checks, {
      name: "OPENCLAW_QA_CONVEX_SITE_URL",
      status: "fail",
      details: "missing Convex credential broker site URL",
    });
  } else {
    try {
      normalizedSiteUrl = normalizeConvexSiteUrl(siteUrl, env);
      addQaCredentialDoctorCheck(checks, {
        name: "OPENCLAW_QA_CONVEX_SITE_URL",
        status: "pass",
        details: normalizedSiteUrl,
      });
    } catch (error) {
      addQaCredentialDoctorCheck(checks, {
        name: "OPENCLAW_QA_CONVEX_SITE_URL",
        status: "fail",
        details: formatErrorMessage(error),
      });
    }
  }

  try {
    normalizedEndpointPrefix = normalizeEndpointPrefix(endpointPrefix);
    addQaCredentialDoctorCheck(checks, {
      name: "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX",
      status: "pass",
      details: normalizedEndpointPrefix,
    });
  } catch (error) {
    addQaCredentialDoctorCheck(checks, {
      name: "OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX",
      status: "fail",
      details: formatErrorMessage(error),
    });
  }

  for (const [name, requiredFor] of [
    ["OPENCLAW_QA_CONVEX_SECRET_CI", "live lane leasing"],
    ["OPENCLAW_QA_CONVEX_SECRET_MAINTAINER", "credential add/list/remove"],
  ] as const) {
    const present = Boolean(env[name]?.trim());
    addQaCredentialDoctorCheck(checks, {
      name,
      status: present ? "pass" : "warn",
      details: present ? "set" : `missing; required for ${requiredFor}`,
    });
  }

  try {
    const timeoutMs = parsePositiveIntegerEnv(
      env,
      "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
      DEFAULT_HTTP_TIMEOUT_MS,
    );
    addQaCredentialDoctorCheck(checks, {
      name: "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
      status: "pass",
      details: `${timeoutMs}ms`,
    });
  } catch (error) {
    addQaCredentialDoctorCheck(checks, {
      name: "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
      status: "fail",
      details: formatErrorMessage(error),
    });
  }

  if (normalizedSiteUrl && normalizedEndpointPrefix && env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER) {
    try {
      const listed = await listQaCredentialSets({
        actorId: options.actorId,
        endpointPrefix: normalizedEndpointPrefix,
        env,
        fetchImpl: options.fetchImpl,
        limit: 1,
        siteUrl: normalizedSiteUrl,
        status: "active",
      });
      addQaCredentialDoctorCheck(checks, {
        name: "broker admin/list",
        status: "pass",
        details: `reachable; sampled ${listed.credentials.length} active credential row${listed.credentials.length === 1 ? "" : "s"}`,
      });
    } catch (error) {
      addQaCredentialDoctorCheck(checks, {
        name: "broker admin/list",
        status: "fail",
        details: formatErrorMessage(error),
      });
    }
  } else {
    addQaCredentialDoctorCheck(checks, {
      name: "broker admin/list",
      status: "warn",
      details: "skipped; site URL and maintainer secret are required",
    });
  }

  return {
    checks,
    status: summarizeQaCredentialDoctorStatus(checks),
  } satisfies QaCredentialDoctorResult;
}

function resolveAdminConfig(options: AdminBaseOptions): AdminConfig {
  const env = options.env ?? process.env;
  const siteUrl = options.siteUrl?.trim() || env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  if (!siteUrl) {
    throw new QaCredentialAdminError({
      code: "MISSING_SITE_URL",
      message: "Missing OPENCLAW_QA_CONVEX_SITE_URL for qa credential admin commands.",
    });
  }
  const normalizedSiteUrl = normalizeConvexSiteUrl(siteUrl, env);
  const endpointPrefix = normalizeEndpointPrefix(
    options.endpointPrefix?.trim() || env.OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX,
  );
  const actorId =
    options.actorId?.trim() ||
    env.OPENCLAW_QA_CREDENTIAL_OWNER_ID?.trim() ||
    `qa-lab-admin-${process.pid}-${randomUUID().slice(0, 8)}`;

  return {
    actorId,
    authToken: resolveAdminAuthToken(env),
    siteUrl: normalizedSiteUrl,
    endpointPrefix,
    httpTimeoutMs: parsePositiveIntegerEnv(
      env,
      "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
      DEFAULT_HTTP_TIMEOUT_MS,
    ),
    addUrl: joinQaCredentialEndpoint(normalizedSiteUrl, endpointPrefix, "admin/add"),
    removeUrl: joinQaCredentialEndpoint(normalizedSiteUrl, endpointPrefix, "admin/remove"),
    listUrl: joinQaCredentialEndpoint(normalizedSiteUrl, endpointPrefix, "admin/list"),
  };
}

function parseJsonResponsePayload(text: string) {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toBrokerError(payload: unknown, httpStatus: number) {
  const parsed = brokerErrorSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return new QaCredentialAdminError({
    code: parsed.data.code,
    message: parsed.data.message,
    httpStatus,
  });
}

async function postJson<T>(params: {
  authToken: string;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  httpTimeoutMs: number;
  responseSchema: z.ZodType<T>;
  url: string;
}) {
  let response: Response;
  try {
    response = await params.fetchImpl(params.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: AbortSignal.timeout(params.httpTimeoutMs),
    });
  } catch (error) {
    throw new QaCredentialAdminError({
      code: "BROKER_REQUEST_FAILED",
      message: `Convex credential admin request failed: ${formatErrorMessage(error)}`,
    });
  }

  const text = await response.text();
  const payload = parseJsonResponsePayload(text);

  const brokerError = toBrokerError(payload, response.status);
  if (brokerError) {
    throw brokerError;
  }
  if (!response.ok) {
    throw new QaCredentialAdminError({
      code: "BROKER_HTTP_ERROR",
      message: `Convex credential admin request failed with HTTP ${response.status}.`,
      httpStatus: response.status,
    });
  }

  const parsed = params.responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new QaCredentialAdminError({
      code: "INVALID_RESPONSE",
      message: `Convex credential admin response did not match expected shape: ${parsed.error.message}`,
      httpStatus: response.status,
    });
  }

  return parsed.data;
}

function normalizeStatus(value: string | undefined): QaCredentialAdminListStatus | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const parsed = listStatusSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new QaCredentialAdminError({
      code: "INVALID_ARGUMENT",
      message: '--status must be one of "active", "disabled", or "all".',
    });
  }
  return parsed.data;
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new QaCredentialAdminError({
      code: "INVALID_ARGUMENT",
      message: "--limit must be a positive integer.",
    });
  }
  return value;
}

export async function addQaCredentialSet(options: AddQaCredentialSetOptions) {
  const config = resolveAdminConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  return await postJson({
    fetchImpl,
    authToken: config.authToken,
    httpTimeoutMs: config.httpTimeoutMs,
    url: config.addUrl,
    responseSchema: addCredentialResponseSchema,
    body: {
      kind: options.kind,
      payload: options.payload,
      ...(options.note ? { note: options.note } : {}),
      ...(options.status ? { status: options.status } : {}),
      actorId: config.actorId,
    },
  });
}

export async function removeQaCredentialSet(options: RemoveQaCredentialSetOptions) {
  const config = resolveAdminConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  return await postJson({
    fetchImpl,
    authToken: config.authToken,
    httpTimeoutMs: config.httpTimeoutMs,
    url: config.removeUrl,
    responseSchema: removeCredentialResponseSchema,
    body: {
      credentialId: options.credentialId,
      actorId: config.actorId,
    },
  });
}

export async function listQaCredentialSets(options: ListQaCredentialSetsOptions) {
  const config = resolveAdminConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const status = normalizeStatus(options.status);
  const limit = normalizeLimit(options.limit);
  return await postJson({
    fetchImpl,
    authToken: config.authToken,
    httpTimeoutMs: config.httpTimeoutMs,
    url: config.listUrl,
    responseSchema: listCredentialsResponseSchema,
    body: {
      ...(options.kind ? { kind: options.kind } : {}),
      ...(status ? { status } : {}),
      ...(options.includePayload === true ? { includePayload: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  });
}

export const __testing = {
  DEFAULT_ENDPOINT_PREFIX,
  DEFAULT_HTTP_TIMEOUT_MS,
  normalizeConvexSiteUrl,
  normalizeEndpointPrefix,
  normalizeStatus,
  parsePositiveIntegerEnv,
  resolveAdminConfig,
};
