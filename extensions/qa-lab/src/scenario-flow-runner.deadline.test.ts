import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";

describe("scenario flow deadline", () => {
  it("runs finally cleanup without advancing other actions after abort", async () => {
    const controller = new AbortController();
    const timeoutError = new Error("scenario deadline expired");
    const nestedMutation = vi.fn();
    const catchMutation = vi.fn();
    const finallyMutation = vi.fn();
    const laterMutation = vi.fn();
    const detailsMutation = vi.fn(() => "details");
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const thenKey = ["th", "en"].join("");
    const ifAction = Object.fromEntries([
      ["expr", "true"],
      [
        thenKey,
        [
          {
            forEach: {
              items: [1],
              item: "item",
              actions: [{ call: "delayedAction" }, { call: "nestedMutation" }],
            },
          },
        ],
      ],
    ]);

    const result = await runScenarioFlow({
      api: {
        signal: controller.signal,
        state: createQaBusState(),
        scenario: {
          id: "flow-abort-fence",
          title: "flow-abort-fence",
          sourcePath: "qa/scenarios/flow-abort-fence.yaml",
          surface: "test",
          objective: "test",
          successCriteria: ["test"],
          execution: { kind: "flow" },
        },
        config: {},
        delayedAction: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
        },
        nestedMutation,
        catchMutation,
        finallyMutation,
        laterMutation,
        detailsMutation,
        runScenario: async (name, steps) => {
          const deadline = new Promise<never>((_resolve, reject) => {
            deadlineTimer = setTimeout(() => {
              controller.abort(timeoutError);
              reject(timeoutError);
            }, 10);
          });
          try {
            await Promise.race([steps[0]?.run(), deadline]);
            return { name, status: "pass", steps: [] };
          } catch (error) {
            return {
              name,
              status: "fail",
              details: error instanceof Error ? error.message : String(error),
              steps: [],
            };
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      },
      scenarioTitle: "flow-abort-fence",
      flow: {
        steps: [
          {
            name: "aborted nested flow",
            actions: [
              {
                try: {
                  actions: [{ if: ifAction }],
                  catch: [{ call: "catchMutation" }],
                  finally: [{ call: "finallyMutation" }],
                },
              },
              { call: "laterMutation" },
            ],
            detailsExpr: "detailsMutation()",
          },
        ],
      },
    });

    expect(result).toMatchObject({ status: "fail", details: timeoutError.message });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(nestedMutation).not.toHaveBeenCalled();
    expect(catchMutation).not.toHaveBeenCalled();
    expect(finallyMutation).toHaveBeenCalledOnce();
    expect(laterMutation).not.toHaveBeenCalled();
    expect(detailsMutation).not.toHaveBeenCalled();
  });
});
