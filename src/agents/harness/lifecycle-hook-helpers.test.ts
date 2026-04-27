import { describe, expect, it } from "vitest";
import {
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./lifecycle-hook-helpers.js";

const legacyHookRunner = {
  hasHooks: () => true,
};

describe("agent harness lifecycle hook helpers", () => {
  it("ignores legacy hook runners that advertise llm_input without a runner method", () => {
    expect(() =>
      runAgentHarnessLlmInputHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).not.toThrow();
  });

  it("ignores legacy hook runners that advertise llm_output without a runner method", () => {
    expect(() =>
      runAgentHarnessLlmOutputHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).not.toThrow();
  });

  it("ignores legacy hook runners that advertise agent_end without a runner method", () => {
    expect(() =>
      runAgentHarnessAgentEndHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).not.toThrow();
  });

  it("continues when legacy hook runners advertise before_agent_finalize without a runner method", async () => {
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).resolves.toEqual({ action: "continue" });
  });
});
