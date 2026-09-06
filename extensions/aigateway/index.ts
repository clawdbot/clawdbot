// AIgateway plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "aigateway";

export default defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "AIgateway Provider",
	description: "Bundled AIgateway provider plugin",
	manifest,
	provider: {
		label: "AIgateway",
		docsPath: "/providers/aigateway",
		manifestAuth: {
			noteTitle: "AIgateway",
			noteMessage:
				"AIgateway aggregates 1,000+ models from 85+ labs behind one OpenAI-compatible endpoint. Get your API key at: https://aigateway.sh/dashboard/keys",
		},
		catalog: {
			allowExplicitBaseUrl: true,
			liveModelDiscovery: true,
		},
		augmentModelCatalog: ({ config }) =>
			readConfiguredProviderCatalogEntries({
				config,
				providerId: PROVIDER_ID,
			}),
		...buildProviderReplayFamilyHooks({
			family: "openai-compatible",
			dropReasoningFromHistory: false,
		}),
		...buildProviderToolCompatFamilyHooks("openai"),
	},
});
