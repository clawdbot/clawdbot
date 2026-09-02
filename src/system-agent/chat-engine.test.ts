import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  RuntimeSystemAgentChatEngine,
  SystemAgentInferenceUnavailableError,
  type OpenClawConfig,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.test-support.js";
import { loadSystemAgentOverview } from "./overview.js";

describe("SystemAgentChatEngine facade", () => {
  it("uses the verified inference owner for a delegated fleet overview", async () => {
    useTempStateDir();
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { model: "openai/gpt-5.6-luna" }, work: {} },
      },
      gateway: { port: 1 },
    };
    const engine = new SystemAgentChatEngine({
      requesterAgentId: "main",
      deps: {
        loadOverview: async (options?: { agentId?: string }) =>
          loadSystemAgentOverview({
            ...options,
            deps: {
              readConfigFileSnapshot: async () => configSnapshot(config),
              probeLocalCommand: async (command) => ({ command, found: false }),
              probeGatewayUrl: async (url) => ({ url, reachable: false }),
            },
          }),
      },
    });
    try {
      const overview = await engine.loadOverview();
      expect(overview.defaultAgentId).toBe("main");
      expect(overview.agents.map(({ id, isDefault }) => ({ id, isDefault }))).toEqual([
        { id: "main", isDefault: true },
        { id: "work", isDefault: false },
      ]);
    } finally {
      await engine.dispose();
    }
  });

  it("rejects a seeded approval when its binding changes during classification", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = baseConfig as OpenClawConfig;
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      classifyApproval: async () => {
        currentConfig = changedConfig;
        return "approve";
      },
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        runConfigSet,
      },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await expect(engine.handle("yes")).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("rejects a setup write without a verified inference binding", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: null,
      configHashAfter: "after",
      bootstrapPending: false,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/work"],
    }));
    expect(
      () =>
        new RuntimeSystemAgentChatEngine({
          surface: "cli",
          runAgentTurn: async () => null,
          planWithAssistant: async () => null,
          deps: {
            applySetup,
            loadOverview: fakeOverviewLoader(),
          },
        } as unknown as SystemAgentChatEngineOptions),
    ).toThrow(SystemAgentInferenceUnavailableError);
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not expose a custom planner reply after its inference owner drifts", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    const planner = vi.fn(async () => {
      currentConfig = changedConfig;
      return { reply: "stale reply" };
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });

    await expect(engine.handle("what should I do next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
  });

  it("fails closed when neither inference path is usable", async () => {
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => {
        throw new Error("workspace owner openclaw is missing from the roster");
      },
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("please make everything nice")).rejects.toThrow(
      "workspace owner openclaw is missing from the roster",
    );
  });
});
