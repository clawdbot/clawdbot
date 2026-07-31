// Cron runtime model thinking tests cover live metadata hydration for payload overrides.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  isThinkingLevelSupportedMock,
  loadModelCatalogMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveThinkingDefaultMock,
  resolveSupportedThinkingLevelMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function firstMockArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const value = mock.mock.calls[0]?.[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

describe("runCronIsolatedAgentTurn runtime model thinking", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: true,
      }),
    );
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("hydrates live catalog metadata for a runtime-only cron model override", async () => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "ollama", model: "minimax-m3:cloud" },
    });
    loadModelCatalogMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        provider: "OLLAMA",
        id: "minimax-m3:cloud",
        name: "minimax-m3:cloud",
        reasoning: true,
      },
    ]);
    isThinkingLevelSupportedMock.mockImplementation(
      ({ catalog, level }: { catalog?: Array<{ reasoning?: boolean }>; level?: string }) =>
        level === "off" || catalog?.some((entry) => entry.reasoning === true) === true,
    );
    resolveSupportedThinkingLevelMock.mockReturnValue("off");
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));

    await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            models: {
              "ollama/*": {},
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "runtime-thinking-job",
        name: "Runtime Thinking Test",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "summarize",
          model: "ollama/minimax-m3:cloud",
          thinking: "medium",
        },
      } as never,
      message: "summarize",
      sessionKey: "cron:runtime-thinking",
    });

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(2);
    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("minimax-m3:cloud");
    expect(embeddedCall.thinkLevel).toBe("medium");
    const thinkingCall = firstMockArg(isThinkingLevelSupportedMock);
    expect(thinkingCall.catalog).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "minimax-m3:cloud",
        reasoning: true,
      }),
    ]);
  });

  it("does not hydrate live catalog metadata when thinking is explicitly off", async () => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "ollama", model: "minimax-m3:cloud" },
    });
    loadModelCatalogMock.mockResolvedValue([]);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));

    await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            models: {
              "ollama/*": {},
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "runtime-thinking-off-job",
        name: "Runtime Thinking Off Test",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "summarize",
          model: "ollama/minimax-m3:cloud",
          thinking: "off",
        },
      } as never,
      message: "summarize",
      sessionKey: "cron:runtime-thinking-off",
    });

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(1);
    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("minimax-m3:cloud");
    expect(embeddedCall.thinkLevel).toBe("off");
  });

  it.each([
    {
      name: "agent default",
      defaults: {
        thinkingDefault: "off" as const,
        models: { "ollama/*": {} },
      },
    },
    {
      name: "model default",
      defaults: {
        models: {
          "ollama/minimax-m3:cloud": {
            params: { thinking: "off" as const },
          },
        },
      },
    },
  ])("does not hydrate live catalog metadata when the $name is off", async ({ defaults }) => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "ollama", model: "minimax-m3:cloud" },
    });
    loadModelCatalogMock.mockResolvedValue([]);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));

    await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults,
        },
      },
      deps: {} as never,
      job: {
        id: "configured-thinking-off-job",
        name: "Configured Thinking Off Test",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "summarize",
          model: "ollama/minimax-m3:cloud",
        },
      } as never,
      message: "summarize",
      sessionKey: "cron:configured-thinking-off",
    });

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(resolveThinkingDefaultMock).not.toHaveBeenCalled();
    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("minimax-m3:cloud");
    expect(embeddedCall.thinkLevel).toBe("off");
  });
});
