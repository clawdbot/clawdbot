// Qa Lab tests cover self check plugin behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";
import type { QaSelfCheckResult } from "./self-check.js";
import { isQaSelfCheckSuccessful, resolveQaSelfCheckOutputPath } from "./self-check.js";

function makeSelfCheckResult(params: {
  scenarioStatus: "pass" | "fail";
  checkStatuses: Array<"pass" | "fail">;
}): QaSelfCheckResult {
  return {
    outputPath: "/tmp/qa-self-check.md",
    report: "",
    checks: params.checkStatuses.map((status, index) => ({
      name: `check ${String(index + 1)}`,
      status,
    })),
    scenarioResult: {
      name: "QA self-check scenario",
      status: params.scenarioStatus,
      steps: [],
    },
  };
}

describe("isQaSelfCheckSuccessful", () => {
  it("requires the scenario and every check to pass", () => {
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass"] }),
      ),
    ).toBe(true);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "fail", checkStatuses: ["pass"] }),
      ),
    ).toBe(false);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass", "fail"] }),
      ),
    ).toBe(false);
  });
});

describe("resolveQaSelfCheckOutputPath", () => {
  it("keeps explicit output paths untouched", () => {
    expect(
      resolveQaSelfCheckOutputPath({
        repoRoot: "/tmp/openclaw-repo",
        outputPath: "/tmp/custom/self-check.md",
      }),
    ).toBe("/tmp/custom/self-check.md");
  });

  it("anchors default self-check reports under unique files in the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    const firstPath = resolveQaSelfCheckOutputPath({ repoRoot });
    const secondPath = resolveQaSelfCheckOutputPath({ repoRoot });

    expect(path.dirname(firstPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    expect(secondPath).not.toBe(firstPath);
  });
});

describe("createQaSelfCheckScenario", () => {
  it("binds lifecycle actions to the seeded message thread", async () => {
    const state = createQaBusState();
    const scenario = createQaSelfCheckScenario();
    const threadStep = scenario.steps[1];
    const lifecycleStep = scenario.steps[2];
    if (!threadStep || !lifecycleStep) {
      throw new Error("self-check thread lifecycle steps are missing");
    }
    const targets: unknown[] = [];
    const testState = {
      ...state,
      addInboundMessage: (input: Parameters<typeof state.addInboundMessage>[0]) => {
        const inbound = state.addInboundMessage(input);
        if (input.text === "inside thread") {
          state.addOutboundMessage({
            to: `thread:${input.conversation.id}/${String(input.threadId)}`,
            text: "qa-echo: inside thread",
          });
        }
        return inbound;
      },
    };
    const performAction = async (action: string, args: Record<string, unknown>) => {
      if (action === "thread-create") {
        return {
          details: {
            target: "thread:qa-room/thread-1",
            thread: { id: "thread-1" },
          },
        };
      }
      targets.push(args.to);
      if (action === "react") {
        return state.reactToMessage({
          messageId: String(args.messageId),
          emoji: String(args.emoji),
        });
      }
      if (action === "edit") {
        return state.editMessage({
          messageId: String(args.messageId),
          text: String(args.text),
        });
      }
      if (action === "delete") {
        return state.deleteMessage({ messageId: String(args.messageId) });
      }
      throw new Error(`unexpected action: ${action}`);
    };

    await threadStep.run({ state: testState, performAction });
    await lifecycleStep.run({ state: testState, performAction });

    expect(targets).toEqual([
      "thread:qa-room/thread-1",
      "thread:qa-room/thread-1",
      "thread:qa-room/thread-1",
    ]);
    expect(state.searchMessages({ query: "inside thread" }).at(-1)?.deleted).toBe(true);
  });
});
