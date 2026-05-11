import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import {
  maybeCompactAgentHarnessSession,
  runAgentHarnessAttempt,
  selectAgentHarness,
} from "./selection.js";
import type { AgentHarness } from "./types.js";

const piRunAttempt = vi.fn(async () => createAttemptResult("pi"));

vi.mock("./builtin-pi.js", () => ({
  createPiAgentHarness: (): AgentHarness => ({
    id: "pi",
    label: "PI embedded agent",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: piRunAttempt,
  }),
}));

const originalRuntime = process.env.OPENCLAW_AGENT_RUNTIME;

beforeEach(() => {
  clearAgentHarnesses();
});

afterEach(() => {
  clearAgentHarnesses();
  piRunAttempt.mockClear();
  if (originalRuntime == null) {
    delete process.env.OPENCLAW_AGENT_RUNTIME;
  } else {
    process.env.OPENCLAW_AGENT_RUNTIME = originalRuntime;
  }
});

function createAttemptParams(config?: OpenClawConfig): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model<Api>,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
    config,
  } as EmbeddedRunAttemptParams;
}

function createAttemptResult(sessionIdUsed: string): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed,
    messagesSnapshot: [],
    assistantTexts: [`${sessionIdUsed} ok`],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

function registerFailingCodexHarness(): void {
  registerAgentHarness(
    {
      id: "codex",
      label: "Failing Codex",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => {
        throw new Error("codex startup failed");
      }),
    },
    { ownerPluginId: "codex" },
  );
}

function registerSuccessfulCodexHarness(): void {
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "codex" || ctx.provider === "openai"
          ? { supported: true, priority: 100 }
          : { supported: false },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    },
    { ownerPluginId: "codex" },
  );
}

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

function agentModelRuntimeConfig(
  modelRef: string,
  runtime: string,
  agentId?: string,
): OpenClawConfig {
  if (agentId) {
    return {
      agents: {
        list: [
          { id: "main", default: true },
          { id: agentId, models: { [modelRef]: { agentRuntime: { id: runtime } } } },
        ],
      },
    } as OpenClawConfig;
  }
  return {
    agents: {
      defaults: {
        models: {
          [modelRef]: { agentRuntime: { id: runtime } },
        },
      },
    },
  } as OpenClawConfig;
}

describe("runAgentHarnessAttempt", () => {
  it("fails when a forced plugin harness is unavailable and fallback is omitted", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "codex";

    await expect(
      runAgentHarnessAttempt(createAttemptParams(providerRuntimeConfig("codex", "codex"))),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("falls back to the PI harness in auto mode when no plugin harness matches", async () => {
    const result = await runAgentHarnessAttempt(createAttemptParams());

    expect(result.sessionIdUsed).toBe("pi");
    expect(piRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces an auto-selected plugin harness failure instead of replaying through PI", async () => {
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttempt(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("auto-selects a supporting plugin harness by default", async () => {
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttempt(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("surfaces a forced plugin harness failure instead of replaying through PI", async () => {
    registerFailingCodexHarness();

    await expect(
      runAgentHarnessAttempt(createAttemptParams(providerRuntimeConfig("codex", "codex"))),
    ).rejects.toThrow("codex startup failed");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("uses the Codex harness by default for OpenAI agent model runs", async () => {
    registerSuccessfulCodexHarness();

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("codex");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("honors explicit PI runtime for OpenAI agent model runs", async () => {
    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(providerRuntimeConfig("openai", "pi")),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("pi");
    expect(piRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("annotates non-ok harness result classifications for outer model fallback", async () => {
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "empty" as const);
    registerAgentHarness(
      {
        id: "codex",
        label: "Classifying Codex",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt: vi.fn(async () => createAttemptResult("codex")),
        classify,
      },
      { ownerPluginId: "codex" },
    );

    const params = createAttemptParams();
    const result = await runAgentHarnessAttempt(params);

    const classifyCall = classify.mock.calls[0];
    expect(classifyCall?.[0].sessionIdUsed).toBe("codex");
    expect(classifyCall?.[1]).toBe(params);
    expect(result.agentHarnessId).toBe("codex");
    expect(result.agentHarnessResultClassification).toBe("empty");
  });

  it("fails for config-forced plugin harnesses when fallback is omitted", async () => {
    await expect(
      runAgentHarnessAttempt(createAttemptParams(providerRuntimeConfig("codex", "codex"))),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("does not let a strict agent model plugin runtime fall back to PI", async () => {
    await expect(
      runAgentHarnessAttempt({
        ...createAttemptParams(agentModelRuntimeConfig("codex/gpt-5.4", "codex", "strict")),
        sessionKey: "agent:strict:session-1",
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
    expect(piRunAttempt).not.toHaveBeenCalled();
  });
});

describe("selectAgentHarness", () => {
  it("auto-selects plugin support by default", () => {
    const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
    });

    expect(harness.id).toBe("codex");
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it("auto-selects the highest-priority plugin harness without duplicate support probes", () => {
    const lowPrioritySupports = vi.fn(() => ({
      supported: true as const,
      priority: 10,
      reason: "generic codex support",
    }));
    const highPrioritySupports = vi.fn(() => ({
      supported: true as const,
      priority: 100,
      reason: "native codex app-server",
    }));
    const unsupportedSupports = vi.fn(() => ({
      supported: false as const,
      reason: "provider mismatch",
    }));
    registerAgentHarness(
      {
        id: "codex-low",
        label: "Low Codex",
        supports: lowPrioritySupports,
        runAttempt: vi.fn(async () => createAttemptResult("codex-low")),
      },
      { ownerPluginId: "codex-low" },
    );
    registerAgentHarness(
      {
        id: "codex-high",
        label: "High Codex",
        supports: highPrioritySupports,
        runAttempt: vi.fn(async () => createAttemptResult("codex-high")),
      },
      { ownerPluginId: "codex-high" },
    );
    registerAgentHarness(
      {
        id: "other",
        label: "Other Harness",
        supports: unsupportedSupports,
        runAttempt: vi.fn(async () => createAttemptResult("other")),
      },
      { ownerPluginId: "other" },
    );

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
    });

    expect(harness.id).toBe("codex-high");
    expect(lowPrioritySupports).toHaveBeenCalledTimes(1);
    expect(highPrioritySupports).toHaveBeenCalledTimes(1);
    expect(unsupportedSupports).toHaveBeenCalledTimes(1);
  });

  it("ignores session-level PI pins when selecting a harness", () => {
    const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
      agentHarnessId: "pi",
    });

    expect(harness.id).toBe("codex");
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it("allows per-agent model runtime policy overrides", () => {
    const config = agentModelRuntimeConfig("anthropic/sonnet-4.6", "codex", "strict");

    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
        sessionKey: "agent:strict:session-1",
      }),
    ).toThrow('Requested agent harness "codex" is not registered');
    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6", config }).id).toBe(
      "pi",
    );
  });

  it("ignores legacy agentRuntime as a runtime policy source", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "codex" },
        },
      },
    } as OpenClawConfig;

    expect(
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
      }).id,
    ).toBe("pi");
  });

  it("ignores legacy agent CLI runtime aliases for OpenAI agent model runs", async () => {
    registerSuccessfulCodexHarness();
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4", config }).id).toBe("codex");

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(config),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("codex");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("ignores existing session PI pins when provider policy forces a plugin harness", () => {
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        agentHarnessId: "pi",
        config: providerRuntimeConfig("codex", "codex"),
      }).id,
    ).toBe("codex");
  });

  it("ignores env-forced PI for OpenAI default runtime selection", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "pi";
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.4",
        agentHarnessId: "codex",
      }).id,
    ).toBe("codex");
  });

  it("does not compact a plugin-pinned session through PI when the plugin has no compactor", async () => {
    registerFailingCodexHarness();

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessId: "codex",
      }),
    ).resolves.toEqual({
      ok: false,
      compacted: false,
      reason: 'Agent harness "codex" does not support compaction.',
    });
  });
});
