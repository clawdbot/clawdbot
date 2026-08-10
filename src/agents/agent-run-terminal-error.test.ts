import { describe, expect, it, vi } from "vitest";
import {
  AgentRunTerminalOutcomeError,
  errorCauseChainIncludes,
  findAgentRunTerminalOutcome,
  hasStructuredTimeoutCause,
} from "./agent-run-terminal-error.js";

const terminalOutcome = {
  reason: "hard_timeout",
  status: "timeout",
  error: "task timed out",
  timeoutPhase: "provider",
} as const;

describe("agent run terminal error cause traversal", () => {
  it("finds terminal outcomes and exact targets through ordinary data causes", () => {
    const taskFailure = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    const wrapped = new Error("scope failed", { cause: taskFailure });

    expect(findAgentRunTerminalOutcome(wrapped)).toEqual(terminalOutcome);
    expect(findAgentRunTerminalOutcome(wrapped)).not.toBe(terminalOutcome);
    expect(errorCauseChainIncludes(wrapped, taskFailure)).toBe(true);
  });

  it("normalizes closed terminal data without invoking value accessors", () => {
    const get = vi.fn(() => {
      throw new Error("value access");
    });
    const proxied = new Proxy(
      {
        reason: "hard_timeout",
        status: "timeout",
        error: "provider failed",
        timeoutPhase: "provider",
        providerStarted: true,
        startedAt: 10,
        endedAt: 20,
      } as const,
      { get },
    );
    const taskFailure = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    Object.defineProperty(taskFailure, "terminalOutcome", { value: proxied });

    expect(findAgentRunTerminalOutcome(taskFailure)).toEqual({
      reason: "hard_timeout",
      status: "timeout",
      error: "provider failed",
      timeoutPhase: "provider",
      providerStarted: true,
      startedAt: 10,
      endedAt: 20,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects invalid, open, and accessor-backed terminal outcomes", () => {
    const invalid = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    Object.defineProperty(invalid, "terminalOutcome", {
      value: { reason: "failed", status: "timeout" },
    });
    const open = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    Object.defineProperty(open, "terminalOutcome", {
      value: { reason: "failed", status: "error", injected: true },
    });
    const accessor = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    Object.defineProperty(accessor, "terminalOutcome", {
      value: Object.defineProperty({ status: "error" }, "reason", {
        get() {
          throw new Error("reason accessor");
        },
      }),
    });
    const inheritedReasons = ["toString", "constructor", "__proto__"].map((reason) => {
      const error = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
      Object.defineProperty(error, "terminalOutcome", {
        value: { reason, status: () => "[object Object]" },
      });
      return error;
    });
    const boxedReason = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    Object.defineProperty(boxedReason, "terminalOutcome", {
      value: { reason: Object("failed"), status: "error" },
    });
    const reasonGet = vi.fn(() => {
      throw new Error("boxed reason access");
    });
    const proxiedReason = new AgentRunTerminalOutcomeError(
      new Error("task failed"),
      terminalOutcome,
    );
    Object.defineProperty(proxiedReason, "terminalOutcome", {
      value: {
        reason: new Proxy(Object("failed"), { get: reasonGet }),
        status: "error",
      },
    });

    expect(findAgentRunTerminalOutcome(invalid)).toBeUndefined();
    expect(findAgentRunTerminalOutcome(open)).toBeUndefined();
    expect(findAgentRunTerminalOutcome(accessor)).toBeUndefined();
    for (const inheritedReason of inheritedReasons) {
      expect(findAgentRunTerminalOutcome(inheritedReason)).toBeUndefined();
    }
    expect(findAgentRunTerminalOutcome(boxedReason)).toBeUndefined();
    expect(findAgentRunTerminalOutcome(proxiedReason)).toBeUndefined();
    expect(reasonGet).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "provider timeout downgraded to failure",
      outcome: {
        reason: "failed",
        status: "error",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    },
    {
      label: "blocked liveness downgraded to completion",
      outcome: {
        reason: "completed",
        status: "ok",
        livenessState: "blocked",
      },
    },
    {
      label: "rpc cancellation downgraded to failure",
      outcome: {
        reason: "failed",
        status: "error",
        stopReason: "rpc",
      },
    },
    {
      label: "provider-started timeout downgraded to ordinary timeout",
      outcome: {
        reason: "timed_out",
        status: "timeout",
        providerStarted: true,
      },
    },
    {
      label: "aborted outcome omits the canonical error",
      outcome: {
        reason: "aborted",
        status: "error",
        stopReason: "aborted",
      },
    },
    {
      label: "blank optional field",
      outcome: {
        reason: "failed",
        status: "error",
        error: "",
      },
    },
    {
      label: "undefined optional field",
      outcome: {
        reason: "failed",
        status: "error",
        error: undefined,
      },
    },
  ])("rejects terminal authority conflicts: $label", ({ outcome }) => {
    const taskFailure = new AgentRunTerminalOutcomeError(new Error("task failed"), terminalOutcome);
    Object.defineProperty(taskFailure, "terminalOutcome", { value: outcome });

    expect(findAgentRunTerminalOutcome(taskFailure)).toBeUndefined();
  });

  it("does not invoke cause accessors", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("accessor invoked");
      },
    });

    expect(findAgentRunTerminalOutcome(hostile)).toBeUndefined();
    expect(errorCauseChainIncludes(hostile, new Error("target"))).toBe(false);
    expect(hasStructuredTimeoutCause(hostile)).toBe(false);
  });

  it("distinguishes an absent cause from an explicit undefined cause", () => {
    const absent = new Error("absent");
    const explicit = new Error("explicit");
    Object.defineProperty(explicit, "cause", { value: undefined });

    expect(errorCauseChainIncludes(absent, undefined)).toBe(false);
    expect(errorCauseChainIncludes(explicit, undefined)).toBe(true);
  });

  it("stops cleanly when a proxy rejects descriptor or prototype inspection", () => {
    const descriptorHostile = new Proxy(new Error("hostile"), {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    });
    const prototypeHostile = new Proxy(new Error("hostile"), {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    });

    expect(findAgentRunTerminalOutcome(descriptorHostile)).toBeUndefined();
    expect(errorCauseChainIncludes(descriptorHostile, new Error("target"))).toBe(false);
    expect(findAgentRunTerminalOutcome(prototypeHostile)).toBeUndefined();
    expect(hasStructuredTimeoutCause(prototypeHostile)).toBe(false);
  });

  it("constructs a stable wrapper message without inspecting hostile errors", () => {
    const hostile = new Proxy(new Error("hidden"), {
      get() {
        throw new Error("get trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    });

    expect(new AgentRunTerminalOutcomeError(hostile, terminalOutcome).message).toBe(
      "Agent run failed",
    );
  });

  it("bounds cycles and deep chains", () => {
    const cycle = new Error("cycle");
    Object.defineProperty(cycle, "cause", { value: cycle });
    const target = new Error("target");
    let deep: unknown = target;
    for (let index = 0; index < 16; index += 1) {
      deep = new Error(`wrapper-${String(index)}`, { cause: deep });
    }

    expect(errorCauseChainIncludes(cycle, target)).toBe(false);
    expect(findAgentRunTerminalOutcome(cycle)).toBeUndefined();
    expect(errorCauseChainIncludes(deep, target)).toBe(false);
  });

  it("recognizes timeout markers only from own data properties", () => {
    const timeout = new Error("timed out");
    Object.defineProperty(timeout, "code", { value: "ETIMEDOUT" });
    const inherited = Object.create({ code: "ETIMEDOUT" }) as object;

    expect(hasStructuredTimeoutCause(new Error("wrapped", { cause: timeout }))).toBe(true);
    expect(hasStructuredTimeoutCause(inherited)).toBe(false);
  });
});
