import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

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
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
  }>;
};

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
};

function manifestComparableWizardFields(choice: {
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
}) {
  return Object.fromEntries(
    Object.entries({
      choiceId: choice.choiceId,
      choiceLabel: choice.choiceLabel,
      choiceHint: choice.choiceHint,
      groupId: choice.groupId,
      groupLabel: choice.groupLabel,
      groupHint: choice.groupHint,
    }).filter(([, value]) => value !== undefined),
  );
}

function providerWizardByKey() {
  const providers = [buildOpenAIProvider(), buildOpenAICodexProviderPlugin()];
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
    expect(packageJson.dependencies?.["@earendil-works/pi-ai"]).toBe("0.74.0");
    expect(packageJson.dependencies?.ws).toBe("^8.20.0");
  });

  it("keeps removed Codex CLI import auth choice as a deprecated browser-login alias", () => {
    const codexBrowserLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai-codex",
    );

    expect(codexBrowserLogin?.deprecatedChoiceIds).toContain("openai-codex-import");
  });

  it("keeps Codex media-understanding manifest metadata aligned with runtime audio support", () => {
    const metadata = manifest.mediaUnderstandingProviderMetadata?.["openai-codex"];
    expect(metadata?.capabilities).toEqual(["image", "audio"]);
    expect(metadata?.defaultModels?.image).toBe("gpt-5.5");
    expect(metadata?.defaultModels?.audio).toBe("gpt-4o-transcribe");
    expect(metadata?.autoPriority?.image).toBe(20);
    expect(metadata?.autoPriority?.audio).toBe(20);
  });

  it("labels OpenAI API key and Codex auth choices without stale mixed OAuth wording", () => {
    const choices = manifest.providerAuthChoices ?? [];
    const codexBrowserLogin = choices.find((choice) => choice.choiceId === "openai-codex");
    const codexDeviceCode = choices.find(
      (choice) => choice.choiceId === "openai-codex-device-code",
    );
    const apiKey = choices.find(
      (choice) => choice.provider === "openai" && choice.method === "api-key",
    );

    expect(codexBrowserLogin?.choiceLabel).toBe("OpenAI Codex Browser Login");
    expect(codexBrowserLogin?.choiceHint).toBe("Sign in with OpenAI in your browser");
    expect(codexBrowserLogin?.groupId).toBe("openai-codex");
    expect(codexBrowserLogin?.groupLabel).toBe("OpenAI Codex");
    expect(codexBrowserLogin?.groupHint).toBe("ChatGPT/Codex sign-in");
    expect(codexDeviceCode?.choiceLabel).toBe("OpenAI Codex Device Pairing");
    expect(codexDeviceCode?.choiceHint).toBe("Pair in browser with a device code");
    expect(codexDeviceCode?.groupId).toBe("openai-codex");
    expect(codexDeviceCode?.groupLabel).toBe("OpenAI Codex");
    expect(codexDeviceCode?.groupHint).toBe("ChatGPT/Codex sign-in");
    expect(apiKey?.choiceLabel).toBe("OpenAI API Key");
    expect(apiKey?.groupId).toBe("openai");
    expect(apiKey?.groupLabel).toBe("OpenAI");
    expect(apiKey?.groupHint).toBe("Direct API key");
    expect(choices.map((choice) => choice.choiceLabel)).not.toContain(
      "OpenAI Codex (ChatGPT OAuth)",
    );
    expect(choices.map((choice) => choice.groupHint)).not.toContain("Codex OAuth + API key");
    expect(choices.map((choice) => choice.groupHint)).not.toContain("API key or Codex sign-in");
  });

  it("keeps auth choice copy aligned with provider wizard metadata", () => {
    const wizards = providerWizardByKey();

    for (const choice of manifest.providerAuthChoices ?? []) {
      const key = `${choice.provider}:${choice.method}`;

      expectWizardFields(wizards.get(key), manifestComparableWizardFields(choice), key);
    }
  });
});
