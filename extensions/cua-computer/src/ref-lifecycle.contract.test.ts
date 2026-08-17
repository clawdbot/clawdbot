import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { driver, result } from "./commands.test-helpers.js";
import { callWindowTool } from "./driver-result.js";
import {
  adoptGeneration,
  issueElementRef,
  issueObservation,
  issueWindowRef,
  resolveElementRef,
  resolveObservation,
  resolveWindowRef,
  type CuaFrameState,
} from "./frame.js";

type RefLifecycleCase = {
  id: string;
  scenario:
    | "fresh_window"
    | "fresh_element"
    | "window_moved"
    | "generation_rotation"
    | "in_flight_generation_change"
    | "superseded_observation"
    | "unrelated_discovery"
    | "unknown_ref";
  expected: "valid" | "stale";
};

type RefLifecycleContract = {
  staleErrorCode: string;
  cases: RefLifecycleCase[];
};

const contract = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/computer-ref-lifecycle-contract.json", import.meta.url),
    "utf8",
  ),
) as RefLifecycleContract;

async function runCase(testCase: RefLifecycleCase): Promise<void> {
  const state: CuaFrameState = { generation: "generation-1" };
  const windowRef = issueWindowRef(state, { pid: 100, windowId: 10 });
  const observation = issueObservation(state, windowRef);
  const elementRef = issueElementRef(observation, { elementIndex: 0 });

  switch (testCase.scenario) {
    case "fresh_window":
      resolveWindowRef(state, windowRef);
      return;
    case "fresh_element":
      resolveElementRef(resolveObservation(state, observation.id, windowRef), elementRef);
      return;
    case "window_moved": {
      // A moved window is rediscovered under the same stable identity, so the
      // ref survives and still resolves to the live window. CUA stores only that
      // identity, so the refreshed target is the identity itself.
      const moved = { pid: 100, windowId: 10 };
      expect(issueWindowRef(state, moved)).toBe(windowRef);
      expect(resolveWindowRef(state, windowRef)).toEqual(moved);
      return;
    }
    case "generation_rotation":
      adoptGeneration(state, "generation-2");
      resolveWindowRef(state, windowRef);
      return;
    case "in_flight_generation_change": {
      // The production path is callWindowTool: it snapshots the driver
      // generation, awaits the driver call, then detects rotation. Asserting a
      // pre-call guard instead would leave that post-await check unprotected.
      const session = driver();
      session.callTool.mockImplementationOnce(async () => {
        session.setGeneration("execution-2");
        return result({});
      });
      await callWindowTool(
        session.session,
        { generation: session.session.generation },
        "get_window_state",
        {},
      );
      return;
    }
    case "superseded_observation":
      issueObservation(state, windowRef);
      resolveObservation(state, observation.id, windowRef);
      return;
    case "unrelated_discovery":
      issueWindowRef(state, { pid: 200, windowId: 20 });
      resolveWindowRef(state, windowRef);
      return;
    case "unknown_ref":
      resolveWindowRef(state, "cua:v2:window:unknown");
  }
}

describe("Computer Use ref lifecycle contract", () => {
  for (const testCase of contract.cases) {
    it(testCase.id, async () => {
      if (testCase.expected === "valid") {
        await expect(runCase(testCase)).resolves.toBeUndefined();
      } else {
        await expect(runCase(testCase)).rejects.toThrow(
          new RegExp(`^${contract.staleErrorCode}:`, "u"),
        );
      }
    });
  }
});
