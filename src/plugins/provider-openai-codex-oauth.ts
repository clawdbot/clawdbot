import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const OPENAI_CODEX_OAUTH_REQUIRED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "model.request",
  "api.responses.write",
] as const;

function normalizeOpenAICodexAuthorizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return rawUrl;
  }
  try {
    const url = new URL(trimmed);
    if (
      !/(?:^|\.)openai\.com$/i.test(url.hostname) ||
      !/\/oauth\/authorize\/?$/i.test(url.pathname)
    ) {
      return rawUrl;
    }

    const existing = new Set(
      (url.searchParams.get("scope") ?? "")
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    );
    for (const scope of OPENAI_CODEX_OAUTH_REQUIRED_SCOPES) {
      existing.add(scope);
    }
    url.searchParams.set("scope", Array.from(existing).join(" "));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export const __testing = {
  normalizeOpenAICodexAuthorizeUrl,
};

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  // Ensure env-based proxy dispatcher is active before any outbound fetch calls,
  // including the TLS preflight check.
  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    runtime.error(hint);
    await prompter.note(hint, "OAuth prerequisites");
    throw new Error(preflight.message);
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

    const creds = await loginOpenAICodex({
      onAuth: async (event) =>
        await baseOnAuth({
          ...event,
          url: normalizeOpenAICodexAuthorizeUrl(event.url),
        }),
      onPrompt,
      originator: openAICodexOAuthOriginator,
      onManualCodeInput: isRemote
        ? async () =>
            await onPrompt({
              message: manualInputPromptMessage,
            })
        : undefined,
      onProgress: (msg: string) => spin.update(msg),
    });
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
