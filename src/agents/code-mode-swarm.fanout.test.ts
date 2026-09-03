import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import { resolveCodeModeConfig } from "./code-mode.js";
import { resetCodeModeTestState, testing } from "./code-mode.test-support.js";

afterEach(resetCodeModeTestState);

describe("Swarm pipeline backpressure", () => {
  it.each([
    { limit: 1, count: 3, partial: false },
    { limit: 2, count: 6, partial: false },
    { limit: 16, count: 20, partial: false },
    { limit: 3, count: 6, partial: true },
  ])(
    "accounts for $count items with $limit slots and partial settlement $partial",
    async ({ limit, count, partial }) => {
      const config = resolveCodeModeConfig({
        tools: { codeMode: { enabled: true, maxPendingToolCalls: limit } },
      });
      const source = `
      const outcomes = await Promise.allSettled(Array.from({ length: ${count} }, async (_, index) => {
        const next = await agents.run("first-" + index, { phase: "First" });
        return await agents.run(next, { phase: "Second" });
      }));
      return outcomes.map(outcome => outcome.status === "fulfilled"
        ? { status: outcome.status, value: outcome.value }
        : { status: outcome.status, error: outcome.reason.message });
    `;
      let result: CodeModeWorkerResult = await testing.runCodeModeWorker(
        {
          kind: "exec",
          source,
          config,
          catalog: [],
          apiFiles: [],
          namespaces: [],
          swarmEnabled: true,
        },
        10_000,
      );
      const collectors = new Map<string, string>();
      const spawnedPrompts: string[] = [];
      // Drive real worker snapshots with controlled child results; this tests request
      // admission and resumption, not a mock of the guest's Promise implementation.
      for (let round = 0; result.status === "waiting" && round < count * 6; round++) {
        expect(result.pendingRequests.length).toBeGreaterThan(0);
        expect(result.pendingRequests.length).toBeLessThanOrEqual(limit);
        const frontier = partial ? result.pendingRequests.slice(-1) : result.pendingRequests;
        const pendingRequests = partial ? result.pendingRequests.slice(0, -1) : [];
        const settledRequests = frontier.map((request) => {
          let value: unknown;
          if (request.method === "swarmNote") {
            value = { ok: true };
          } else if (request.method === "agentSpawn") {
            const prompt = request.args[0];
            if (typeof prompt !== "string") {
              throw new Error("expected a collector prompt");
            }
            const runId = `collector-${collectors.size}`;
            collectors.set(runId, prompt);
            spawnedPrompts.push(prompt);
            value = { status: "accepted", runId };
          } else {
            expect(request.method).toBe("agentWait");
            const runId = request.args[0];
            const prompt = typeof runId === "string" ? collectors.get(runId) : undefined;
            if (!prompt) {
              throw new Error("wait must reference an accepted collector");
            }
            const nextStage = prompt.startsWith("first-")
              ? prompt.replace("first-", "second-")
              : prompt.replace("second-", "done-");
            value =
              prompt === "first-1"
                ? { runId, status: "failed", error: "child intentionally failed" }
                : { runId, status: "done", result: nextStage };
          }
          return { id: request.id, ok: true as const, value };
        });
        result = await testing.runCodeModeWorker(
          { kind: "resume", snapshot: result.snapshot, config, settledRequests, pendingRequests },
          10_000,
        );
      }
      expect(result.status, result.status === "failed" ? result.error : undefined).toBe(
        "completed",
      );
      if (result.status !== "completed") {
        throw new Error("pipeline must complete");
      }
      expect(result.value.kind).toBe("complete");
      expect(JSON.parse(result.value.json)).toEqual(
        Array.from({ length: count }, (_, index) =>
          index === 1
            ? { status: "rejected", error: expect.stringContaining("child intentionally failed") }
            : { status: "fulfilled", value: `done-${index}` },
        ),
      );
      expect(spawnedPrompts).toHaveLength(count * 2 - 1);
      expect(new Set(spawnedPrompts).size).toBe(spawnedPrompts.length);
    },
  );

  it("releases a canceled timer slot without changing queued collector arguments", async () => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 1 } },
    });
    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: `
          const timer = setTimeout(() => { throw new Error("canceled timer fired"); }, 60_000);
          const options = { label: "original" };
          const collector = agents.run("Queued research", options);
          options.label = "changed";
          clearTimeout(timer);
          return await collector;
        `,
        config,
        catalog: [],
        swarmEnabled: true,
      },
      10_000,
    );
    expect(result).toMatchObject({
      status: "waiting",
      canceledRequestIds: ["bridge:sleep:1"],
      pendingRequests: [
        {
          id: "bridge:agentSpawn:1",
          method: "agentSpawn",
          args: ["Queued research", { label: "original" }],
        },
      ],
    });
  });
});
