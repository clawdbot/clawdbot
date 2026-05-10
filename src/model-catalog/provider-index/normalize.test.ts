import { describe, expect, it } from "vitest";
import { loadOpenClawProviderIndex, normalizeOpenClawProviderIndex } from "./index.js";

describe("OpenClaw provider index", () => {
  it("normalizes provider preview catalog rows through model catalog validation", () => {
    const index = normalizeOpenClawProviderIndex({
      version: 1,
      providers: {
        Moonshot: {
          id: "moonshot",
          name: "Moonshot AI",
          plugin: {
            id: "moonshot",
            package: " @openclaw/plugin-moonshot ",
            install: {
              clawhubSpec: " clawhub:openclaw/moonshot@2026.5.2 ",
              npmSpec: " @openclaw/plugin-moonshot@1.2.3 ",
              defaultChoice: "clawhub",
              expectedIntegrity: " sha512-moonshot ",
            },
          },
          docs: "/providers/moonshot",
          categories: ["cloud", "llm"],
          authChoices: [
            {
              method: " api-key ",
              choiceId: " moonshot-api-key ",
              choiceLabel: " Moonshot API key ",
              groupLabel: " Moonshot AI ",
              assistantPriority: -1,
              assistantVisibility: "visible",
              onboardingScopes: ["text-inference", "bad-scope"],
            },
            {
              method: "__proto__",
              choiceId: "bad",
              choiceLabel: "Bad",
            },
          ],
          previewCatalog: {
            api: "openai-responses",
            baseUrl: "https://api.moonshot.ai/v1",
            models: [
              {
                id: "kimi-k2.6",
                name: "Kimi K2.6",
                input: ["text", "image", "audio"],
                contextWindow: 262144,
              },
              { id: "" },
            ],
          },
        },
      },
    });

    expect(index).toEqual({
      version: 1,
      providers: {
        moonshot: {
          id: "moonshot",
          name: "Moonshot AI",
          plugin: {
            id: "moonshot",
            package: "@openclaw/plugin-moonshot",
            install: {
              clawhubSpec: "clawhub:openclaw/moonshot@2026.5.2",
              npmSpec: "@openclaw/plugin-moonshot@1.2.3",
              defaultChoice: "clawhub",
              expectedIntegrity: "sha512-moonshot",
            },
          },
          docs: "/providers/moonshot",
          categories: ["cloud", "llm"],
          authChoices: [
            {
              method: "api-key",
              choiceId: "moonshot-api-key",
              choiceLabel: "Moonshot API key",
              assistantPriority: -1,
              assistantVisibility: "visible",
              groupId: "moonshot",
              groupLabel: "Moonshot AI",
              onboardingScopes: ["text-inference"],
            },
          ],
          previewCatalog: {
            api: "openai-responses",
            baseUrl: "https://api.moonshot.ai/v1",
            models: [
              {
                id: "kimi-k2.6",
                name: "Kimi K2.6",
                input: ["text", "image"],
                contextWindow: 262144,
                status: "preview",
              },
            ],
          },
        },
      },
    });
  });

  it("drops unsafe providers and malformed preview catalog rows", () => {
    const index = normalizeOpenClawProviderIndex({
      version: 1,
      providers: {
        ["__proto__"]: {
          id: "__proto__",
          name: "Bad",
          plugin: { id: "bad" },
        },
        mismatch: {
          id: "other",
          name: "Mismatch",
          plugin: { id: "mismatch" },
        },
        valid: {
          id: "valid",
          name: "Valid",
          plugin: { id: "valid" },
          previewCatalog: {
            models: [{ name: "missing id" }],
          },
        },
      },
    });

    expect(index).toEqual({
      version: 1,
      providers: {
        valid: {
          id: "valid",
          name: "Valid",
          plugin: { id: "valid" },
        },
      },
    });
  });

  it("loads the bundled provider index without runtime plugin loading", () => {
    const index = loadOpenClawProviderIndex();

    expect(index.providers.moonshot?.previewCatalog).not.toHaveProperty("api");
    expect(index.providers.moonshot?.previewCatalog).not.toHaveProperty("baseUrl");
    const kimi = index.providers.moonshot?.previewCatalog?.models.find(
      (model) => model.id === "kimi-k2.6",
    );
    expect(kimi?.status).toBe("preview");
    expect(index.providers.deepseek?.plugin.id).toBe("deepseek");
    const deepseekChat = index.providers.deepseek?.previewCatalog?.models.find(
      (model) => model.id === "deepseek-chat",
    );
    expect(deepseekChat?.contextWindow).toBe(131072);
  });
});
