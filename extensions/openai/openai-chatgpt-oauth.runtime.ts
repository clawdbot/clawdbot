// Openai plugin module implements openai chatgpt oauth behavior.
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredentials } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { loginOpenAICodex } from "./openai-chatgpt-oauth-flow.runtime.js";
import { runOpenAIOAuthTlsPreflight } from "./openai-chatgpt-oauth-preflight.runtime.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;
type OpenAICodexOAuthFailureCode =
  | "callback_timeout"
  | "callback_validation_failed"
  | "unsupported_region";

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

function formatOpenAIOAuthTlsPreflightFix(result: { code?: string; message: string }): string {
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
    const complete = () => {
      clearTimeout(timer);
      resolve("settled");
    };
    const timer = setTimeout(() => resolve("delay"), params.delayMs);
    params.waitForLoginToSettle.then(complete, complete);
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

    for (const delayMs of [localManualFallbackDelayMs, localManualFallbackGraceMs]) {
      const outcome = await settleAfterDelay({
        delayMs,
        waitForLoginToSettle: params.waitForLoginToSettle,
      });
      if (outcome === "settled") {
        return await waitForeverForPromptInput();
      }
    }
    return await switchToManualEntry(
      "Browser callback did not finish. Paste the redirect URL to continue...",
      `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`,
    );
  };

  return async () => {
    manualFallbackPromise ??= params.isRemote ? promptForManualCode() : runLocalManualFallback();
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
  assertCurrent?: () => void;
  onManualCodeInput?: () => Promise<string>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight({
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
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
  const manualPromptAbort = new AbortController();
  try {
    const { onAuth: baseOnAuth, onPrompt } = params.oauth.createVpsAwareHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser...",
      manualPromptMessage: manualInputPromptMessage,
      manualPromptSignal: manualPromptAbort.signal,
    });
    const onAuth = async (event: Parameters<typeof baseOnAuth>[0]) => {
      browserAuthStarted = true;
      await baseOnAuth(event);
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
      assertCurrent: params.assertCurrent,
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
    manualPromptAbort.abort();
    markLoginSettled();
  }
}
