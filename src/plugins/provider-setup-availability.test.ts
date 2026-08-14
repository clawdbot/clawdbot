import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectAvailableSetupProviderIds } from "./provider-setup-availability.js";

const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn());
const enablePluginInConfig = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn());
const debug = vi.hoisted(() => vi.fn());

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

vi.mock("./enable.js", () => ({
  enablePluginInConfig,
}));

vi.mock("./providers.runtime.js", () => ({
  resolvePluginProvidersCore,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug }),
}));

describe("detectAvailableSetupProviderIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "ollama",
        providerId: "ollama",
        methodId: "local",
        choiceId: "ollama",
        choiceLabel: "Ollama",
        appGuidedDiscovery: true,
      },
    ]);
    enablePluginInConfig.mockImplementation((config: unknown) => ({
      config,
      enabled: true,
      pluginId: "ollama",
    }));
  });

  it("returns the provider id when its read-only availability probe succeeds", async () => {
    const detectAvailability = vi.fn(async () => true);
    resolvePluginProvidersCore.mockReturnValue([
      {
        pluginId: "ollama",
        id: "ollama",
        auth: [{ id: "local", appGuidedSetup: { detectAvailability } }],
      },
    ]);

    await expect(detectAvailableSetupProviderIds({ config: {} })).resolves.toEqual(
      new Set(["ollama"]),
    );
    expect(detectAvailability).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      workspaceDir: undefined,
    });
  });

  it("treats failed availability probes as an intentional non-match", async () => {
    resolvePluginProvidersCore.mockReturnValue([
      {
        pluginId: "ollama",
        id: "ollama",
        auth: [
          {
            id: "local",
            appGuidedSetup: {
              detectAvailability: vi.fn(async () => {
                throw new Error("offline");
              }),
            },
          },
        ],
      },
    ]);

    await expect(detectAvailableSetupProviderIds({ config: {} })).resolves.toEqual(new Set());
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
