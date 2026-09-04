// Real Gateway transport proof for the cron descendant follow-up budget.
vi.hoisted(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../src/agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import { waitForDescendantSubagentSummary } from "../src/cron/isolated-agent/subagent-followup.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
});

describe("cron descendant follow-up Gateway transport", () => {
  it(
    "keeps the bounded follow-up on one monotonic budget after a wall-clock step",
    { timeout: 120_000 },
    async () => {
      const instance = await createOpenClawTestInstance({
        name: "cron-descendant-followup-gateway",
      });
      instances.push(instance);
      await instance.startGateway();
      instance.state.applyEnv();

      const runId = randomUUID();
      const sessionKey = "agent:main:cron:gateway-proof";
      const now = Date.now();
      const run: SubagentRunRecord = {
        runId,
        childSessionKey: "agent:main:subagent:gateway-proof",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: sessionKey,
        task: "gateway transport proof",
        cleanup: "keep",
        createdAt: now,
        execution: { status: "running", startedAt: now },
      };
      subagentRuns.set(runId, run);

      const realDateNow = Date.now.bind(Date);
      let dateSamples = 0;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
        dateSamples += 1;
        const current = realDateNow();
        return dateSamples <= 2 ? current : current - 60_000;
      });

      try {
        const startedAt = performance.now();
        const result = await waitForDescendantSubagentSummary({
          sessionKey,
          initialReply: "on it",
          timeoutMs: 1,
          observedActiveDescendants: true,
        });
        const elapsedMs = performance.now() - startedAt;

        console.log(
          `REAL_GATEWAY_DESCENDANT_BUDGET_PROOF ${JSON.stringify({
            transport: "local-gateway",
            rpc: ["agent.wait", "chat.history"],
            result: result ?? null,
            wallClockStepMs: 60_000,
            elapsedMs: Math.round(elapsedMs),
          })}`,
        );
        expect(result).toBeUndefined();
      } finally {
        dateNow.mockRestore();
        subagentRuns.delete(runId);
        instance.state.restoreEnv();
      }
    },
  );
});
