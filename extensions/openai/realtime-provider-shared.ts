import {
  createProviderHttpError,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import { captureWsEvent } from "openclaw/plugin-sdk/proxy-capture";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const trimToUndefined = normalizeOptionalString;

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const message = asObjectRecord(error)?.message;
  if (typeof message === "string" && message) {
    return message;
  }
  return "Unknown error";
}

export function resolveOpenAIProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObjectRecord(config.providers);
  return (
    asObjectRecord(providers?.openai) ?? asObjectRecord(config.openai) ?? asObjectRecord(config)
  );
}

export function captureOpenAIRealtimeWsClose(params: {
  url: string;
  flowId: string;
  capability: "realtime-transcription" | "realtime-voice";
  code: unknown;
  reasonBuffer: unknown;
}): void {
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

export type OpenAIRealtimeClientSecretResult = {
  value: string;
  expiresAt?: number;
};

type OpenAIRealtimeSecretRequest = {
  authToken: string;
  auditContext: string;
  url: string;
  body: unknown;
  errorMessage: string;
  missingValueMessage: string;
};

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

async function createOpenAIRealtimeSecret(
  params: OpenAIRealtimeSecretRequest,
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
    auditContext: params.auditContext,
  });
  const payload = await (async () => {
    try {
      if (!response.ok) {
        throw await createProviderHttpError(response, params.errorMessage);
      }
      return (await response.json()) as unknown;
    } finally {
      await release();
    }
  })();
  const nestedSecret =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).client_secret
      : undefined;
  const clientSecret = readStringField(payload, "value") ?? readStringField(nestedSecret, "value");
  if (!clientSecret) {
    throw new Error(params.missingValueMessage);
  }
  const expiresAt =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).expires_at
      : undefined;
  return {
    value: clientSecret,
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  };
}

export async function createOpenAIRealtimeClientSecret(params: {
  authToken: string;
  auditContext: string;
  session: Record<string, unknown>;
}): Promise<OpenAIRealtimeClientSecretResult> {
  const url = "https://api.openai.com/v1/realtime/client_secrets";
  return createOpenAIRealtimeSecret({
    ...params,
    url,
    body: { session: params.session },
    errorMessage: "OpenAI Realtime client secret failed",
    missingValueMessage: "OpenAI Realtime client secret response did not include a value",
  });
}

export async function createOpenAIRealtimeTranscriptionClientSecret(params: {
  authToken: string;
  auditContext: string;
  session: Record<string, unknown>;
}): Promise<OpenAIRealtimeClientSecretResult> {
  const url = "https://api.openai.com/v1/realtime/transcription_sessions";
  return createOpenAIRealtimeSecret({
    ...params,
    url,
    body: params.session,
    errorMessage: "OpenAI Realtime transcription client secret failed",
    missingValueMessage:
      "OpenAI Realtime transcription client secret response did not include a value",
  });
}
