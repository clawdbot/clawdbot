/** TLS helpers for ChatGPT OAuth provider discovery in plugin runtime code. */
import path from "node:path";
import { inspectTlsCertificateError } from "@openclaw/ai/internal/shared";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const OPENAI_AUTH_PROBE_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";
const OPENAI_PROVIDER_ID = "openai";

type PreflightFailureKind = "tls-cert" | "network";

type OpenAIOAuthTlsPreflightResult =
  | { ok: true }
  | {
      ok: false;
      kind: PreflightFailureKind;
      code?: string;
      message: string;
    };

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
  const root = asNullableObjectRecord(error);
  const rootCause = asNullableObjectRecord(root?.cause);
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

function resolveHomebrewPrefixFromExecPath(execPath: string): string | null {
  const marker = `${path.sep}Cellar${path.sep}`;
  const idx = execPath.indexOf(marker);
  if (idx > 0) {
    return execPath.slice(0, idx);
  }
  const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
  return envPrefix ? envPrefix : null;
}

function resolveCertBundlePath(): string | null {
  const prefix = resolveHomebrewPrefixFromExecPath(process.execPath);
  if (!prefix) {
    return null;
  }
  return path.join(prefix, "etc", "openssl@3", "cert.pem");
}

function hasOpenAICodexOAuthProfile(cfg: OpenClawConfig): boolean {
  const profiles = cfg.auth?.profiles;
  if (!profiles) {
    return false;
  }
  return Object.values(profiles).some(
    (profile) => profile.provider === OPENAI_PROVIDER_ID && profile.mode === "oauth",
  );
}

export function shouldRunOpenAIOAuthTlsPrerequisites(params: {
  cfg: OpenClawConfig;
  deep?: boolean;
}): boolean {
  if (params.deep === true) {
    return true;
  }
  return hasOpenAICodexOAuthProfile(params.cfg);
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

export function formatOpenAIOAuthTlsPreflightFix(
  result: Exclude<OpenAIOAuthTlsPreflightResult, { ok: true }>,
): string {
  if (result.kind !== "tls-cert") {
    return [
      "OpenAI OAuth prerequisites check failed due to a network error before the browser flow.",
      `Cause: ${result.message}`,
      "Verify DNS/firewall/proxy access to auth.openai.com and retry.",
    ].join("\n");
  }
  const certBundlePath = resolveCertBundlePath();
  const lines = [
    "OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
    `Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
    "",
    "Fix (Homebrew Node/OpenSSL):",
    `- ${formatCliCommand("brew postinstall ca-certificates")}`,
    `- ${formatCliCommand("brew postinstall openssl@3")}`,
  ];
  if (certBundlePath) {
    lines.push(`- Verify cert bundle exists: ${certBundlePath}`);
  }
  lines.push("- Retry the OAuth login flow.");
  return lines.join("\n");
}

export async function noteOpenAIOAuthTlsPrerequisites(params: {
  cfg: OpenClawConfig;
  deep?: boolean;
}): Promise<void> {
  if (!shouldRunOpenAIOAuthTlsPrerequisites(params)) {
    return;
  }
  const result = await runOpenAIOAuthTlsPreflight({ timeoutMs: 4000 });
  if (result.ok || result.kind !== "tls-cert") {
    return;
  }
  note(formatOpenAIOAuthTlsPreflightFix(result), "OAuth TLS prerequisites");
}
