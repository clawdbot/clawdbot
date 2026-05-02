import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceLabel?: string;
    choiceHint?: string;
    choiceId?: string;
    deprecatedChoiceIds?: string[];
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

describe("OpenAI plugin manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    expect(packageJson.dependencies?.["@mariozechner/pi-ai"]).toBe("0.71.1");
    expect(packageJson.dependencies?.ws).toBe("^8.20.0");
  });

  it("keeps removed Codex CLI import auth choice as a deprecated browser-login alias", () => {
    const codexBrowserLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai-codex",
    );

    expect(codexBrowserLogin?.deprecatedChoiceIds).toContain("openai-codex-import");
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

    expect(codexBrowserLogin).toMatchObject({
      choiceLabel: "OpenAI Codex Browser Login",
      choiceHint: "Sign in with OpenAI in your browser",
      groupId: "openai-codex",
      groupLabel: "OpenAI Codex",
      groupHint: "ChatGPT/Codex sign-in",
    });
    expect(codexDeviceCode).toMatchObject({
      choiceLabel: "OpenAI Codex Device Pairing",
      choiceHint: "Pair in browser with a device code",
      groupId: "openai-codex",
      groupLabel: "OpenAI Codex",
      groupHint: "ChatGPT/Codex sign-in",
    });
    expect(apiKey).toMatchObject({
      choiceLabel: "OpenAI API Key",
      groupId: "openai",
      groupLabel: "OpenAI",
      groupHint: "Direct API key",
    });
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

      expect(wizards.get(key), key).toMatchObject(manifestComparableWizardFields(choice));
    }
  });
});
