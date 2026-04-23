import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import {
  maybeCompactAgentHarnessSession,
  runAgentHarnessAttemptWithFallback,
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
const originalHarnessFallback = process.env.OPENCLAW_AGENT_HARNESS_FALLBACK;

afterEach(() => {
  clearAgentHarnesses();
  piRunAttempt.mockClear();
  if (originalRuntime == null) {
    delete process.env.OPENCLAW_AGENT_RUNTIME;
  } else {
    process.env.OPENCLAW_AGENT_RUNTIME = originalRuntime;
  }
  if (originalHarnessFallback == null) {
    delete process.env.OPENCLAW_AGENT_HARNESS_FALLBACK;
  } else {
    process.env.OPENCLAW_AGENT_HARNESS_FALLBACK = originalHarnessFallback;
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

describe("runAgentHarnessAttemptWithFallback", () => {
  it("falls back to the PI harness when a forced plugin harness is unavailable", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "codex";

    const result = await runAgentHarnessAttemptWithFallback(createAttemptParams());

    expect(result.sessionIdUsed).toBe("pi");
    expect(piRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("falls back to the PI harness in auto mode when no plugin harness matches", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";

    const result = await runAgentHarnessAttemptWithFallback(createAttemptParams());

    expect(result.sessionIdUsed).toBe("pi");
    expect(piRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces an auto-selected plugin harness failure instead of replaying through PI", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttemptWithFallback(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("surfaces a forced plugin harness failure instead of replaying through PI", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "codex";
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttemptWithFallback(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("honors env fallback override over config fallback", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
    process.env.OPENCLAW_AGENT_HARNESS_FALLBACK = "none";

    await expect(
      runAgentHarnessAttemptWithFallback(
        createAttemptParams({ agents: { defaults: { embeddedHarness: { fallback: "pi" } } } }),
      ),
    ).rejects.toThrow("PI fallback is disabled");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });
});

describe("selectAgentHarness", () => {
  it("auto-selects the highest-priority plugin harness without duplicate support probes", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
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

  it("keeps pinned PI selection from probing plugin support", () => {
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

    expect(harness.id).toBe("pi");
    expect(supports).not.toHaveBeenCalled();
  });

  it("fails instead of choosing PI when no plugin harness matches and fallback is none", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config: { agents: { defaults: { embeddedHarness: { fallback: "none" } } } },
      }),
    ).toThrow("PI fallback is disabled");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("allows per-agent embedded harness policy overrides", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { embeddedHarness: { fallback: "pi" } },
        list: [
          { id: "main", default: true },
          { id: "strict", embeddedHarness: { fallback: "none" } },
        ],
      },
    };

    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
        sessionKey: "agent:strict:session-1",
      }),
    ).toThrow("PI fallback is disabled");
    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6", config }).id).toBe(
      "pi",
    );
  });

  it("keeps an existing session pinned to PI even when config now forces a plugin harness", () => {
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        agentHarnessId: "pi",
        config: { agents: { defaults: { embeddedHarness: { runtime: "codex" } } } },
      }).id,
    ).toBe("pi");
  });

  it("keeps an existing session pinned to its plugin harness even when env now forces PI", () => {
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
