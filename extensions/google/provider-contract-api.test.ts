import { describe, expect, it, vi } from "vitest";
import {
  createGoogleGeminiCliProvider,
  createGoogleProvider,
  createGoogleVertexProvider,
} from "./provider-contract-api.js";

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getProjectId() {
      return "auto-detected-project";
    }
  },
}));

describe("google provider contract", () => {
  it("exposes Google AI Studio API-key setup", () => {
    const provider = createGoogleProvider();

    expect(provider.auth).toEqual([
      expect.objectContaining({
        id: "api-key",
        label: "Google AI Studio API key",
        hint: "Supported API-key access from aistudio.google.com/apikey",
        wizard: expect.objectContaining({
          choiceLabel: "Google AI Studio API key",
          groupHint: "Supported API-key setup",
        }),
      }),
    ]);
  });

  it("keeps Gemini CLI as a runtime-only compatibility provider", () => {
    const provider = createGoogleGeminiCliProvider();

    expect(provider.label).toBe("Gemini CLI runtime");
    expect(provider.auth).toEqual([]);
    expect(provider.envVars).toEqual([]);
    expect(provider.wizard).toBeUndefined();
  });

  it("preserves existing Vertex project/location on onboarding rerun", async () => {
    const adc = createGoogleVertexProvider().auth?.find((method) => method.id === "adc");
    const result = await adc?.run?.({
      config: {
        env: {
          vars: { GOOGLE_CLOUD_PROJECT: "existing-project", GOOGLE_CLOUD_LOCATION: "us-central1" },
        },
      },
      prompter: { text: vi.fn(async () => ""), note: vi.fn(async () => {}) },
    } as never);
    const patch = result?.configPatch as { env?: { vars?: Record<string, string> } } | undefined;
    expect(patch?.env?.vars?.GOOGLE_CLOUD_PROJECT).toBe("existing-project");
    expect(patch?.env?.vars?.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
  });
});
