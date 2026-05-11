import { loginOpenAICodex, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { formatErrorMessage } from "../infra/errors.js";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { OAuthPrompt } from "./provider-oauth-flow.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;

type OpenAICodexOAuthFailureCode =
  | "callback_timeout"
  | "callback_validation_failed"
  | "unsupported_region";

function waitForDelayOrLoginSettle(params: {
  delayMs: number;
  waitForLoginToSettle: Promise<void>;
}): Promise<"delay" | "settled"> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (outcome: "delay" | "settled") => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutHandle);
      resolve(outcome);
    };
    const timeoutHandle = setTimeout(() => finish("delay"), params.delayMs);
    params.waitForLoginToSettle.then(
      () => finish("settled"),
      () => finish("settled"),
    );
  });
}

function createNeverSettlingPromptResult(): Promise<string> {
  return new Promise<string>(() => undefined);
}

function createOpenAICodexOAuthError(
  code: OpenAICodexOAuthFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: OpenAICodexOAuthFailureCode } {
  const error = new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause });
  return Object.assign(error, { code });
}

function rewriteOpenAICodexOAuthError(error: unknown): Error {
  const message = formatErrorMessage(error);
  if (/unsupported_country_region_territory/i.test(message)) {
    return createOpenAICodexOAuthError(
      "unsupported_region",
      [
        "OpenAI rejected the token exchange for this country, region, or network route.",
        "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set for the OpenClaw process and then retry `openclaw models auth login --provider openai-codex`.",
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
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  runtime: RuntimeEnv;
  updateProgress: (message: string) => void;
  stopProgress: (message?: string) => void;
  waitForLoginToSettle: Promise<void>;
  hasBrowserAuthStarted: () => boolean;
}): (() => Promise<string>) | undefined {
  let manualFallbackPromise: Promise<string> | undefined;
  if (params.isRemote) {
    return async () => {
      manualFallbackPromise ??= params.onPrompt({
        message: manualInputPromptMessage,
      });
      return await manualFallbackPromise;
    };
  }

  const runLocalManualFallback = async () => {
    if (!params.hasBrowserAuthStarted()) {
      params.updateProgress(
        "Local OAuth callback was unavailable. Paste the redirect URL to continue…",
      );
      params.runtime.log(
        "OpenAI Codex OAuth local callback did not start; switching to manual entry immediately.",
      );
      params.stopProgress("Manual OAuth entry required");
      return await params.onPrompt({
        message: manualInputPromptMessage,
      });
    }

    const outcome = await waitForDelayOrLoginSettle({
      delayMs: localManualFallbackDelayMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (outcome === "settled") {
      // markLoginSettled() runs in loginOpenAICodexOAuth's finally block, so
      // reaching this branch means the outer login call has already completed.
      // Return a never-settling promise to suppress an unnecessary manual
      // prompt without feeding placeholder input back into the upstream flow.
      return await createNeverSettlingPromptResult();
    }

    const settledDuringGraceWindow = await waitForDelayOrLoginSettle({
      delayMs: localManualFallbackGraceMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (settledDuringGraceWindow === "settled") {
      return await createNeverSettlingPromptResult();
    }

    params.updateProgress("Browser callback did not finish. Paste the redirect URL to continue…");
    params.runtime.log(
      `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`,
    );
    params.stopProgress("Manual OAuth entry required");
    return await params.onPrompt({
      message: manualInputPromptMessage,
    });
  };

  return async () => {
    manualFallbackPromise ??= runLocalManualFallback();
    return await manualFallbackPromise;
  };
}

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
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
          "After signing in, paste the redirect URL back here.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
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
    const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
      manualPromptMessage: manualInputPromptMessage,
    });
    const onAuth: typeof baseOnAuth = async (event) => {
      browserAuthStarted = true;
      await baseOnAuth(event);
    };

    const creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      originator: openAICodexOAuthOriginator,
      onManualCodeInput: createManualCodeInputHandler({
        isRemote,
        onPrompt,
        runtime,
        updateProgress,
        stopProgress,
        waitForLoginToSettle,
        hasBrowserAuthStarted: () => browserAuthStarted,
      }),
      onProgress: (msg: string) => updateProgress(msg),
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
