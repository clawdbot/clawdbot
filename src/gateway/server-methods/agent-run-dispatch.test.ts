import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";

const agentCommandFromIngress = vi.hoisted(() => vi.fn());

vi.mock("../../commands/agent.js", () => ({ agentCommandFromIngress }));

describe("dispatchAgentRunFromGateway", () => {
  it("runs the timeout handoff only after session admission cleanup", async () => {
    const order: string[] = [];
    const cleanedUp = createDeferred<void>();
    agentCommandFromIngress.mockResolvedValueOnce({
      meta: { aborted: true, stopReason: "timeout" },
    });

    dispatchAgentRunFromGateway({
      abortController: new AbortController(),
      cleanupAbortController: () => {
        order.push("cleanup");
      },
      context: {
        dedupe: new Map(),
        deps: {},
        logGateway: { warn: vi.fn() },
      } as never,
      dedupeKeys: ["agent:timed-out-run"],
      ingressOpts: { lifecycleGeneration: "generation-1" } as never,
      onCleanup: () => {
        order.push("handoff");
        cleanedUp.resolve();
      },
      onSettled: () => {
        order.push("settled");
        return true;
      },
      respond: vi.fn(),
      runId: "timed-out-run",
      taskTrackingMode: "none",
    });

    await cleanedUp.promise;

    expect(order).toEqual(["settled", "cleanup", "handoff"]);
  });
});
