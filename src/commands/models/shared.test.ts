// Model command shared tests cover shared config and provider helper behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  applyDefaultModelPrimaryUpdate,
  loadValidConfigOrThrow,
  resolveModelKeysFromEntries,
  resolveModelTarget,
  resolveModelsTargetAgent,
  updateConfig,
} from "./shared.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

describe("models/shared", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.replaceConfigFile.mockClear();
  });

  it("returns config when snapshot is valid", async () => {
    const cfg = { providers: {} } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      runtimeConfig: cfg,
      config: cfg,
    });

    await expect(loadValidConfigOrThrow()).resolves.toBe(cfg);
  });

  it("throws formatted issues when snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [{ path: "providers.openai.apiKey", message: "Required" }],
    });

    await expect(loadValidConfigOrThrow()).rejects.toThrowError(
      "Invalid config at /tmp/openclaw.json\n- providers.openai.apiKey: Required",
    );
  });

  it("preserves exact configured model IDs when resolving command targets and entries", () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        providers: {
          custom: { api: "openai-completions", baseUrl: "https://custom.example/v1", models: [] },
        },
      },
    };
    const snapshot = createPluginMetadataSnapshot({
      config: cfg,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(resolveModelTarget({ cfg, raw: "custom/custom/model" })).toEqual({
          provider: "custom",
          model: "custom/model",
        });
        expect(resolveModelKeysFromEntries({ cfg, entries: ["custom/custom/model"] })).toEqual([
          "custom/custom/model",
        ]);
      },
      { config: cfg },
    );
  });

  it.each(["model", "imageModel"] as const)(
    "preserves distinct model metadata and nested refs when selecting the %s primary",
    (field) => {
      const models = {
        "custom/model": { alias: "short", params: { temperature: 0.2 } },
        "custom/custom/model": { alias: "nested", params: { temperature: 0.8 } },
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            [field]: {
              primary: "custom/model",
              fallbacks: ["custom/custom/fallback"],
            },
            models,
          },
        },
      };

      const next = applyDefaultModelPrimaryUpdate({
        cfg,
        field,
        modelRaw: "custom/custom/model",
        resolvedTarget: { provider: "custom", model: "custom/model" },
      });

      expect(next.agents?.defaults).toEqual({
        [field]: {
          primary: "custom/custom/model",
          fallbacks: ["custom/custom/fallback"],
        },
        models: {
          "custom/model": { alias: "short", params: { temperature: 0.2 } },
          "custom/custom/model": { alias: "nested", params: { temperature: 0.8 } },
        },
      });
    },
  );

  it.each(["model", "imageModel"] as const)(
    "retains equivalent short-ref settings when selecting the %s primary",
    (field) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openrouter/auto": { params: { thinking: "high" } },
            },
          },
        },
      };

      const next = applyDefaultModelPrimaryUpdate({
        cfg,
        field,
        modelRaw: "openrouter/auto",
        resolvedTarget: { provider: "openrouter", model: "openrouter/auto" },
      });

      expect(next.agents?.defaults).toEqual({
        [field]: { primary: "openrouter/openrouter/auto" },
        models: {
          "openrouter/auto": { params: { thinking: "high" } },
          "openrouter/openrouter/auto": { params: { thinking: "high" } },
        },
      });
    },
  );

  it("names only the supported model-command escape for an ambiguous roster", () => {
    expect(() =>
      resolveModelsTargetAgent(
        {
          agents: { ownership: "explicit", entries: { main: {}, helper: {}, third: {} } },
        },
        undefined,
        { kind: "mutation" },
      ),
    ).toThrow(
      "Multiple agents are configured, but the model command has no explicit owner. Pass --agent <id>.",
    );
  });

  it("resolves unscoped model reads through the configured system agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "helper" } },
        entries: { main: {}, helper: {} },
      },
    };

    expect(resolveModelsTargetAgent(cfg, undefined, { kind: "read" }).agentId).toBe("helper");
    expect(resolveModelsTargetAgent(cfg, "main", { kind: "read" }).agentId).toBe("main");
    expect(() => resolveModelsTargetAgent(cfg, "", { kind: "read" })).toThrow(
      "--agent must not be blank",
    );
    expect(() =>
      resolveModelsTargetAgent(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "missing" } },
            entries: { main: {}, helper: {} },
          },
        },
        undefined,
        { kind: "read" },
      ),
    ).toThrow('Unknown agent id "missing".');
  });

  it("keeps credential mutations explicit on an ambiguous roster", () => {
    expect(() =>
      resolveModelsTargetAgent(
        { agents: { ownership: "explicit", entries: { main: {}, helper: {} } } },
        undefined,
        { kind: "mutation" },
      ),
    ).toThrow(
      "Multiple agents are configured, but the model command has no explicit owner. Pass --agent <id>.",
    );
  });

  it("updateConfig writes mutated config", async () => {
    const cfg = { update: { channel: "stable" } } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "config-1",
      sourceConfig: cfg,
      config: cfg,
    });
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await updateConfig((current) => ({
      ...current,
      update: { channel: "beta" },
    }));

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    expect(replaceParams?.nextConfig.update).toEqual({ channel: "beta" });
    expect(replaceParams?.baseHash).toBe("config-1");
  });

  it("updateConfig exposes runtime config without writing runtime defaults", async () => {
    const sourceConfig = {
      agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": {} } } },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      agents: {
        defaults: {
          models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "config-2",
      sourceConfig,
      runtimeConfig,
      config: runtimeConfig,
    });
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await updateConfig((current, context) => {
      expect(current).toEqual(sourceConfig);
      expect(context.runtimeConfig).toEqual(runtimeConfig);
      return current;
    });

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    expect(replaceParams?.nextConfig).toEqual(sourceConfig);
    expect(replaceParams?.baseHash).toBe("config-2");
  });
});
