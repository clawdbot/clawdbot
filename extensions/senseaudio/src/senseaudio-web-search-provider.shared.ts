// Senseaudio provider module implements model/runtime integration.
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const SENSEAUDIO_CREDENTIAL_PATH = "plugins.entries.senseaudio.config.webSearch.apiKey";
const SENSEAUDIO_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createSenseAudioWebSearchProviderBase() {
  return {
    id: "senseaudio",
    label: "SenseAudio Search",
    hint: "Requires SenseAudio API key · native web_search grounding",
    onboardingScopes: [...SENSEAUDIO_ONBOARDING_SCOPES],
    credentialLabel: "SenseAudio API key",
    envVars: ["SENSEAUDIO_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://senseaudio.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/senseaudio-search",
    // Model-synthesized answer class, slotted after Kimi (40) like the
    // dual-use-key siblings (minimax 15, kimi 40). SENSEAUDIO_API_KEY also
    // authenticates transcription, so presence alone selects search too.
    autoDetectOrder: 45,
    credentialPath: SENSEAUDIO_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: SENSEAUDIO_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "senseaudio" },
      configuredCredential: { pluginId: "senseaudio" },
      selectionPluginId: "senseaudio",
    }),
  };
}
