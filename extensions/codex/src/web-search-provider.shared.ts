import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createCodexWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
  return {
    id: "codex",
    label: "Codex Hosted Search",
    hint: "Grounded answers through your Codex app-server account",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(uses Codex sign-in)",
    signupUrl: "https://chatgpt.com/codex",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 900,
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "none" },
      selectionPluginId: "codex",
    }),
    runSetup: async (ctx) => {
      await ctx.prompter.note(
        [
          "Codex Hosted Search uses the bundled Codex app-server and your Codex/OpenAI sign-in.",
          "If needed, sign in with: openclaw models auth login --provider openai",
          "Verify the app-server account with /codex status.",
        ].join("\n"),
        "Codex Hosted Search",
      );
      return ctx.config;
    },
  };
}
