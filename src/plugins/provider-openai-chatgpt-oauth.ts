import type { OAuthCredentials } from "../llm/oauth.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import type { ProviderAuthContext } from "./types.js";

const OPENAI_CODEX_PROVIDER_ID = "openai";
const OPENAI_CODEX_OAUTH_METHOD_ID = "oauth";

type OpenAICodexOAuthBridgeContext = ProviderAuthContext & {
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
};

type OpenAICodexOAuthLoginParams = {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
  localBrowserMessage?: string;
};

type OpenAICodexOAuthFacade = {
  loginOpenAICodexOAuth: (
    params: OpenAICodexOAuthLoginParams & Pick<ProviderAuthContext, "oauth">,
  ) => Promise<OAuthCredentials | null>;
};

function loadOpenAICodexOAuthFacade(): OpenAICodexOAuthFacade {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<OpenAICodexOAuthFacade>({
    dirName: "openai",
    artifactBasename: "api.js",
  });
}

function isOAuthCredential(value: unknown): value is OAuthCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "oauth" &&
    record.provider === OPENAI_CODEX_PROVIDER_ID &&
    typeof record.access === "string" &&
    typeof record.refresh === "string" &&
    typeof record.expires === "number"
  );
}

/** @deprecated OpenAI Codex OAuth is owned by the OpenAI plugin auth hook. */
export async function loginOpenAICodexOAuth(
  params: OpenAICodexOAuthLoginParams,
): Promise<OAuthCredentials | null> {
  const oauthHandlers = {
    createVpsAwareHandlers: createVpsAwareOAuthHandlers,
  };
  const provider = resolveProviderRuntimePlugin({
    provider: OPENAI_CODEX_PROVIDER_ID,
    config: {},
    bundledProviderVitestCompat: true,
  });
  const oauth = provider?.auth?.find((method) => method.id === OPENAI_CODEX_OAUTH_METHOD_ID);
  if (!oauth) {
    return await loadOpenAICodexOAuthFacade().loginOpenAICodexOAuth({
      ...params,
      oauth: oauthHandlers,
    });
  }

  const context: OpenAICodexOAuthBridgeContext = {
    config: {},
    prompter: params.prompter,
    runtime: params.runtime,
    isRemote: params.isRemote,
    openUrl: params.openUrl,
    signal: params.signal,
    onManualCodeInput: params.onManualCodeInput,
    oauth: oauthHandlers,
  };
  const result = await oauth.run(context);
  const credential = result.profiles[0]?.credential;
  return isOAuthCredential(credential) ? credential : null;
}
