import type { ProviderAuthResult, ProviderPlugin } from "./types.js";
import { loginGeminiCliVpsAware, shouldUseManualOAuthFlow } from "../commands/gemini-cli-oauth.js";

const GEMINI_CLI_DEFAULT_MODEL = "google-gemini-cli/gemini-3-pro-preview";

const geminiCliProvider: ProviderPlugin = {
  id: "google-gemini-cli",
  label: "Gemini CLI (Google)",
  aliases: ["gemini-cli"],
  auth: [
    {
      id: "oauth",
      label: "OAuth (Browser)",
      hint: "Sign in with your Google account",
      kind: "oauth",
      run: async (ctx): Promise<ProviderAuthResult> => {
        const isRemote = shouldUseManualOAuthFlow() || ctx.isRemote;
        await ctx.prompter.note(
          isRemote
            ? [
                "You are running in a remote/VPS environment.",
                "A URL will be shown for you to open in your LOCAL browser.",
                "After signing in, copy the redirect URL and paste it back here.",
              ].join("\n")
            : [
                "Browser will open for Google authentication.",
                "Sign in with your Google account for Gemini CLI access.",
                "The callback will be captured automatically on localhost:8085.",
              ].join("\n"),
          "Gemini CLI OAuth",
        );

        const spin = ctx.prompter.progress("Starting OAuth flow...");
        try {
          const oauthCreds = await loginGeminiCliVpsAware(
            async (url) => {
              if (isRemote) {
                spin.stop("OAuth URL ready");
                ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
              } else {
                spin.update("Complete sign-in in browser...");
                await ctx.openUrl(url);
                ctx.runtime.log(`Open: ${url}`);
              }
            },
            (msg) => spin.update(msg),
          );

          spin.stop("Gemini CLI OAuth complete");
          if (!oauthCreds) {
            throw new Error("OAuth flow did not return credentials");
          }

          const email = oauthCreds.email?.trim() || "default";
          const profileId = `google-gemini-cli:${email}`;

          return {
            profiles: [
              {
                profileId,
                credential: {
                  type: "oauth",
                  provider: "google-gemini-cli",
                  refresh: oauthCreds.refresh,
                  access: oauthCreds.access,
                  expires: oauthCreds.expires,
                  projectId: oauthCreds.projectId,
                  email: oauthCreds.email,
                },
              },
            ],
            defaultModel: GEMINI_CLI_DEFAULT_MODEL,
            notes: [
              `Authenticated as ${oauthCreds.email ?? "unknown"}`,
              `Default model: ${GEMINI_CLI_DEFAULT_MODEL}`,
            ],
          };
        } catch (err) {
          spin.stop("Gemini CLI OAuth failed");
          throw err;
        }
      },
    },
  ],
};

export function getBuiltinProviders(): ProviderPlugin[] {
  return [geminiCliProvider];
}
