// Payload fallback tests cover fallback prompt payloads for isolated cron runs.
import { describe, expect, it, vi } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveAgentConfigMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  resolveAgentModelFallbacksOverrideMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireModelFallbackRequest(): {
  fallbacksOverride?: string[];
  provider?: string;
  model?: string;
} {
  const request = runWithModelFallbackMock.mock.calls[0]?.[0] as
    | {
        fallbacksOverride?: string[];
        provider?: string;
        model?: string;
      }
    | undefined;
  if (!request) {
    throw new Error("Expected model fallback request");
  }
  return request;
}
describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("uses the persisted agentTurn payload message when the dispatch message is malformed", async () => {
    mockRunCronFallbackPassthrough();
    const dispatchMessage = "SERIALIZATION_PROBE should not be wrapped";

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message:
              "SERIALIZATION_PROBE: reply exactly with the marker token you received and nothing else.",
          },
        }),
        message: { message: dispatchMessage } as unknown as string,
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const request = runEmbeddedAgentMock.mock.calls[0]?.[0] as { prompt?: unknown } | undefined;
    expect(request?.prompt).toContain("SERIALIZATION_PROBE: reply exactly");
    expect(request?.prompt).not.toContain(dispatchMessage);
    expect(request?.prompt).not.toContain("[object Object]");
  });

  it.each([
    {
      name: "passes payload.fallbacks as fallbacksOverride when defined",
      payload: {
        kind: "agentTurn",
        message: "test",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
      },
      expectedFallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
    },
    {
      name: "falls back to agent-level fallbacks when payload.fallbacks is undefined",
      payload: { kind: "agentTurn", message: "test" },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: ["openai/gpt-4o"],
    },
    {
      name: "payload.fallbacks=[] disables fallbacks even when agent config has them",
      payload: { kind: "agentTurn", message: "test", fallbacks: [] },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: [],
    },
  ])("$name", async ({ payload, agentFallbacks, expectedFallbacks }) => {
    if (agentFallbacks) {
      resolveAgentModelFallbacksOverrideMock.mockReturnValue(agentFallbacks);
    }

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual(expectedFallbacks);
  });

  it("keeps pre-envelope app-less default caps free of recovery prompt changes", async () => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
          payload: {
            kind: "agentTurn",
            message: "use calendar",
            toolsAllow: ["read", "cron"],
            toolsAllowIsDefault: true,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledRuntimeAuthorityRecoveryRequired: false }),
    );
  });

  it("forwards reauthorization recovery after an explicit tools cap clears app authority", async () => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthorityRecoveryRequired: true,
          payload: { kind: "agentTurn", message: "use calendar", toolsAllow: ["read"] },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledRuntimeAuthorityRecoveryRequired: true }),
    );
  });

  it("marks only later candidates in one prompt as fallback runners", async () => {
    const onExecutionStarted = vi.fn();
    const onExecutionPhase = vi.fn();
    runEmbeddedAgentMock.mockImplementation(async (request) => {
      request.onExecutionStarted?.();
      request.onExecutionPhase?.({ phase: "runtime_plugins" });
      return {
        payloads: [{ text: "fallback ok" }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5", "unknown");
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ onExecutionStarted, onExecutionPhase }),
    );

    expect(result.status).toBe("ok");
    expect(onExecutionStarted).toHaveBeenCalledTimes(2);
    expect(onExecutionStarted.mock.calls.map(([info]) => info)).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.4" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5", isFallback: true }),
    ]);
    expect(onExecutionPhase.mock.calls.map(([info]) => info)).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.4" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5" }),
    ]);
  });

  it("plans Anthropic fallbacks canonically while executing compatible attempts through Claude CLI", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    runCliAgentMock.mockImplementation(async (request) => {
      request.userTurnTranscriptRecorder?.markBlocked();
      return {
        payloads: [{ text: "fallback ok" }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      const firstResult = await runInitialModelFallbackAttempt(params);
      const secondResult = await runFallbackModelAttempt(
        params,
        "anthropic",
        "claude-sonnet-4-6",
        "unknown",
      );
      return {
        result: secondResult ?? firstResult,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["anthropic/claude-sonnet-4-6"],
              },
              models: {
                "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    const fallbackRequest = requireModelFallbackRequest();
    expect(fallbackRequest.provider).toBe("anthropic");
    expect(fallbackRequest.model).toBe("claude-opus-4-6");
    expect(
      runCliAgentMock.mock.calls.map((call) => [
        call[0].provider,
        call[0].modelProvider,
        call[0].model,
      ]),
    ).toEqual([
      ["claude-cli", "anthropic", "claude-opus-4-6"],
      ["claude-cli", "anthropic", "claude-sonnet-4-6"],
    ]);
    const firstCliRequest = runCliAgentMock.mock.calls[0]?.[0];
    const secondCliRequest = runCliAgentMock.mock.calls[1]?.[0];
    expect(firstCliRequest?.userTurnTranscriptRecorder).toBeDefined();
    expect(secondCliRequest?.userTurnTranscriptRecorder).toBe(
      firstCliRequest?.userTurnTranscriptRecorder,
    );
    expect(firstCliRequest?.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCliRequest?.suppressNextUserMessagePersistence).toBe(true);
  });

  it.each([
    { name: "a different embedded runtime", runtime: "openclaw", cli: false },
    { name: "a CLI execution path", runtime: "codex", cli: true },
  ])("fails closed before executing stored Codex authority on $name", async ({ runtime, cli }) => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue(runtime);
    isCliProviderMock.mockReturnValue(cli);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("does not persist an authority-incompatible fallback on the run continuation", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ provider }: { provider: string }) =>
      provider === "openai" ? "codex" : "openclaw",
    );
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("primary failed"));
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow("primary failed");
      return await runFallbackModelAttempt(params, "anthropic", "claude-sonnet-4-6", "unknown");
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    const persistedRunRows = await Promise.all(
      patchSessionEntryMock.mock.calls.flatMap((call, index) => {
        const scope = call[0] as { sessionKey?: string };
        const callResult = patchSessionEntryMock.mock.results[index];
        return scope.sessionKey?.includes(":run:") && callResult?.type === "return"
          ? [callResult.value]
          : [];
      }),
    );
    expect(persistedRunRows).not.toHaveLength(0);
    for (const persistedRunRow of persistedRunRows) {
      expect(persistedRunRow).toEqual(
        expect.objectContaining({ modelProvider: "openai", model: "gpt-5.4" }),
      );
    }
  });

  it("forwards subagent fallbacks into the embedded runner for internal failover decisions", async () => {
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.2", "zai/glm-5"],
                },
              },
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual([
      "openai/gpt-5.2",
      "zai/glm-5",
    ]);
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.2", "zai/glm-5"],
    });
  });

  it("uses default subagent fallbacks ahead of a named agent's primary through the run path", async () => {
    mockRunCronFallbackPassthrough();
    resolveAgentConfigMock.mockReturnValue({
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4"],
      },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "research",
        cfg: {
          agents: {
            defaults: {
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.2", "zai/glm-5"],
                },
              },
            },
            list: [
              {
                id: "research",
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["openai/gpt-5.4"],
                },
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual([
      "openai/gpt-5.2",
      "zai/glm-5",
    ]);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.2", "zai/glm-5"],
    });
  });
});
