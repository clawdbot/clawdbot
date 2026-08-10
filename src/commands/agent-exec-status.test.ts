import { describe, expect, it } from "vitest";
import {
  applyAgentExecCleanupOutcome,
  isAgentExecTaskFailure,
  type AgentExecError,
  type AgentExecStatus,
} from "./agent-exec-status.js";

type TestEnvelope = {
  ok: boolean;
  status: AgentExecStatus;
  final: string;
  error?: AgentExecError;
};

const taskError: AgentExecError = {
  message: "task failed",
  kind: "agent_error",
  phase: "task",
};

const timeoutError: AgentExecError = {
  message: "task timed out",
  kind: "timeout",
  phase: "task",
};

const cancellationError: AgentExecError = {
  message: "task cancelled",
  kind: "cancelled",
  phase: "task",
};

type TaskOutcome = AgentExecStatus | "cancel";

function resultFor(outcome: TaskOutcome) {
  const status = outcome === "cancel" ? "error" : outcome;
  const envelope: TestEnvelope = {
    ok: status === "ok",
    status,
    final: "retained output",
    ...(outcome === "error" ? { error: taskError } : {}),
    ...(outcome === "cancel" ? { error: cancellationError } : {}),
    ...(status === "timeout" ? { error: timeoutError } : {}),
  };
  return {
    envelope,
    exitCode: status === "ok" ? (0 as const) : status === "timeout" ? (2 as const) : (1 as const),
  };
}

describe("applyAgentExecCleanupOutcome", () => {
  it.each(["ok", "error", "timeout", "cancel"] as const)(
    "leaves a %s result unchanged after successful cleanup",
    (status) => {
      const input = resultFor(status);

      expect(applyAgentExecCleanupOutcome(input)).toEqual(input);
    },
  );

  it.each([
    {
      outcome: "ok",
      status: "error",
      exitCode: 1,
      primary: {
        message: "Agent exec cleanup failed: cleanup denied",
        kind: "cleanup_error",
        phase: "cleanup",
      },
    },
    { outcome: "error", status: "error", exitCode: 1, primary: taskError },
    { outcome: "timeout", status: "timeout", exitCode: 2, primary: timeoutError },
    { outcome: "cancel", status: "error", exitCode: 1, primary: cancellationError },
  ] as const)(
    "preserves the $outcome primary outcome when cleanup fails",
    ({ outcome, status, exitCode, primary }) => {
      expect(
        applyAgentExecCleanupOutcome(resultFor(outcome), {
          message: "Agent exec cleanup failed: cleanup denied",
        }),
      ).toEqual({
        exitCode,
        envelope: {
          ok: false,
          status,
          final: "retained output",
          error: primary,
          cleanup: {
            status: "failed",
            error: {
              message: "Agent exec cleanup failed: cleanup denied",
              kind: "cleanup_error",
              phase: "cleanup",
            },
          },
        },
      });
    },
  );
});

describe("isAgentExecTaskFailure", () => {
  it("matches only the original task failure through bounded cause wrappers", () => {
    const taskFailure = new Error("task failed");
    const wrapped = new Error("scope failed", { cause: taskFailure });
    const sameMessage = new Error("scope failed", { cause: new Error("task failed") });

    expect(isAgentExecTaskFailure(wrapped, taskFailure)).toBe(true);
    expect(isAgentExecTaskFailure(sameMessage, taskFailure)).toBe(false);
    expect(isAgentExecTaskFailure(wrapped, new Error("foreign"))).toBe(false);
    expect(isAgentExecTaskFailure("task failed", "task failed")).toBe(true);
  });

  it("does not invoke hostile cause accessors or proxy traps", () => {
    const target = new Error("target");
    const accessor = new Error("accessor");
    Object.defineProperty(accessor, "cause", {
      get() {
        throw new Error("accessor invoked");
      },
    });
    const proxy = new Proxy(new Error("proxy"), {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    });

    expect(isAgentExecTaskFailure(accessor, target)).toBe(false);
    expect(isAgentExecTaskFailure(proxy, target)).toBe(false);
  });
});
