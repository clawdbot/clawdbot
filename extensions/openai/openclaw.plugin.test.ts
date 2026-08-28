// Openai tests cover openclaw.plugin plugin behavior.
import { describe, expect, it } from "vitest";
import {
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_VARIANT_MODEL_IDS,
} from "./model-route-contract.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createOpenAIProvider } from "./provider-contract-api.js";
import { buildOpenAISetupProvider } from "./setup-api.js";

const WIZARD_METADATA_KEYS = [
  "choiceId",
  "choiceLabel",
  "choiceHint",
  "assistantPriority",
  "assistantVisibility",
  "onboardingFeatured",
  "groupId",
  "groupLabel",
  "groupHint",
] as const;

function comparableWizardFields(choice: {
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: string;
  onboardingFeatured?: boolean;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
}) {
  return Object.fromEntries(
    WIZARD_METADATA_KEYS.flatMap((key) => (choice[key] === undefined ? [] : [[key, choice[key]]])),
  );
}

function comparableProviderMetadata(provider: ReturnType<typeof createOpenAIProvider>) {
  return {
    id: provider.id,
    label: provider.label,
    hookAliases: provider.hookAliases,
    docsPath: provider.docsPath,
    envVars: provider.envVars,
    auth: provider.auth.map((method) => ({
      id: method.id,
      kind: method.kind,
      label: method.label,
      hint: method.hint,
      wizard: comparableWizardFields(method.wizard ?? {}),
    })),
  };
}

describe("OpenAI plugin manifest", () => {
  it("exposes only current OpenAI login choices", () => {
    const openAiLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai",
    );

    expect(openAiLogin && "deprecatedChoiceIds" in openAiLogin).toBe(false);
  });

  it("routes setup through the OpenAI setup runtime", () => {
    expect("legacyPluginIds" in manifest).toBe(false);
    expect(manifest.setup?.providers?.map((provider) => provider.id)).toEqual(["openai"]);
    expect("providerAuthAliases" in manifest).toBe(false);
  });

  it("classifies ChatGPT backend traffic with the supported OpenAI endpoint class", () => {
    const chatGptEndpoint = manifest.providerEndpoints?.find((endpoint) =>
      endpoint.hosts?.includes("chatgpt.com"),
    );
    expect(chatGptEndpoint?.endpointClass).toBe("openai");
  });

  it("classifies regional API hosts as public OpenAI endpoints", () => {
    const publicEndpoint = manifest.providerEndpoints?.find((endpoint) =>
      endpoint.hosts?.includes("api.openai.com"),
    );
    expect(publicEndpoint?.endpointClass).toBe("openai-public");
    expect(publicEndpoint?.hostSuffixes).toContain(".api.openai.com");
  });

  it("keeps OpenAI media-understanding manifest metadata aligned with runtime audio support", () => {
    const metadata = manifest.mediaUnderstandingProviderMetadata?.openai;
    expect(metadata?.capabilities).toEqual(["image", "audio"]);
    expect(metadata?.defaultModels?.image).toBe("gpt-5.6-sol");
    expect(metadata?.defaultModels?.audio).toBe("gpt-4o-transcribe");
    expect(metadata?.autoPriority?.image).toBe(20);
    expect(metadata?.autoPriority?.audio).toBe(20);
  });

  it("keeps million-token OpenAI models on the ordinary runtime budget by default", () => {
    const models = manifest.modelCatalog?.providers?.openai?.models ?? [];
    for (const id of [
      ...OPENAI_GPT_56_VARIANT_MODEL_IDS,
      OPENAI_GPT_55_MODEL_ID,
      OPENAI_GPT_55_PRO_MODEL_ID,
    ]) {
      expect(
        models.find((model) => model.id === id),
        id,
      ).toMatchObject({
        contextTokens: 272_000,
        maxTokens: 128_000,
      });
    }
  });

  it("replaces deprecated GPT-5.5 models with canonical GPT-5.6 Sol", () => {
    const models = manifest.modelCatalog?.providers?.openai?.models ?? [];
    for (const id of [OPENAI_GPT_55_MODEL_ID, OPENAI_GPT_55_PRO_MODEL_ID]) {
      expect(models.find((model) => model.id === id)?.replacedBy, id).toBe("gpt-5.6-sol");
    }
  });

  it("labels OpenAI API key and Codex auth choices without stale mixed OAuth wording", () => {
    const choices = manifest.providerAuthChoices ?? [];
    const openAiLogin = choices.find((choice) => choice.choiceId === "openai");
    const openAiDeviceCode = choices.find((choice) => choice.choiceId === "openai-device-code");
    const apiKey = choices.find(
      (choice) => choice.provider === "openai" && choice.method === "api-key",
    );

    expect(openAiLogin?.choiceLabel).toBe("ChatGPT Login");
    expect(openAiLogin?.choiceHint).toBe("Sign in with your ChatGPT or Codex subscription");
    expect(openAiLogin && "assistantVisibility" in openAiLogin).toBe(false);
    expect(openAiLogin?.groupId).toBe("openai");
    expect(openAiLogin?.groupLabel).toBe("OpenAI");
    expect(openAiLogin?.groupHint).toBe("ChatGPT/Codex sign-in or API key");
    expect(openAiDeviceCode?.choiceLabel).toBe("ChatGPT Device Pairing");
    expect(openAiDeviceCode?.choiceHint).toBe(
      "Pair your ChatGPT account in browser with a device code",
    );
    expect(openAiDeviceCode && "assistantVisibility" in openAiDeviceCode).toBe(false);
    expect(openAiDeviceCode?.onboardingFeatured).not.toBe(true);
    expect(openAiDeviceCode?.groupId).toBe("openai");
    expect(openAiDeviceCode?.groupLabel).toBe("OpenAI");
    expect(openAiDeviceCode?.groupHint).toBe("ChatGPT/Codex sign-in or API key");
    expect(apiKey?.choiceLabel).toBe("OpenAI API Key");
    expect(apiKey?.choiceHint).toBe("Use your OpenAI API key directly");
    expect(apiKey?.groupId).toBe("openai");
    expect(apiKey?.groupLabel).toBe("OpenAI");
    expect(apiKey?.groupHint).toBe("ChatGPT/Codex sign-in or API key");
    expect(choices.map((choice) => choice.choiceLabel)).not.toContain(
      "OpenAI Codex (ChatGPT OAuth)",
    );
    expect(choices.map((choice) => choice.groupHint)).not.toContain("Codex OAuth + API key");
    expect(choices.map((choice) => choice.groupHint)).not.toContain("API key or Codex sign-in");
  });

  it("keeps Spark suppression conditional on direct OpenAI API rows", () => {
    const sparkSuppression = manifest.modelCatalog?.suppressions?.find(
      (suppression) =>
        suppression.provider === "openai" && suppression.model === "gpt-5.3-codex-spark",
    );

    expect(sparkSuppression?.when).toEqual({
      baseUrlHosts: ["api.openai.com"],
    });
  });

  it("keeps the Azure transport alias and Spark suppression owned by the manifest", () => {
    expect(manifest.modelCatalog?.aliases?.["azure-openai-responses"]).toEqual({
      provider: "openai",
      api: "azure-openai-responses",
    });
    const azureSparkSuppression = manifest.modelCatalog?.suppressions?.find(
      (suppression) =>
        suppression.provider === "azure-openai-responses" &&
        suppression.model === "gpt-5.3-codex-spark",
    );

    expect(azureSparkSuppression).toMatchObject({
      provider: "azure-openai-responses",
      model: "gpt-5.3-codex-spark",
    });
    expect(azureSparkSuppression).not.toHaveProperty("when");
  });

  it("keeps manifest auth choices aligned with the lightweight provider descriptor", () => {
    const provider = createOpenAIProvider();
    for (const choice of manifest.providerAuthChoices ?? []) {
      const key = `${choice.provider}:${choice.method}`;
      const method = provider.auth.find((entry) => entry.id === choice.method);

      expect(method, key).toBeDefined();
      expect(comparableWizardFields(method?.wizard ?? {}), key).toEqual(
        comparableWizardFields(choice),
      );
    }
  });

  it.each([
    ["setup", buildOpenAISetupProvider],
    ["full runtime", buildOpenAIProvider],
  ])("keeps %s provider metadata on the lightweight descriptor", (_surface, buildProvider) => {
    expect(comparableProviderMetadata(buildProvider())).toEqual(
      comparableProviderMetadata(createOpenAIProvider()),
    );
  });
});
