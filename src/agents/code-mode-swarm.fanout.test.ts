import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import { resolveCodeModeConfig } from "./code-mode.js";
import { resetCodeModeTestState, testing } from "./code-mode.test-support.js";

afterEach(resetCodeModeTestState);

describe("Swarm pipeline backpressure", () => {
  it.each([
    { limit: 1, count: 3, partial: false, followup: false },
    { limit: 2, count: 6, partial: false, followup: false },
    { limit: 16, count: 20, partial: false, followup: false },
    { limit: 3, count: 6, partial: true, followup: false },
    { limit: 16, count: 30, partial: true, followup: true },
    { limit: 16, count: 65, partial: false, followup: true, refill: true },
  ])(
    "accounts for $count items with $limit slots, partial settlement $partial and follow-up tools $followup",
    async ({ limit, count, partial, followup, refill = false }) => {
      const config = resolveCodeModeConfig({
        tools: { codeMode: { enabled: true, maxPendingToolCalls: limit } },
      });
      const source = `
      const initial = ${refill} ? Array.from({ length: 16 }, (_, i) => progress({ value: "initial-" + i })) : [];
      const timers = ${refill} ? Array.from({ length: 128 }, () => setTimeout(() => { throw new Error("canceled queued timer fired"); }, 60_000)) : [];
      const collecting = Promise.allSettled(Array.from({ length: ${count} }, async (_, index) => {
        const next = await agents.run("first-" + index, { phase: "First" });
        if (${followup}) await progress({ value: index });
        return await agents.run(next, { phase: "Second" });
      }));
      if (${refill}) {
        await Promise.all(initial);
        timers.forEach(clearTimeout);
        for (let batch = 0; batch < 2; batch++) {
          await Promise.all(Array.from({ length: 128 }, (_, i) => progress({ value: batch + "-" + i })));
        }
      }
      const outcomes = await collecting;
      return outcomes.map(outcome => outcome.status === "fulfilled"
        ? { status: outcome.status, value: outcome.value }
        : { status: outcome.status, error: outcome.reason.message });
    `;
      let result: CodeModeWorkerResult = await testing.runCodeModeWorker(
        {
          kind: "exec",
          source,
          config,
          catalog: [{ callableName: "progress", name: "progress", source: "openclaw" }],
          apiFiles: [],
          namespaces: [],
          swarmEnabled: true,
        },
        10_000,
      );
      const collectors = new Map<string, string>();
      const spawnedPrompts: string[] = [];
      const progressItems: unknown[] = [];
      // Drive real worker snapshots with controlled child results; this tests request
      // admission and resumption, not a mock of the guest's Promise implementation.
      for (let round = 0; result.status === "waiting" && round < count * 8; round++) {
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
          } else if (request.method === "callValue") {
            expect(request.args[0]).toBe("progress");
            progressItems.push(request.args[1]);
            value = { recorded: true };
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
          return { id: request.id, ok: true as const, json: JSON.stringify(value) };
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
      const expectedProgress = followup
        ? Array.from({ length: count }, (_, value) => ({ value })).filter(
            ({ value }) => value !== 1,
          )
        : [];
      const expectedRefills = refill
        ? [
            ...Array.from({ length: 16 }, (_, i) => ({ value: "initial-" + i })),
            ...[0, 1].flatMap((batch) =>
              Array.from({ length: 128 }, (_, i) => ({ value: batch + "-" + i })),
            ),
          ]
        : [];
      expect(progressItems).toHaveLength(expectedProgress.length + expectedRefills.length);
      expect(progressItems).toEqual(expect.arrayContaining(expectedRefills));
      expect(progressItems).toEqual(expect.arrayContaining(expectedProgress));
    },
  );

  it.each([false, true])(
    "preserves queued collector arguments and structured=%s results",
    async (structured) => {
      const config = resolveCodeModeConfig({
        tools: { codeMode: { enabled: true, maxPendingToolCalls: 1 } },
      });
      let result = await testing.runCodeModeWorker(
        {
          kind: "exec",
          source: `
          const timer = setTimeout(() => { throw new Error("canceled timer fired"); }, 60_000);
          const options = { label: "original", ...(${structured} ? { schema: { type: "object" } } : {}) };
          const collector = agents.run("Queued research", options);
          options.label = "changed";
          if (${structured}) delete options.schema;
          else options.schema = { type: "object" };
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
            args: [
              "Queued research",
              { label: "original", ...(structured ? { schema: { type: "object" } } : {}) },
            ],
          },
        ],
      });
      for (let round = 0; result.status === "waiting" && round < 2; round++) {
        const settledRequests = result.pendingRequests.map((request) => ({
          id: request.id,
          ok: true as const,
          json: JSON.stringify(
            request.method === "agentSpawn"
              ? { runId: "collector" }
              : {
                  runId: "collector",
                  status: "done",
                  result: "text",
                  ...(structured ? { structured: { answer: 42 } } : {}),
                },
          ),
        }));
        result = await testing.runCodeModeWorker(
          { kind: "resume", snapshot: result.snapshot, config, settledRequests },
          10_000,
        );
      }
      expect(result.status).toBe("completed");
      if (result.status !== "completed") {
        throw new Error("collector must complete");
      }
      expect(JSON.parse(result.value.json)).toEqual(structured ? { answer: 42 } : "text");
    },
  );
});
