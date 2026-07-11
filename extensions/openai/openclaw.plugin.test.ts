// Openai tests cover openclaw.plugin plugin behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import { buildOpenAISetupProvider } from "./setup-api.js";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  mediaUnderstandingProviderMetadata?: Record<
    string,
    {
      capabilities?: string[];
      defaultModels?: Record<string, string>;
      autoPriority?: Record<string, number>;
    }
  >;
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceLabel?: string;
    choiceHint?: string;
    choiceId?: string;
    deprecatedChoiceIds?: string[];
    assistantVisibility?: string;
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
  }>;
  setup?: {
    providers?: Array<{ id: string }>;
  };
  modelCatalog?: {
    suppressions?: Array<{
      provider?: string;
      model?: string;
      when?: {
        baseUrlHosts?: string[];
        providerConfigApiIn?: string[];
      };
    }>;
  };
  providerEndpoints?: Array<{
    endpointClass?: string;
    hosts?: string[];
    hostSuffixes?: string[];
  }>;
  providerAuthAliases?: Record<string, string>;
  legacyPluginIds?: string[];
};

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function manifestComparableWizardFields(choice: {
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  assistantVisibility?: string;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
}) {
  return Object.fromEntries(
    Object.entries({
      choiceId: choice.choiceId,
      choiceLabel: choice.choiceLabel,
      choiceHint: choice.choiceHint,
      assistantVisibility: choice.assistantVisibility,
      groupId: choice.groupId,
      groupLabel: choice.groupLabel,
      groupHint: choice.groupHint,
    }).filter(([, value]) => value !== undefined),
  );
}

function providerWizardByKey() {
  const providers = [buildOpenAIProvider(), buildOpenAISetupProvider()];
  const wizards = new Map<string, Record<string, unknown>>();

  for (const provider of providers) {
    for (const authMethod of provider.auth ?? []) {
      if (authMethod.wizard) {
        wizards.set(`${provider.id}:${authMethod.id}`, authMethod.wizard);
      }
    }
  }

  return wizards;
}

function expectWizardFields(
  wizard: Record<string, unknown> | undefined,
  choice: ReturnType<typeof manifestComparableWizardFields>,
  key: string,
) {
  if (!wizard) {
    throw new Error(`Missing wizard for ${key}`);
  }
  for (const [field, value] of Object.entries(choice)) {
    expect(wizard[field], `${key}.${field}`).toBe(value);
  }
}

describe("OpenAI plugin manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    expect(packageJson.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
    expect(packageJson.dependencies?.ws).toBe("8.21.0");
  });

  it("exposes only current OpenAI login choices", () => {
    const openAiLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai",
    );

    expect(openAiLogin?.deprecatedChoiceIds).toBeUndefined();
  });

  it("routes setup through the OpenAI setup runtime", () => {
    expect(manifest.legacyPluginIds).toBeUndefined();
    expect(manifest.setup?.providers?.map((provider) => provider.id)).toEqual(["openai"]);
    expect(manifest.providerAuthAliases).toBeUndefined();
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

  it("labels OpenAI API key and Codex auth choices without stale mixed OAuth wording", () => {
    const choices = manifest.providerAuthChoices ?? [];
    const openAiLogin = choices.find((choice) => choice.choiceId === "openai");
    const openAiDeviceCode = choices.find((choice) => choice.choiceId === "openai-device-code");
    const apiKey = choices.find(
      (choice) => choice.provider === "openai" && choice.method === "api-key",
    );

    expect(openAiLogin?.choiceLabel).toBe("ChatGPT Login");
    expect(openAiLogin?.choiceHint).toBe("Sign in with your ChatGPT or Codex subscription");
    expect(openAiLogin?.assistantVisibility).toBeUndefined();
    expect(openAiLogin?.groupId).toBe("openai");
    expect(openAiLogin?.groupLabel).toBe("OpenAI");
    expect(openAiLogin?.groupHint).toBe("ChatGPT/Codex sign-in or API key");
    expect(openAiDeviceCode?.choiceLabel).toBe("ChatGPT Device Pairing");
    expect(openAiDeviceCode?.choiceHint).toBe(
      "Pair your ChatGPT account in browser with a device code",
    );
    expect(openAiDeviceCode?.assistantVisibility).toBe("manual-only");
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

  it("keeps auth choice copy aligned with provider wizard metadata", () => {
    const wizards = providerWizardByKey();

    for (const choice of manifest.providerAuthChoices ?? []) {
      const key = `${choice.provider}:${choice.method}`;

      expectWizardFields(wizards.get(key), manifestComparableWizardFields(choice), key);
    }
  });
});
