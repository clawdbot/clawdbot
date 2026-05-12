import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type GoogleManifest = {
  modelIdNormalization?: {
    providers?: Record<
      string,
      {
        aliases?: Record<string, string>;
      }
    >;
  };
  modelCatalog?: {
    suppressions?: Array<{
      provider?: string;
      model?: string;
      reason?: string;
    }>;
  };
};

const RETIRED_GEMINI_CHAT_MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-exp-image-generation",
  "gemini-2.0-flash-live-001",
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

    expect(suppressionRefs).not.toContain("google/gemini-2.0-flash");
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
