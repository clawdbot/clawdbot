import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchGeminiUsage } from "openclaw/plugin-sdk/provider-usage";
import { formatGoogleOauthApiKey, parseGoogleUsageToken } from "./oauth-token-shared.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
] as const;

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

export function buildGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [...ENV_VARS],
    auth: [
      {
        id: "oauth",
        label: "Google OAuth",
        hint: "PKCE + localhost callback",
        kind: "oauth",
        run: async (ctx: ProviderAuthContext) => {
          await ctx.prompter.note(
            [
              "This is an unofficial integration and is not endorsed by Google.",
              "Some users have reported account restrictions or suspensions after using third-party Gemini CLI and Antigravity OAuth clients.",
              "Proceed only if you understand and accept this risk.",
            ].join("\n"),
            "Google Gemini CLI caution",
          );

          const proceed = await ctx.prompter.confirm({
            message: "Continue with Google Gemini CLI OAuth?",
            initialValue: false,
          });
          if (!proceed) {
            await ctx.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
            return { profiles: [] };
          }

          const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
          try {
            const { loginGeminiCliOAuth } = await import("./oauth.runtime.js");
            const result = await loginGeminiCliOAuth({
              isRemote: ctx.isRemote,
              openUrl: ctx.openUrl,
              log: (msg) => ctx.runtime.log(msg),
              note: ctx.prompter.note,
              prompt: async (message) => ctx.prompter.text({ message }),
              progress: spin,
            });

            spin.stop("Gemini CLI OAuth complete");
            return buildOauthProviderAuthResult({
              providerId: PROVIDER_ID,
              defaultModel: DEFAULT_MODEL,
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
              email: result.email,
              configPatch: {
                agents: {
                  defaults: {
                    agentRuntime: { id: PROVIDER_ID },
                    models: {
                      [DEFAULT_MODEL]: {},
                    },
                  },
                },
              },
              ...(result.projectId ? { credentialExtra: { projectId: result.projectId } } : {}),
              ...(result.projectId
                ? {
                    notes: [
                      "If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.",
                    ],
                  }
                : {}),
            });
          } catch (err) {
            spin.stop("Gemini CLI OAuth failed");
            await ctx.prompter.note(
              "Trouble with OAuth? Ensure your Google account has Gemini CLI access.",
              "OAuth help",
            );
            throw err;
          }
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        choiceHint: "Google OAuth with project-aware token payload",
        methodId: "oauth",
      },
    },
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: PROVIDER_ID,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
    refreshOAuth: async (cred) => {
      const { refreshGeminiCliOAuthToken } = await import("./oauth.runtime.js");
      return await refreshGeminiCliOAuthToken(cred);
    },
    resolveUsageAuth: async (ctx) => {
      const auth = await ctx.resolveOAuthToken();
      if (!auth) {
        return null;
      }
      return {
        ...auth,
        token: parseGoogleUsageToken(auth.token),
      };
    },
    fetchUsageSnapshot: async (ctx) => await fetchGeminiCliUsage(ctx),
  };
}

export function registerGoogleGeminiCliProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleGeminiCliProvider());
}
