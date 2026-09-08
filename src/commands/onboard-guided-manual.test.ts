import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { WizardSelectParams } from "../wizard/prompts.js";
import { runManualStage } from "./onboard-guided-manual.js";

vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));
vi.mock("../plugins/provider-setup-availability.js", () => ({
  detectAvailableSetupProviderIds: async () => new Set(),
}));
vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: () => [
    {
      providerId: "fixture",
      source: "install-catalog",
      option: {
        value: "fixture-api-key",
        label: "Fixture API key",
        group: { id: "fixture", label: "Fixture" },
      },
    },
  ],
}));

describe("guided provider catalog", () => {
  it("offers an install-catalog provider before its manifest is installed", async () => {
    const activate = vi.fn(async () => ({
      ok: true as const,
      lines: ["Connected"],
      latencyMs: 1,
      modelRef: "fixture/default",
    }));
    const prompter = createWizardPrompter({}, { selectValues: ["fixture"] });
    vi.mocked(prompter.select).mockImplementationOnce(
      async <T>({ options }: WizardSelectParams<T>): Promise<T> => {
        const provider = options.find((option) => option.value === "fixture");
        expect(provider).toBeDefined();
        if (!provider) {
          throw new Error("The official install-catalog provider is missing.");
        }
        return provider.value;
      },
    );
    await expect(
      runManualStage({
        detection: {
          candidates: [],
          unavailableCandidates: [],
          manualProviders: [],
          authOptions: [],
          recommendedInstalls: [],
          workspace: "/tmp/fixture-workspace",
          setupComplete: false,
        },
        config: {},
        workspace: "/tmp/fixture-workspace",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
        prompter,
        activate,
      }),
    ).resolves.toContain("Connected");
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "provider-auth", authChoice: "fixture-api-key" }),
    );
  });
});
