/** Tests caller-boundary settlement for interrupted CLI turns with partial output. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";

const { executePreparedCliRunMock } = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

const getGlobalHookRunnerMock = vi.mocked(getGlobalHookRunner);

describe("runPreparedCliAgent interrupted partial output", () => {
  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    getGlobalHookRunnerMock.mockReset();
  });

  it.each([
    {
      reason: "aborted" as const,
      expectedMeta: { stopReason: "aborted" },
    },
    {
      reason: "timeout" as const,
      expectedMeta: { stopReason: "timeout", timeoutPhase: "provider" },
    },
  ])(
    "retains partial text while settling $reason as non-success",
    async ({ reason, expectedMeta }) => {
      const onSuccessfulAuthBinding = vi.fn();
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
        runAgentEnd: vi.fn(async (_event: { messages?: unknown[] }) => undefined),
      };
      getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);
      executePreparedCliRunMock.mockResolvedValue({
        text: "partial answer",
        rawText: "partial answer",
        sessionId: "interrupted-native-session",
        terminalInterruption: { reason },
      });
      const context = buildPreparedCliRunContext({ onSuccessfulAuthBinding });

      const result = await runPreparedCliAgent(context);

      expect(result.payloads).toEqual([{ text: "partial answer" }]);
      expect(result.meta).toMatchObject({
        aborted: true,
        providerStarted: true,
        ...expectedMeta,
        completion: {
          finishReason: reason,
          stopReason: reason,
          refusal: false,
        },
        executionTrace: {
          attempts: [
            {
              provider: "claude-cli",
              model: "sonnet",
              result: reason,
              reason: `CLI turn ${reason} after partial output`,
            },
          ],
        },
        agentMeta: {
          sessionId: "",
          clearCliSessionBinding: true,
        },
      });
      expect(onSuccessfulAuthBinding).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledOnce();
      const agentEndEvent = hookRunner.runAgentEnd.mock.calls[0]?.[0];
      expect(agentEndEvent).toMatchObject({
        success: false,
        error: `CLI turn ${reason} after partial output`,
      });
      expect(agentEndEvent?.messages).toEqual([
        expect.objectContaining({ role: "user", content: "hi" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "partial answer" }],
          stopReason: "aborted",
        }),
      ]);
    },
  );
});
