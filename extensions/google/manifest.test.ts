// Google tests cover manifest plugin behavior.
import { readFileSync } from "node:fs";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/core";
import type { JsonSchemaObject } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";

type GoogleManifest = {
  setup?: {
    providers?: Array<{
      id?: string;
      authEvidence?: Array<{
        fileEnvVar?: string;
        fallbackPaths?: string[];
      }>;
    }>;
  };
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceLabel?: string;
    choiceHint?: string;
    groupHint?: string;
  }>;
  modelIdNormalization?: {
    providers?: Record<
      string,
      {
        aliases?: Record<string, string>;
      }
    >;
  };
  modelCatalog?: {
    discovery?: Record<string, string>;
    suppressions?: Array<{
      provider?: string;
      model?: string;
      reason?: string;
    }>;
    providers?: Record<
      string,
      {
        api?: string;
        baseUrl?: string;
        models?: Array<{
          id?: string;
          name?: string;
        }>;
      }
    >;
  };
  configSchema?: JsonSchemaObject;
  configContracts?: {
    secretInputs?: {
      paths?: Array<{ path?: string; expected?: string }>;
    };
  };
  contracts?: {
    usageProviders?: string[];
  };
  uiHints?: Record<string, { sensitive?: boolean }>;
};

const RETIRED_GEMINI_CHAT_MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-exp-image-generation",
  "gemini-2.0-flash-live-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash-lite-preview",
  "gemini-2.0-flash-lite-preview-02-05",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-2.0-flash-thinking-exp",
  "gemini-2.0-flash-thinking-exp-01-21",
  "gemini-2.0-flash-thinking-exp-1219",
  "gemini-2.0-pro-exp",
  "gemini-2.0-pro-exp-02-05",
  "gemini-2.5-flash-exp-native-audio-thinking-dialog",
  "gemini-2.5-flash-image-preview",
  "gemini-2.5-flash-lite-preview-06-17",
  "gemini-2.5-flash-lite-preview-09-25",
  "gemini-2.5-flash-lite-preview-09-2025",
  "gemini-2.5-flash-preview-04-17",
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.5-flash-preview-09-25",
  "gemini-2.5-flash-preview-09-2025",
  "gemini-2.5-flash-preview-native-audio-dialog",
  "gemini-2.5-pro-exp-03-25",
  "gemini-2.5-pro-preview-03-25",
  "gemini-2.5-pro-preview-05-06",
  "gemini-2.5-pro-preview-06-05",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-live-2.5-flash",
  "gemini-live-2.5-flash-preview",
  "gemini-live-2.5-flash-preview-native-audio",
] as const;

const GOOGLE_CHAT_PROVIDERS = ["google", "google-gemini-cli", "google-vertex"] as const;

function loadManifest(): GoogleManifest {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
}

describe("google manifest model catalog", () => {
  it("checks relocated Cloud SDK ADC before platform-specific fallback paths", () => {
    const vertex = loadManifest().setup?.providers?.find(
      (provider) => provider.id === "google-vertex",
    );

    expect(vertex?.authEvidence).toEqual([
      expect.objectContaining({
        fileEnvVar: "GOOGLE_APPLICATION_CREDENTIALS",
        fallbackPaths: [
          "${CLOUDSDK_CONFIG}/application_default_credentials.json",
          "${HOME}/.config/gcloud/application_default_credentials.json",
          "${APPDATA}/gcloud/application_default_credentials.json",
        ],
      }),
    ]);
  });

  it("owns the canonical Google model catalog and runtime discovery declaration", () => {
    const catalog = loadManifest().modelCatalog;
    const provider = catalog?.providers?.google;
    const modelIds = provider?.models?.map((model) => model.id) ?? [];

    expect(catalog?.discovery?.google).toBe("runtime");
    expect(provider).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(modelIds).toHaveLength(10);
    expect(modelIds).not.toContain(undefined);
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it("keeps legacy Google chat providers out of the canonical manifest catalog", () => {
    const manifest = loadManifest();

    // google-gemini-cli references must stay unknown-model so Doctor keeps
    // emitting its migration hint, and neither CLI nor Vertex declares runtime
    // discovery, so manifest rows for them would leak into runtime catalog
    // planning. Only the canonical google provider owns manifest rows.
    expect(manifest.modelCatalog?.providers?.["google-gemini-cli"]).toBeUndefined();
    expect(manifest.modelCatalog?.providers?.["google-vertex"]).toBeUndefined();
  });

  it("offers Google AI Studio API keys without consumer CLI OAuth", () => {
    const choices = loadManifest().providerAuthChoices ?? [];

    expect(choices).toEqual([
      expect.objectContaining({
        provider: "google",
        method: "api-key",
        choiceLabel: "Google AI Studio API key",
        choiceHint: "Supported API-key access from aistudio.google.com/apikey",
        groupHint: "Supported API-key setup",
      }),
    ]);
    expect(choices.some((choice) => choice.provider === "google-gemini-cli")).toBe(false);
  });

  it("does not advertise retired Gemini CLI quota hooks", () => {
    expect(loadManifest().contracts?.usageProviders).toBeUndefined();
  });

  it("suppresses retired Gemini chat model identifiers for all Google chat providers", () => {
    const manifest = loadManifest();
    const suppressionRefs = new Set(
      (manifest.modelCatalog?.suppressions ?? []).map(
        (suppression) => `${suppression.provider}/${suppression.model}`,
      ),
    );

    for (const provider of GOOGLE_CHAT_PROVIDERS) {
      for (const model of RETIRED_GEMINI_CHAT_MODELS) {
        expect(suppressionRefs).toContain(`${provider}/${model}`);
      }
    }
  });

  it("does not suppress still-callable Google replacement models", () => {
    const manifest = loadManifest();
    const suppressionRefs = new Set(
      (manifest.modelCatalog?.suppressions ?? []).map(
        (suppression) => `${suppression.provider}/${suppression.model}`,
      ),
    );

    expect(suppressionRefs).not.toContain("google/gemini-2.5-flash");
    expect(suppressionRefs).not.toContain("google/gemini-2.5-flash-lite");
    expect(suppressionRefs).not.toContain("google/gemini-2.5-pro");
    expect(suppressionRefs).not.toContain("google/gemini-3.1-pro-preview");
  });

  it("normalizes retired Gemini 3 Pro aliases for all Google chat providers", () => {
    const manifest = loadManifest();

    for (const provider of GOOGLE_CHAT_PROVIDERS) {
      const aliases = manifest.modelIdNormalization?.providers?.[provider]?.aliases;
      expect(aliases?.["gemini-3-pro"]).toBe("gemini-3.1-pro-preview");
      expect(aliases?.["gemini-3-pro-preview"]).toBe("gemini-3.1-pro-preview");
    }
  });
});

describe("google manifest webSearch headers", () => {
  function validateWebSearchConfig(webSearch: unknown): { success: boolean } {
    const schema = loadManifest().configSchema;
    if (!schema) {
      throw new Error("expected google manifest configSchema");
    }
    const safeParse = buildJsonPluginConfigSchema(schema).safeParse;
    if (!safeParse) {
      throw new Error("expected a safeParse validator for the google config schema");
    }
    return safeParse({ webSearch });
  }

  it("accepts plain and SecretRef header values", () => {
    expect(validateWebSearchConfig({ headers: { "X-Routing-Target": "staging" } }).success).toBe(
      true,
    );
    expect(
      validateWebSearchConfig({
        headers: {
          "X-Gateway-Token": {
            source: "env",
            provider: "default",
            id: "GEMINI_GATEWAY_TOKEN",
          },
        },
      }).success,
    ).toBe(true);
    expect(validateWebSearchConfig({ headers: { "X-Retry-Count": 3 } }).success).toBe(false);
  });

  it("uses the existing SecretRef contract without classifying plain headers as sensitive", () => {
    const manifest = loadManifest();
    expect(manifest.configContracts?.secretInputs?.paths).toContainEqual({
      path: "webSearch.headers.*",
      expected: "string",
    });
    expect(manifest.uiHints?.["webSearch.headers"]?.sensitive).not.toBe(true);
    expect(manifest.uiHints?.["webSearch.headers.*"]?.sensitive).not.toBe(true);
  });
});
