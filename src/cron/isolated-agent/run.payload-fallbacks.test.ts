import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  resolveConfiguredModelRefMock,
  resolveAgentModelFallbacksOverrideMock,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireModelFallbackRequest(): {
  fallbacksOverride?: string[];
  provider?: string;
  model?: string;
} {
  const request = runWithModelFallbackMock.mock.calls.at(0)?.[0] as
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
  setupRunCronIsolatedAgentTurnSuite();

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
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual(expectedFallbacks);
  });

  it("plans Anthropic fallbacks canonically while executing compatible attempts through Claude CLI", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "fallback ok" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const firstResult = await run(provider, model);
      const secondResult = await run("anthropic", "claude-sonnet-4-6");
      return {
        result: secondResult ?? firstResult,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
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
    expect(runCliAgentMock.mock.calls.map((call) => [call[0].provider, call[0].model])).toEqual([
      ["claude-cli", "claude-opus-4-6"],
      ["claude-cli", "claude-sonnet-4-6"],
    ]);
  });
});
