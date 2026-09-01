import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaScenarioFlow } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";

type QaFlowAction = QaScenarioFlow["steps"][number]["actions"][number];

const delayedSideEffectCases: Array<[name: string, action: QaFlowAction]> = [
  ["generic call", { call: "sideEffect", args: [{ expr: "await resolveInput()" }] }],
  ["sendInbound", { sendInbound: { expr: "await resolveInput()" } }],
  ["sendNativeCommand", { sendNativeCommand: { expr: "await resolveInput()" } }],
  ["waitForOutbound", { waitForOutbound: { expr: "await resolveInput()" } }],
  ["waitForOutboundSequence", { waitForOutboundSequence: { expr: "await resolveInput()" } }],
  ["waitForNoOutbound", { waitForNoOutbound: { expr: "await resolveInput()" } }],
];

describe("scenario flow deadline", () => {
  it.each(delayedSideEffectCases)(
    "does not invoke %s after aborting during async input resolution",
    async (_name, action) => {
      const controller = new AbortController();
      const timeoutError = new Error("scenario deadline expired");
      const sideEffect = vi.fn();
      let markInputStarted!: () => void;
      let releaseInput!: (value: unknown) => void;
      const inputStarted = new Promise<void>((resolve) => {
        markInputStarted = resolve;
      });
      const input = new Promise<unknown>((resolve) => {
        releaseInput = resolve;
      });

      const pending = runScenarioFlow({
        api: {
          signal: controller.signal,
          state: createQaBusState(),
          scenario: {
            id: "flow-post-resolution-abort-fence",
            title: "flow-post-resolution-abort-fence",
            sourcePath: "qa/scenarios/flow-post-resolution-abort-fence.yaml",
            surface: "test",
            objective: "test",
            successCriteria: ["test"],
            execution: { kind: "flow" },
          },
          config: {},
          resolveInput: async () => {
            markInputStarted();
            return await input;
          },
          sideEffect,
          transport: {
            sendInbound: sideEffect,
            sendNativeCommand: sideEffect,
            waitForOutbound: sideEffect,
            waitForOutboundSequence: sideEffect,
            waitForNoOutbound: sideEffect,
          },
          runScenario: async (name, steps) => {
            for (const step of steps) {
              await step.run();
            }
            return { name, status: "pass", steps: [] };
          },
        },
        scenarioTitle: "flow-post-resolution-abort-fence",
        flow: { steps: [{ name: "resolve input", actions: [action] }] },
      });

      await inputStarted;
      controller.abort(timeoutError);
      releaseInput({});

      await expect(pending).rejects.toBe(timeoutError);
      expect(sideEffect).not.toHaveBeenCalled();
    },
  );

  it("runs finally cleanup without advancing other actions after abort", async () => {
    const controller = new AbortController();
    const timeoutError = new Error("scenario deadline expired");
    const nestedMutation = vi.fn();
    const catchMutation = vi.fn();
    const finallyMutation = vi.fn();
    const laterMutation = vi.fn();
    const detailsMutation = vi.fn(() => "details");
    let markActionStarted!: () => void;
    let releaseAction!: () => void;
    let expireDeadline!: (reason: Error) => void;
    let pendingStep: Promise<string | void> | undefined;
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });
    const action = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      expireDeadline = reject;
    });
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

    const pending = runScenarioFlow({
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
          markActionStarted();
          await action;
        },
        nestedMutation,
        catchMutation,
        finallyMutation,
        laterMutation,
        detailsMutation,
        runScenario: async (name, steps) => {
          try {
            pendingStep = steps[0]?.run();
            await Promise.race([pendingStep, deadline]);
            return { name, status: "pass", steps: [] };
          } catch (error) {
            return {
              name,
              status: "fail",
              details: error instanceof Error ? error.message : String(error),
              steps: [],
            };
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

    try {
      await Promise.race([
        actionStarted,
        pending.then(() => {
          throw new Error("flow settled before the delayed action started");
        }),
      ]);
      controller.abort(timeoutError);
      expireDeadline(timeoutError);
      const result = await pending;

      expect(result).toMatchObject({ status: "fail", details: timeoutError.message });
      // The outer deadline returns while the action is held; cleanup belongs to its late unwind.
      expect(finallyMutation).not.toHaveBeenCalled();
      releaseAction();
      await expect(pendingStep).rejects.toBe(timeoutError);
      expect(nestedMutation).not.toHaveBeenCalled();
      expect(catchMutation).not.toHaveBeenCalled();
      expect(finallyMutation).toHaveBeenCalledOnce();
      expect(laterMutation).not.toHaveBeenCalled();
      expect(detailsMutation).not.toHaveBeenCalled();
    } finally {
      controller.abort(timeoutError);
      expireDeadline(timeoutError);
      releaseAction();
      await Promise.allSettled([pending, pendingStep, deadline]);
    }
  });
});
