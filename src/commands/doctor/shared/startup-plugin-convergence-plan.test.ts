import { beforeEach, describe, expect, it, vi } from "vitest";

const loadInstalledPluginIndexInstallRecords = vi.hoisted(() => vi.fn(async () => ({})));
const inspectBundledPluginStartupMetadata = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords,
}));
vi.mock("../../../plugins/bundled-plugin-startup-metadata.js", () => ({
  inspectBundledPluginStartupMetadata,
}));

const { configMayRequireStartupPluginConvergence, planStartupPluginConvergence } =
  await import("./startup-plugin-convergence-plan.js");

describe("startup plugin convergence planning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    inspectBundledPluginStartupMetadata.mockReturnValue(undefined);
  });

  it("keeps a fresh core-only Gateway config out of the plugin repair runtime", async () => {
    const env = {};
    const plan = await planStartupPluginConvergence({
      config: { gateway: { mode: "local", port: 19091 } },
      env,
    });

    expect(plan).toEqual({ required: false, installRecords: {} });
    expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({ env });
  });

  it("carries managed install records into convergence", async () => {
    const installRecords = {
      discord: { source: "npm" as const, installPath: "/plugins/discord" },
    };
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(installRecords);

    await expect(planStartupPluginConvergence({ config: {}, env: {} })).resolves.toEqual({
      required: true,
      installRecords,
    });
  });

  it("retains convergence for explicit plugin and runtime configuration", () => {
    expect(
      configMayRequireStartupPluginConvergence({
        config: { plugins: { entries: { example: { enabled: true } } } },
        env: {},
      }),
    ).toBe(true);
    expect(
      configMayRequireStartupPluginConvergence({
        config: { acp: { enabled: true } },
        env: {},
      }),
    ).toBe(true);
  });

  it("does not repair configured plugins already bundled with the host", () => {
    inspectBundledPluginStartupMetadata.mockReturnValue({ hasDoctorContract: false });

    expect(
      configMayRequireStartupPluginConvergence({
        config: { plugins: { entries: { openai: { enabled: true } } } },
        env: {},
      }),
    ).toBe(false);
  });

  it("does not infer plugin work from core OpenAI model configuration", () => {
    expect(
      configMayRequireStartupPluginConvergence({
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-responses",
                models: [],
              },
            },
          },
        },
        env: { OPENAI_API_KEY: "redacted" },
      }),
    ).toBe(false);
  });

  it("retains convergence for official external provider configuration", () => {
    expect(
      configMayRequireStartupPluginConvergence({
        config: { agents: { defaults: { model: { primary: "groq/llama-3.3-70b" } } } },
        env: {},
      }),
    ).toBe(true);
  });
});
