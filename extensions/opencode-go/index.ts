import { createOpencodeCatalogApiKeyAuthMethod } from "openclaw/plugin-sdk/opencode";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import { applyOpencodeGoConfig, OPENCODE_GO_DEFAULT_MODEL_REF } from "./api.js";

const PROVIDER_ID = "opencode-go";
export default definePluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  description: "Bundled OpenCode Go provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Go",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [
        createOpencodeCatalogApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          label: "OpenCode Go catalog",
          optionKey: "opencodeGoApiKey",
          flagName: "--opencode-go-api-key",
          defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
          applyConfig: (cfg) => applyOpencodeGoConfig(cfg),
          noteMessage: [
            "OpenCode uses one API key across the Zen and Go catalogs.",
            "Go focuses on Kimi, GLM, and MiniMax coding models.",
            "Get your API key at: https://opencode.ai/auth",
          ].join("\n"),
          choiceId: "opencode-go",
          choiceLabel: "OpenCode Go catalog",
        }),
      ],
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      isModernModelRef: () => true,
    });
  },
});
