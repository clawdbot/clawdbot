// Openai plugin module implements openai chatgpt oauth behavior.
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { loginOpenAICodex } from "./openai-chatgpt-oauth-flow.runtime.js";
import type { OAuthCredentials } from "./openai-chatgpt-oauth-types.runtime.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;
const openAIAuthProbeUrl =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";

const tlsCertErrorCodes = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const tlsCertErrorPatterns = [
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
];

type OpenAICodexOAuthFailureCode =
  | "callback_timeout"
  | "callback_validation_failed"
  | "unsupported_region";

type PreflightFailureKind = "tls-cert" | "network";
type OpenAIOAuthTlsPreflightResult =
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
  const root = getErrorRecord(error);
  const rootCause = getErrorRecord(root?.cause);
  const code = typeof rootCause?.code === "string" ? rootCause.code : undefined;
  const message =
    typeof rootCause?.message === "string"
      ? rootCause.message
      : typeof root?.message === "string"
        ? root.message
        : String(error);
  const isTlsCertError =
    (code ? tlsCertErrorCodes.has(code) : false) ||
    tlsCertErrorPatterns.some((pattern) => pattern.test(message));
  return {
    code,
    message,
    kind: isTlsCertError ? "tls-cert" : "network",
  };
}

function resolveHomebrewPrefixFromExecPath(execPath: string): string | null {
  const marker = `${path.sep}Cellar${path.sep}`;
  const idx = execPath.indexOf(marker);
  if (idx > 0) {
    return execPath.slice(0, idx);
  }
  return process.env.HOMEBREW_PREFIX?.trim() || null;
}

function resolveCertBundlePath(): string | null {
  const prefix = resolveHomebrewPrefixFromExecPath(process.execPath);
  return prefix ? path.join(prefix, "etc", "openssl@3", "cert.pem") : null;
}

async function runOpenAIOAuthTlsPreflight(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OpenAIOAuthTlsPreflightResult> {
  const timeoutMs = resolveTimerTimeoutMs(options?.timeoutMs, 5000);
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    await fetchImpl(openAIAuthProbeUrl, {
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
  }
}

export const testing = { runOpenAIOAuthTlsPreflight };
export { testing as __testing };

function formatOpenAIOAuthTlsPreflightFix(
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

function settleAfterDelay(params: {
  delayMs: number;
  waitForLoginToSettle: Promise<void>;
}): Promise<"delay" | "settled"> {
  return new Promise((resolve) => {
    let done = false;
    const complete = (outcome: "delay" | "settled") => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => complete("delay"), params.delayMs);
    params.waitForLoginToSettle.then(
      () => complete("settled"),
      () => complete("settled"),
    );
  });
}

function waitForeverForPromptInput(): Promise<string> {
  return new Promise<string>(() => {});
}

function createOpenAICodexOAuthError(
  code: OpenAICodexOAuthFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: OpenAICodexOAuthFailureCode } {
  return Object.assign(new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause }), {
    code,
  });
}

function rewriteOpenAICodexOAuthError(error: unknown): Error {
  const message = formatErrorMessage(error);
  if (/unsupported_country_region_territory/i.test(message)) {
    return createOpenAICodexOAuthError(
      "unsupported_region",
      [
        "OpenAI rejected the token exchange for this country, region, or network route.",
        "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set for the OpenClaw process and then retry `openclaw models auth login --provider openai`.",
      ].join(" "),
      error,
    );
  }
  if (/state mismatch|missing authorization code/i.test(message)) {
    return createOpenAICodexOAuthError("callback_validation_failed", message, error);
  }
  return error instanceof Error ? error : new Error(message);
}

function createManualCodeInputHandler(params: {
  isRemote: boolean;
  onPrompt: (prompt: { message: string }) => Promise<string>;
  runtime: ProviderAuthContext["runtime"];
  updateProgress: (message: string) => void;
  stopProgress: (message?: string) => void;
  waitForLoginToSettle: Promise<void>;
  hasBrowserAuthStarted: () => boolean;
}): (() => Promise<string>) | undefined {
  let manualFallbackPromise: Promise<string> | undefined;
  const promptForManualCode = () => params.onPrompt({ message: manualInputPromptMessage });
  if (params.isRemote) {
    return async () => {
      manualFallbackPromise ??= promptForManualCode();
      return await manualFallbackPromise;
    };
  }

  const switchToManualEntry = async (progressMessage: string, logMessage?: string) => {
    params.updateProgress(progressMessage);
    if (logMessage) {
      params.runtime.log(logMessage);
    }
    params.stopProgress("Manual OAuth entry required");
    return await promptForManualCode();
  };

  const runLocalManualFallback = async () => {
    if (!params.hasBrowserAuthStarted()) {
      return await switchToManualEntry(
        "Local OAuth callback was unavailable. Paste the redirect URL to continue...",
        "OpenAI Codex OAuth local callback did not start; switching to manual entry immediately.",
      );
    }

    const firstWait = await settleAfterDelay({
      delayMs: localManualFallbackDelayMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (firstWait === "settled") {
      return await waitForeverForPromptInput();
    }
    const graceWait = await settleAfterDelay({
      delayMs: localManualFallbackGraceMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (graceWait === "settled") {
      return await waitForeverForPromptInput();
    }
    return await switchToManualEntry(
      "Browser callback did not finish. Paste the redirect URL to continue...",
      `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`,
    );
  };

  return async () => {
    manualFallbackPromise ??= runLocalManualFallback();
    return await manualFallbackPromise;
  };
}

export async function loginOpenAICodexOAuth(params: {
  prompter: ProviderAuthContext["prompter"];
  runtime: ProviderAuthContext["runtime"];
  oauth: ProviderAuthContext["oauth"];
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    await prompter.note(hint, "OAuth prerequisites");
    runtime.error(hint);
    throw new Error(`OpenAI Codex OAuth prerequisites failed: ${preflight.message}`);
  }

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "Open it, sign in, then paste the redirect URL here.",
          "If this OpenClaw process can receive the browser callback, sign-in may finish automatically before you paste.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow...");
  let progressActive = true;
  const updateProgress = (message: string) => {
    if (progressActive) {
      spin.update(message);
    }
  };
  const stopProgress = (message?: string) => {
    if (progressActive) {
      progressActive = false;
      spin.stop(message);
    }
  };
  let browserAuthStarted = false;
  let markLoginSettled!: () => void;
  const waitForLoginToSettle = new Promise<void>((resolve) => {
    markLoginSettled = resolve;
  });
  try {
    const { onAuth: baseOnAuth, onPrompt } = params.oauth.createVpsAwareHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser...",
      manualPromptMessage: manualInputPromptMessage,
    });
    const onAuth = (event: Parameters<typeof baseOnAuth>[0]) => {
      browserAuthStarted = true;
      void baseOnAuth(event);
    };

    const creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      originator: openAICodexOAuthOriginator,
      onManualCodeInput:
        params.onManualCodeInput ??
        createManualCodeInputHandler({
          isRemote,
          onPrompt,
          runtime,
          updateProgress,
          stopProgress,
          waitForLoginToSettle,
          hasBrowserAuthStarted: () => browserAuthStarted,
        }),
      onProgress: (msg: string) => updateProgress(msg),
      signal: params.signal,
    });
    stopProgress("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    stopProgress("OpenAI OAuth failed");
    const rewrittenError = rewriteOpenAICodexOAuthError(err);
    runtime.error(String(rewrittenError));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw rewrittenError;
  } finally {
    markLoginSettled();
  }
}
