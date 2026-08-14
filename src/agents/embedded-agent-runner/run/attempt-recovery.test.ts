import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { normalizeUsage } from "../../usage.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

describe("recoverEmbeddedRunAttempt", () => {
  it("surfaces before_agent_run blocks with current carried usage", async () => {
    const historicalAssistant = buildEmbeddedRunnerAssistant({
      usage: createMockUsage(128_814, 3_000),
    });
    const carriedUsage = normalizeUsage(createMockUsage(42_000, 1_000));
    if (!carriedUsage) {
      throw new Error("expected normalized usage fixture");
    }
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "hook:before_agent_run",
        error: new Error("Blocked by before-run policy."),
      },
      lastAssistant: historicalAssistant,
      currentAttemptAssistant: undefined,
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: historicalAssistant,
    });
    const setTerminalLifecycleMeta = vi.fn();

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          sessionId: "session:hook-block",
          runId: "run:hook-block",
        },
        resolvedSessionKey: "agent:main:hook-block",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: { id: "gpt-5.6-luna" },
        genericCompactionRecoveryAllowed: false,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: historicalAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: carriedUsage,
    } as never);

    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
    });
    expect(recovery).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: "Blocked by before-run policy.", isError: true }],
        meta: {
          finalAssistantVisibleText: "Blocked by before-run policy.",
          finalAssistantRawText: "Blocked by before-run policy.",
          error: {
            kind: "hook_block",
            message: "Blocked by before-run policy.",
          },
          livenessState: "blocked",
          agentMeta: {
            lastCallUsage: { input: 42_000, output: 1_000, total: 43_000 },
            promptTokens: 42_000,
          },
        },
      },
    });
  });
});
