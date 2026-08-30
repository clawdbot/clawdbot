import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsCli } from "../../cli/models-cli.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { addFallbackCommand, removeFallbackCommand } from "./fallbacks-shared.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

describe.each([
  {
    name: "fallbacks",
    label: "Fallbacks",
    key: "model" as const,
    model: "anthropic/claude-sonnet-4-6",
  },
  {
    name: "image-fallbacks",
    label: "Image fallbacks",
    key: "imageModel" as const,
    model: "openai/gpt-image-1",
  },
])("models $name list", (testCase) => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.replaceConfigFile.mockReset();
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          [testCase.key]: { fallbacks: [testCase.model] },
        },
      },
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("does not remove a distinct configured model with a nested provider prefix", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        providers: {
          custom: { api: "openai-completions", baseUrl: "https://custom.example/v1", models: [] },
        },
      },
      agents: { defaults: { [testCase.key]: { fallbacks: ["custom/custom/model"] } } },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "fallback-config",
      sourceConfig: cfg,
      config: cfg,
    });
    const snapshot = createPluginMetadataSnapshot({
      config: cfg,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });

    await withPluginMetadataSnapshotScope(
      snapshot,
      async () => {
        await expect(
          removeFallbackCommand(
            {
              label: testCase.label,
              key: testCase.key,
              notFoundLabel: "Fallback",
            },
            "custom/model",
            defaultRuntime,
          ),
        ).rejects.toThrow("Fallback not found: custom/model.");
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      },
      { config: cfg },
    );
  });

  it("adds a distinct nested model without replacing the existing fallback or its metadata", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        providers: {
          custom: { api: "openai-completions", baseUrl: "https://custom.example/v1", models: [] },
        },
      },
      agents: {
        defaults: {
          [testCase.key]: { primary: "custom/primary", fallbacks: ["custom/model"] },
          models: { "custom/model": { alias: "short", params: { temperature: 0.2 } } },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "fallback-config",
      sourceConfig: cfg,
      config: cfg,
    });
    const snapshot = createPluginMetadataSnapshot({
      config: cfg,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });

    await withPluginMetadataSnapshotScope(
      snapshot,
      () =>
        addFallbackCommand(
          { label: testCase.label, key: testCase.key },
          "custom/custom/model",
          defaultRuntime,
        ),
      { config: cfg },
    );

    expect(mocks.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({
      baseHash: "fallback-config",
      nextConfig: {
        ...cfg,
        agents: {
          defaults: {
            [testCase.key]: {
              primary: "custom/primary",
              fallbacks: ["custom/model", "custom/custom/model"],
            },
            models: {
              "custom/model": { alias: "short", params: { temperature: 0.2 } },
              "custom/custom/model": {},
            },
          },
        },
      },
    });
  });

  it.each([
    ["--json", testCase.name, "list"],
    [testCase.name, "list", "--json"],
  ])("writes JSON and attributes diagnostics for %s %s %s", async (...args) => {
    await runRegisteredCli({ register: registerModelsCli, argv: ["models", ...args] });

    expect(mocks.loadModelsConfig).toHaveBeenCalledWith({
      commandName: `models ${testCase.name} list`,
      runtime: defaultRuntime,
    });
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls.map(([value]) => value)).toEqual([
      {
        fallbacks: [testCase.model],
      },
    ]);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it("writes populated plain output directly to stdout", async () => {
    await runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", testCase.name, "list", "--plain"],
    });

    expect(defaultRuntime.writeStdout).toHaveBeenCalledExactlyOnceWith(testCase.model);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves human output (empty: %s)", async (empty) => {
    if (empty) {
      mocks.loadModelsConfig.mockResolvedValue({});
    }
    await runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", testCase.name, "list"],
    });

    expect(vi.mocked(defaultRuntime.log).mock.calls).toEqual([
      [`${testCase.label} (${empty ? 0 : 1}):`],
      [empty ? "- none" : `- ${testCase.model}`],
    ]);
  });
});
