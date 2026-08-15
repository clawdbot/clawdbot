// Provider-index normalization tests cover preview catalogs, install metadata, auth choices, and malformed input.
import { describe, expect, it } from "vitest";
import { loadOpenClawProviderIndex } from "./index.js";
import { normalizeOpenClawProviderIndex } from "./normalize.js";

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
    const kimiK3 = index.providers.moonshot?.previewCatalog?.models.find(
      (model) => model.id === "kimi-k3",
    );
    expect(kimiK3).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      status: "preview",
    });
    const kimiCode = index.providers.moonshot?.previewCatalog?.models.find(
      (model) => model.id === "kimi-k2.7-code",
    );
    expect(kimiCode).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      status: "preview",
    });
    const kimiCodeHighSpeed = index.providers.moonshot?.previewCatalog?.models.find(
      (model) => model.id === "kimi-k2.7-code-highspeed",
    );
    expect(kimiCodeHighSpeed).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      status: "preview",
    });
    expect(index.providers.deepseek?.plugin.id).toBe("deepseek");
    expect(
      index.providers.deepseek?.previewCatalog?.models.map(({ id, reasoning, contextWindow }) => ({
        id,
        reasoning,
        contextWindow,
      })),
    ).toEqual([
      { id: "deepseek-v4-flash", reasoning: true, contextWindow: 1000000 },
      { id: "deepseek-v4-pro", reasoning: true, contextWindow: 1000000 },
      { id: "deepseek-chat", reasoning: undefined, contextWindow: 1000000 },
      { id: "deepseek-reasoner", reasoning: true, contextWindow: 1000000 },
    ]);
  });
});
