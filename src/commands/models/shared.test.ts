// Model command shared tests cover shared config and provider helper behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, TransformConfigFileParams } from "../../config/config.js";
import { loadValidConfigOrThrow, resolveModelsTargetAgent, updateConfig } from "./shared.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  transformConfigFile: async ({ transform }: TransformConfigFileParams<unknown>) => {
    const loaded = await mocks.readConfigFileSnapshot();
    const snapshot = {
      path: "/tmp/openclaw.json",
      parsed: loaded.sourceConfig ?? loaded.config,
      runtimeConfig: loaded.config,
      ...loaded,
    };
    const { nextConfig, result } = await transform(
      snapshot.sourceConfig ?? snapshot.config,
      { snapshot, previousHash: snapshot.hash ?? null, attempt: 0 },
      {},
    );
    await mocks.replaceConfigFile({ sourceConfig: nextConfig, baseHash: snapshot.hash });
    return { nextConfig, result };
  },
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
    expect(replaceParams?.sourceConfig.update).toEqual({ channel: "beta" });
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
    expect(replaceParams?.sourceConfig).toEqual(sourceConfig);
    expect(replaceParams?.baseHash).toBe("config-2");
  });
});
