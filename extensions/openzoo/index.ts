// Openzoo plugin entrypoint registers its OpenClaw integration.
import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { isOpenzooKeylessApiKey, shouldUseOpenzooSyntheticAuth } from "./provider-auth.js";
import { buildOpenzooProvider } from "./provider-catalog.js";
import { OPENZOO_PROVIDER_ID, OPENZOO_PROVIDER_LABEL } from "./provider-models.js";

const PROVIDER_ID = OPENZOO_PROVIDER_ID;
const OPENZOO_SETUP_HINT =
  "Pay per call over x402 through a local openzoo proxy (no account, no API key)";
const OPENZOO_GROUP_HINT = "Pay-per-call inference over x402, no account or API key";

/** Lazily loads setup helpers so provider wiring stays lightweight at startup. */
async function loadProviderSetup() {
  return await import("./setup.js");
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "openzoo Provider",
  description: "Bundled openzoo provider plugin",
  manifest,
  provider: {
    label: OPENZOO_PROVIDER_LABEL,
    docsPath: "/providers/openzoo",
    extraAuth: [
      {
        id: "custom",
        label: OPENZOO_PROVIDER_LABEL,
        hint: OPENZOO_SETUP_HINT,
        kind: "custom",
        appGuidedSetup: {
          detectAvailability: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.detectAppGuidedOpenzooAvailability(ctx);
          },
          detect: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.detectAppGuidedOpenzooModel(ctx);
          },
          prepare: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.prepareAppGuidedOpenzooSetup(ctx);
          },
        },
        run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.promptAndConfigureOpenzooInteractive({
            config: ctx.config,
            env: ctx.env,
            prompter: ctx.prompter,
            signal: ctx.signal,
          });
        },
        validateNonInteractive: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.validateOpenzooNonInteractive(ctx);
        },
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.configureOpenzooNonInteractive(ctx);
        },
      },
    ],
    catalog: {
      // Run after early providers so a local proxy does not dominate resolution.
      order: "late",
      run: async (ctx) => {
        const providerSetup = await loadProviderSetup();
        return await providerSetup.discoverOpenzooProvider(ctx);
      },
      staticRun: async () => ({ provider: buildOpenzooProvider() }),
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    // Upstream ids are OpenRouter-shaped, so Gemini-backed refs take the proxy-Gemini path.
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    resolveSyntheticAuth: ({ providerConfig }) => {
      if (!shouldUseOpenzooSyntheticAuth(providerConfig)) {
        return undefined;
      }
      return {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.openzoo (synthetic local key)",
        mode: "api-key" as const,
      };
    },
    shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) => isOpenzooKeylessApiKey(resolvedApiKey),
    wizard: {
      setup: {
        choiceId: PROVIDER_ID,
        choiceLabel: OPENZOO_PROVIDER_LABEL,
        choiceHint: OPENZOO_SETUP_HINT,
        groupId: PROVIDER_ID,
        groupLabel: OPENZOO_PROVIDER_LABEL,
        groupHint: OPENZOO_GROUP_HINT,
        methodId: "custom",
      },
      modelPicker: {
        label: `${OPENZOO_PROVIDER_LABEL} (local proxy)`,
        hint: "Detect priced models from the openzoo proxy /v1/models",
        methodId: "custom",
      },
    },
  },
});
