// OpenAI ChatGPT OAuth helpers manage ChatGPT OAuth login and token refresh.
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../../../plugin-sdk/facade-runtime.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { throwIfOAuthLoginAborted, withOAuthLoginAbort } from "./abort.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

// OAuth adapter for the bundled OpenAI/ChatGPT provider surface.
const OPENAI_CODEX_PROVIDER_ID = "openai";

type OpenAICodexOAuthFacade = {
  refreshOpenAICodexToken: (refreshToken: string) => Promise<OAuthCredentials>;
};

type OpenAICodexLoginCallbacks = Omit<OAuthLoginCallbacks, "onAuth"> & {
  onAuth: (info: Parameters<OAuthLoginCallbacks["onAuth"]>[0]) => Promise<void> | void;
};

function loadOpenAICodexOAuthFacade(): OpenAICodexOAuthFacade {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<OpenAICodexOAuthFacade>({
    dirName: "openai",
    artifactBasename: "api.js",
  });
}

function createLegacyRuntime(callbacks: OAuthLoginCallbacks): RuntimeEnv {
  return {
    log: (message) => callbacks.onProgress?.(String(message)),
    error: (message) => callbacks.onProgress?.(String(message)),
    exit: (code) => {
      throw new Error(`exit:${code}`);
    },
  };
}

// Bridges generic OAuth callbacks into the wizard prompter expected by the provider login flow.
function createLegacyPrompter(callbacks: OAuthLoginCallbacks): WizardPrompter {
  const progress = {
    update: (message: string) => callbacks.onProgress?.(message),
    stop: (message?: string) => {
      if (message) {
        callbacks.onProgress?.(message);
      }
    },
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message) => callbacks.onProgress?.(message),
    select: async (params) => params.options[0]?.value,
    multiselect: async (params) => params.initialValues ?? [],
    text: async (prompt) => {
      const input = callbacks.onPrompt({
        message: prompt.message,
        placeholder: prompt.placeholder,
      });
      return await withOAuthLoginAbort(input, callbacks.signal);
    },
    confirm: async () => false,
    progress: () => progress,
  } as WizardPrompter;
}

async function refreshViaProviderRuntime(refreshToken: string): Promise<OAuthCredentials> {
  const { refreshProviderOAuthCredentialWithPlugin } =
    await import("../../../plugins/provider-runtime.runtime.js");
  const refreshed = await refreshProviderOAuthCredentialWithPlugin({
    provider: OPENAI_CODEX_PROVIDER_ID,
    context: {
      type: "oauth",
      provider: OPENAI_CODEX_PROVIDER_ID,
      access: "",
      refresh: refreshToken,
      expires: 0,
    },
  });
  if (!refreshed) {
    // Fallback keeps refresh working when the plugin runtime is unavailable but the facade is active.
    return await loadOpenAICodexOAuthFacade().refreshOpenAICodexToken(refreshToken);
  }
  const credentials: Record<string, unknown> = { ...refreshed };
  delete credentials.type;
  delete credentials.provider;
  return credentials as OAuthCredentials;
}

/** Runs the ChatGPT/Codex OAuth login flow and returns normalized credentials. */
export async function loginOpenAICodex(
  callbacks: OpenAICodexLoginCallbacks,
): Promise<OAuthCredentials> {
  throwIfOAuthLoginAborted(callbacks.signal);
  const { loginOpenAICodexOAuth } =
    await import("../../../plugins/provider-openai-chatgpt-oauth.js");
  const manualCodeInput = callbacks.onManualCodeInput;
  const onManualCodeInput = manualCodeInput
    ? async () => await withOAuthLoginAbort(manualCodeInput(), callbacks.signal)
    : undefined;
  const credentials = await withOAuthLoginAbort(
    loginOpenAICodexOAuth({
      prompter: createLegacyPrompter(callbacks),
      runtime: createLegacyRuntime(callbacks),
      isRemote: false,
      signal: callbacks.signal,
      onManualCodeInput,
      openUrl: async (url) => {
        throwIfOAuthLoginAborted(callbacks.signal);
        await callbacks.onAuth({ url });
      },
    }),
    callbacks.signal,
  );
  if (!credentials) {
    throw new Error("OpenAI Codex OAuth login did not return credentials.");
  }
  return credentials;
}

/** Refreshes a ChatGPT/Codex OAuth token through the provider runtime or bundled facade. */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  return await refreshViaProviderRuntime(refreshToken);
}

/** OAuth provider descriptor for ChatGPT subscription-backed OpenAI access. */
export const openaiCodexOAuthProvider: OAuthProviderInterface = {
  id: OPENAI_CODEX_PROVIDER_ID,
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  usesCallbackServer: true,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return await loginOpenAICodex(callbacks);
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return await refreshOpenAICodexToken(credentials.refresh);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};
