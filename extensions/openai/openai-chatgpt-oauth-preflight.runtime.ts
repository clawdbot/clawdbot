import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { inspectTlsCertificateError } from "openclaw/plugin-sdk/provider-http";

const OPENAI_AUTH_PROBE_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";
type PreflightFailureKind = "tls-cert" | "network";
export type OpenAIOAuthTlsPreflightResult =
  | { ok: true }
  | {
      ok: false;
      kind: PreflightFailureKind;
      code?: string;
      message: string;
    };

function getErrorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : null;
}

function extractFailure(error: unknown): {
  code?: string;
  message: string;
  kind: PreflightFailureKind;
} {
  const tlsFailure = inspectTlsCertificateError(error);
  if (tlsFailure) {
    return {
      code: tlsFailure.code,
      message: tlsFailure.message,
      kind: "tls-cert",
    };
  }
  const root = getErrorRecord(error);
  const rootCause = getErrorRecord(root?.cause);
  const code = typeof rootCause?.code === "string" ? rootCause.code : undefined;
  const message =
    typeof rootCause?.message === "string"
      ? rootCause.message
      : typeof root?.message === "string"
        ? root.message
        : String(error);
  return {
    code,
    message,
    kind: "network",
  };
}

export async function runOpenAIOAuthTlsPreflight(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OpenAIOAuthTlsPreflightResult> {
  const timeoutMs = resolveTimerTimeoutMs(options?.timeoutMs, 5000);
  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response | undefined;
  try {
    response = await fetchImpl(OPENAI_AUTH_PROBE_URL, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true };
  } catch (error) {
    const failure = extractFailure(error);
    return {
      ok: false,
      kind: failure.kind,
      code: failure.code,
      message: failure.message,
    };
  } finally {
    if (response?.bodyUsed !== true) {
      await response?.body?.cancel().catch(() => undefined);
    }
  }
}
