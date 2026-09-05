import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { SystemAgentSession } from "./agent-turn.js";
import type { SystemAgentTurnDeps } from "./agent-turn.test-support.js";
import {
  fakeOverviewLoader,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  RuntimeSystemAgentChatEngine,
  SystemAgentInferenceUnavailableError,
  runSystemAgentTurnWithDeps,
  type OpenClawConfig,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.test-support.js";
import { loadSystemAgentOverview } from "./overview.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";

describe("SystemAgentChatEngine facade", () => {
  it("ends a partial timed-out agent turn without starting a second planner inference", async () => {
    useTempStateDir();
    const config: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.6-luna" } },
    };
    const inference = await createSystemAgentVerifiedInferenceTestFixture(config);
    const planner = vi
      .spyOn(await import("./assistant.js"), "planSystemAgentCommand")
      .mockResolvedValue({ reply: "A second inference ran." });
    const runEmbeddedAgent = vi
      .fn<NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]>>()
      .mockResolvedValueOnce({
        meta: {
          durationMs: 120_000,
          finalAssistantVisibleText: "I'll begin checking your setup.",
          aborted: true,
          timeoutPhase: "provider",
          error: { kind: "incomplete_turn", message: "The setup turn timed out." },
        },
      })
      .mockResolvedValue({ meta: { durationMs: 1, finalAssistantVisibleText: "Ready to retry." } });
    let failedSession: SystemAgentSession | undefined;
    const engine = new SystemAgentChatEngine({
      verifiedInference: inference.binding,
      runAgentTurn: (params) => {
        failedSession = params.session;
        params.session.proposalRef.current = "unfinished-proposal";
        params.session.proposalRef.operation = { kind: "setup" };
        params.session.cliSession = { routeKey: "old", binding: { sessionId: "old" } };
        return runSystemAgentTurnWithDeps(params, {
          ...inference.deps,
          readConfigFileSnapshot: async () => configSnapshot(config),
          runEmbeddedAgent: runEmbeddedAgent as never,
        });
      },
      deps: {
        ...inference.deps,
        readConfigFileSnapshot: async () => configSnapshot(config),
        loadOverview: fakeOverviewLoader(),
      },
    });
    try {
      await expect(engine.handle("What is the next setup step?")).rejects.toMatchObject({
        code: "SYSTEM_AGENT_INFERENCE_UNAVAILABLE",
        message: expect.stringContaining("The setup turn timed out."),
      });
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(planner).not.toHaveBeenCalled();
      expect(engine.getPendingOperatorProposal()).toBeNull();
      expect(failedSession?.cliSession).toBeUndefined();
      expect(engine.historyLength()).toBe(0);
      await expect(engine.handle("Try the next step again.")).resolves.toMatchObject({
        text: "Ready to retry.",
      });
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      expect(planner).not.toHaveBeenCalled();
    } finally {
      planner.mockRestore();
      await engine.dispose();
    }
  });

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
          deps: {
            applySetup,
            loadOverview: fakeOverviewLoader(),
          },
        } as unknown as SystemAgentChatEngineOptions),
    ).toThrow(SystemAgentInferenceUnavailableError);
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not expose an agent reply after its inference owner drifts", async () => {
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
    const runAgentTurn = vi.fn(async () => {
      currentConfig = changedConfig;
      return { text: "stale reply" };
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });

    await expect(engine.handle("what should I do next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
  });

  it("preserves the inference failure without a second model attempt", async () => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => {
        throw new Error("workspace owner openclaw is missing from the roster");
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("please make everything nice")).rejects.toThrow(
      "workspace owner openclaw is missing from the roster",
    );
  });
});
