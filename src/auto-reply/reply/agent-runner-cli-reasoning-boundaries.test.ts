import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { runCliAgentWithLifecycle as runCliAgentWithLifecycleProduction } from "./agent-runner-cli-dispatch.js";

type ProductionLifecycleParams = Parameters<typeof runCliAgentWithLifecycleProduction>[0];
type LifecycleParams = Omit<ProductionLifecycleParams, "runParams"> & {
  runParams: Omit<ProductionLifecycleParams["runParams"], "admittedRunContext">;
};

const cliDispatchState = vi.hoisted(() => ({ runCliAgentMock: vi.fn() }));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));

const runCliAgentWithLifecycle = (params: LifecycleParams) =>
  runCliAgentWithLifecycleProduction({
    ...params,
    runParams: withTestAdmittedRunContext(params.runParams),
  });

function createRunParams(runId: string): LifecycleParams["runParams"] {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    provider: "claude-cli",
    model: "claude",
    thinkLevel: "high",
    timeoutMs: 1_000,
    runId,
  };
}

afterEach(() => {
  resetAgentEventsForTest();
  cliDispatchState.runCliAgentMock.mockReset();
});

describe("runCliAgentWithLifecycle reasoning boundaries", () => {
  it("closes reasoning before commentary delivery", async () => {
    const runId = "run-reasoning-commentary-boundary";
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      emitAgentEvent({
        runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId,
        stream: "item",
        data: { kind: "preamble", itemId: "commentary-1", progressText: "Checking files" },
      });
      return { payloads: [{ text: "Visible answer" }], meta: { durationMs: 1 } };
    });
    const callbackOrder: string[] = [];

    await runCliAgentWithLifecycle({
      runId,
      provider: "claude-cli",
      onReasoningText: async () => {
        callbackOrder.push("reasoning");
      },
      onReasoningEnd: async () => {
        callbackOrder.push("reasoning:end");
      },
      onCommentaryText: async () => {
        callbackOrder.push("commentary");
      },
      preserveProgressCallbackStartOrder: true,
      runParams: createRunParams(runId),
    });

    expect(callbackOrder).toEqual(["reasoning", "reasoning:end", "commentary"]);
  });

  it("closes reasoning before reporting a CLI error", async () => {
    const runId = "run-reasoning-error-boundary";
    const failure = new Error("CLI failed after reasoning");
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      emitAgentEvent({
        runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true },
      });
      throw failure;
    });
    const callbackOrder: string[] = [];

    await expect(
      runCliAgentWithLifecycle({
        runId,
        provider: "claude-cli",
        onReasoningText: async () => {
          callbackOrder.push("reasoning");
        },
        onReasoningEnd: async () => {
          callbackOrder.push("reasoning:end");
        },
        onErrorBeforeLifecycle: async () => {
          callbackOrder.push("error");
        },
        preserveProgressCallbackStartOrder: true,
        runParams: createRunParams(runId),
      }),
    ).rejects.toBe(failure);

    expect(callbackOrder).toEqual(["reasoning", "reasoning:end", "error"]);
  });
});
