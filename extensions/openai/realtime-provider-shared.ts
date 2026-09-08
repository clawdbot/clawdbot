// Openai provider module implements model/runtime integration.
import { resolveExpiresAtMsFromEpochSeconds } from "openclaw/plugin-sdk/number-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenAIRealtimeHost } from "./realtime-host.js";

const OPENAI_REALTIME_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_REALTIME_SSRF_POLICY = {
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
  hostnameAllowlist: [new URL(OPENAI_REALTIME_API_BASE_URL).hostname],
} satisfies SsrFPolicy;
// Secret minting blocks interactive Talk setup; keep this absolute budget aligned
// with the maintained realtime Talk live smoke.
const OPENAI_REALTIME_CLIENT_SECRET_REQUEST_TIMEOUT_MS = 30_000;

export function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const message = asOptionalRecord(error)?.message;
  if (typeof message === "string" && message) {
    return message;
  }
  return "Unknown error";
}

export function resolveOpenAIProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(config.providers);
  return (
    asOptionalRecord(providers?.openai) ??
    asOptionalRecord(config.openai) ??
    asOptionalRecord(config)
  );
}

export function captureOpenAIRealtimeWsClose(
  params: {
    url: string;
    flowId: string;
    capability: "realtime-transcription" | "realtime-voice";
    code: unknown;
    reasonBuffer: unknown;
  },
  captureWsEvent: OpenAIRealtimeHost["captureWsEvent"],
): void {
  captureWsEvent({
    url: params.url,
    direction: "local",
    kind: "ws-close",
    flowId: params.flowId,
    closeCode: typeof params.code === "number" ? params.code : undefined,
    meta: {
      provider: "openai",
      capability: params.capability,
      reason:
        Buffer.isBuffer(params.reasonBuffer) && params.reasonBuffer.length > 0
          ? params.reasonBuffer.toString("utf8")
          : undefined,
    },
  });
}

type OpenAIRealtimeClientSecretResult = {
  value: string;
  expiresAt?: number;
};

type OpenAIRealtimeSecretRequest = {
  authToken: string;
  auditContext: string;
  url: string;
  body: unknown;
  errorMessage: string;
  authRejectedMessage?: string;
  missingValueMessage: string;
};

async function createOpenAIRealtimeSecret(
  params: OpenAIRealtimeSecretRequest,
  {
    createProviderHttpError,
    readProviderJsonResponse,
    resolveProviderRequestHeaders,
    fetchWithSsrFGuard,
  }: OpenAIRealtimeHost,
): Promise<OpenAIRealtimeClientSecretResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      method: "POST",
      headers: resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: params.url,
        capability: "audio",
        transport: "http",
        defaultHeaders: {
          Authorization: `Bearer ${params.authToken}`,
          "Content-Type": "application/json",
        },
      }) ?? {
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
    },
    policy: OPENAI_REALTIME_SSRF_POLICY,
    timeoutMs: OPENAI_REALTIME_CLIENT_SECRET_REQUEST_TIMEOUT_MS,
    auditContext: params.auditContext,
  });
  const payload = await (async () => {
    try {
      if (!response.ok) {
        const error = await createProviderHttpError(response, params.errorMessage);
        // Provider details can echo a masked credential while hiding which
        // OpenClaw auth source won. Keep the status metadata, but give callers
        // a bounded remediation for an explicitly configured key.
        if (response.status === 401 && params.authRejectedMessage) {
          error.message = params.authRejectedMessage;
        }
        throw error;
      }
      return await readProviderJsonResponse<unknown>(response, "openai.realtime-session");
    } finally {
      await release();
    }
  })();
  const nestedSecret =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).client_secret
      : undefined;
  const clientSecret =
    normalizeOptionalString(asOptionalRecord(payload)?.value) ??
    normalizeOptionalString(asOptionalRecord(nestedSecret)?.value);
  if (!clientSecret) {
    throw new Error(params.missingValueMessage);
  }
  const expiresAt =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).expires_at
      : undefined;
  const expiresAtMs = resolveExpiresAtMsFromEpochSeconds(expiresAt);
  return {
    value: clientSecret,
    ...(expiresAtMs === undefined ? {} : { expiresAt: expiresAtMs }),
  };
}

export async function createOpenAIRealtimeClientSecret(
  params: {
    authToken: string;
    auditContext: string;
    session: Record<string, unknown>;
    authRejectedMessage?: string;
  },
  runtime: OpenAIRealtimeHost,
): Promise<OpenAIRealtimeClientSecretResult> {
  const url = `${OPENAI_REALTIME_API_BASE_URL}/realtime/client_secrets`;
  return createOpenAIRealtimeSecret(
    {
      ...params,
      url,
      body: { session: params.session },
      errorMessage: "OpenAI Realtime client secret failed",
      missingValueMessage: "OpenAI Realtime client secret response did not include a value",
    },
    runtime,
  );
}

export async function createOpenAIRealtimeTranscriptionClientSecret(
  params: {
    authToken: string;
    auditContext: string;
    session: Record<string, unknown>;
    authRejectedMessage?: string;
  },
  runtime: OpenAIRealtimeHost,
): Promise<OpenAIRealtimeClientSecretResult> {
  const url = `${OPENAI_REALTIME_API_BASE_URL}/realtime/client_secrets`;
  return createOpenAIRealtimeSecret(
    {
      ...params,
      url,
      body: { session: params.session },
      errorMessage: "OpenAI Realtime transcription client secret failed",
      missingValueMessage:
        "OpenAI Realtime transcription client secret response did not include a value",
    },
    runtime,
  );
}
