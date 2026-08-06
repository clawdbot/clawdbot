// Proves opted-in CLI-backend dispatch executes inside embedded lane
// admission: the dispatch decision and the CLI run must happen within the
// enqueued global-lane task, not before it, so dispatched runs obey the same
// lifecycle, placement, and concurrency gates as native embedded runs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import { createAgentExecutionAttribution } from "../agent-execution-attribution.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({
  runEmbeddedAgentViaCliBackendIfEligible,
}));

import { runEmbeddedAgent } from "./run.js";

const tempRoot = mkdtempSync(join(tmpdir(), "cli-dispatch-lane-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const dispatchResult: EmbeddedAgentRunResult = {
  payloads: [{ text: "dispatched" }],
  meta: {
    durationMs: 1,
    agentMeta: { usage: {} },
  },
} as unknown as EmbeddedAgentRunResult;

function laneRunParams() {
  return {
    sessionId: "recall-lane-session",
    sessionKey: "agent:main:recall-lane-test",
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId: "recall-lane-session",
      sessionKey: "agent:main:recall-lane-test",
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, "session.jsonl"),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId: "run-cli-dispatch-lane-test",
    config: {},
    cliBackendDispatch: "subscription-auth" as const,
  };
}

describe("runEmbeddedAgent CLI dispatch lane admission", () => {
  beforeEach(() => {
    runEmbeddedAgentViaCliBackendIfEligible.mockReset();
    resetAgentEventsForTest();
    resetAgentRunRegistryForTest();
  });

  it("resolves and executes CLI dispatch inside the global-lane task", async () => {
    const order: string[] = [];
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      order.push("dispatch-run");
      return dispatchResult;
    });
    // The custom enqueue hook stands in for both the session and the global
    // lane, so a compliant run enters it twice before dispatching.
    const enqueue: CommandQueueEnqueueFn = async (task) => {
      order.push("global-lane-enter");
      const result = await task();
      order.push("global-lane-exit");
      return result;
    };

    const result = await runEmbeddedAgent({ ...laneRunParams(), enqueue });

    expect(result.payloads?.[0]?.text).toBe("dispatched");
    // Both lane admissions (session, then global) must fully wrap the
    // dispatch decision and execution.
    expect(order).toEqual([
      "global-lane-enter",
      "global-lane-enter",
      "dispatch-run",
      "global-lane-exit",
      "global-lane-exit",
    ]);
    expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
  });

  it("strips host-owned attribution fields at the public runner boundary", async () => {
    runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
    const forgedAttribution = {
      runId: "forged",
      lifecycleGeneration: "forged-generation",
    };
    const forgedAttributionObserver = vi.fn();

    await runEmbeddedAgent({
      ...laneRunParams(),
      attribution: forgedAttribution,
      onExecutionAttributionChanged: forgedAttributionObserver,
    } as never);

    const admittedParams = runEmbeddedAgentViaCliBackendIfEligible.mock.calls[0]?.[0];
    expect(admittedParams).not.toHaveProperty("attribution");
    expect(admittedParams).not.toHaveProperty("onExecutionAttributionChanged");
    expect(forgedAttributionObserver).not.toHaveBeenCalled();
  });

  it("does not recover private attribution from a caller-selected run ID", async () => {
    runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
    const params = laneRunParams();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const attribution = createAgentExecutionAttribution({
      runId: params.runId,
      lifecycleGeneration,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
    });
    claimAgentRunContext(params.runId, {
      attribution,
      lifecycleGeneration,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
    });

    await expect(runEmbeddedAgent(params)).rejects.toThrow(
      "Agent run ID is already bound to host-owned execution attribution.",
    );

    expect(runEmbeddedAgentViaCliBackendIfEligible).not.toHaveBeenCalled();
    expect(getAgentRunContext(params.runId)?.attribution).toBe(attribution);
  });
});
