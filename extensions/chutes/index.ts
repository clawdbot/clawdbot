import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveOAuthApiKeyMarker,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { loginChutes } from "openclaw/plugin-sdk/provider-auth-login";
import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import {
  CHUTES_DEFAULT_MODEL_REF,
  applyChutesApiKeyConfig,
  applyChutesProviderConfig,
} from "./onboard.js";
import { buildChutesProvider } from "./provider-catalog.js";

const PROVIDER_ID = "chutes";

async function runChutesOAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const isRemote = ctx.isRemote;
  const redirectUri =
    process.env.CHUTES_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:1456/oauth-callback";
  const scopes = process.env.CHUTES_OAUTH_SCOPES?.trim() || "openid profile chutes:invoke";
  const clientId =
    process.env.CHUTES_CLIENT_ID?.trim() ||
    (
      await ctx.prompter.text({
        message: "Enter Chutes OAuth client id",
        placeholder: "cid_xxx",
        validate: (value: string) => (value?.trim() ? undefined : "Required"),
      })
    ).trim();
  const clientSecret = normalizeOptionalString(process.env.CHUTES_CLIENT_SECRET);

  await ctx.prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
          "",
          `Redirect URI: ${redirectUri}`,
        ].join("\n")
      : [
          "Browser will open for Chutes authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "",
          `Redirect URI: ${redirectUri}`,
        ].join("\n"),
    "Chutes OAuth",
  );

  const progress = ctx.prompter.progress("Starting Chutes OAuth…");
  try {
    const { onAuth, onPrompt } = ctx.oauth.createVpsAwareHandlers({
      isRemote,
      prompter: ctx.prompter,
      runtime: ctx.runtime,
      spin: progress,
      openUrl: ctx.openUrl,
      localBrowserMessage: "Complete sign-in in browser…",
    });

    const creds = await loginChutes({
      app: {
        clientId,
        clientSecret,
        redirectUri,
        scopes: scopes.split(/\s+/).filter(Boolean),
      },
      manual: isRemote,
      onAuth,
      onPrompt,
      onProgress: (message) => progress.update(message),
    });

    progress.stop("Chutes OAuth complete");

    return buildOauthProviderAuthResult({
      providerId: PROVIDER_ID,
      defaultModel: CHUTES_DEFAULT_MODEL_REF,
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      email: readStringValue(creds.email),
      credentialExtra: {
        clientId,
        ...("accountId" in creds && typeof creds.accountId === "string"
          ? { accountId: creds.accountId }
          : {}),
      },
      configPatch: applyChutesProviderConfig({}),
      notes: [
        "Chutes OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
        `Redirect URI: ${redirectUri}`,
      ],
    });
  } catch (err) {
    progress.stop("Chutes OAuth failed");
    await ctx.prompter.note(
      [
        "Trouble with OAuth?",
        "Verify CHUTES_CLIENT_ID (and CHUTES_CLIENT_SECRET if required).",
        `Verify the OAuth app redirect URI includes: ${redirectUri}`,
        "Chutes docs: https://chutes.ai/docs/sign-in-with-chutes/overview",
      ].join("\n"),
      "OAuth help",
    );
    throw err;
  }
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Chutes Provider",
  description: "Bundled Chutes.ai provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Chutes",
      docsPath: "/providers/chutes",
      envVars: ["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"],
      auth: [
        {
          id: "oauth",
          label: "Chutes OAuth",
          hint: "Browser sign-in",
          kind: "oauth",
          wizard: {
            choiceId: "chutes",
            choiceLabel: "Chutes (OAuth)",
            choiceHint: "Browser sign-in",
            groupId: "chutes",
            groupLabel: "Chutes",
            groupHint: "OAuth + API key",
          },
          run: async (ctx) => await runChutesOAuth(ctx),
        },
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Chutes API key",
          hint: "Open-source models including Llama, DeepSeek, and more",
          optionKey: "chutesApiKey",
          flagName: "--chutes-api-key",
          envVar: "CHUTES_API_KEY",
          promptMessage: "Enter Chutes API key",
          noteTitle: "Chutes",
          noteMessage: [
            "Chutes provides access to leading open-source models including Llama, DeepSeek, and more.",
            "Get your API key at: https://chutes.ai/settings/api-keys",
          ].join("\n"),
          defaultModel: CHUTES_DEFAULT_MODEL_REF,
          expectedProviders: ["chutes"],
          applyConfig: (cfg) => applyChutesApiKeyConfig(cfg),
          wizard: {
            choiceId: "chutes-api-key",
            choiceLabel: "Chutes API key",
            groupId: "chutes",
            groupLabel: "Chutes",
            groupHint: "OAuth + API key",
          },
        }),
      ],
      catalog: {
        order: "profile",
        run: async (ctx) => {
          const { apiKey, discoveryApiKey } = ctx.resolveProviderAuth(PROVIDER_ID, {
            oauthMarker: resolveOAuthApiKeyMarker(PROVIDER_ID),
          });
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildChutesProvider(discoveryApiKey)),
              apiKey,
            },
          };
        },
      },
    });
  },
});
