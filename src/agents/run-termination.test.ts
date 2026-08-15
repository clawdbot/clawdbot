import { describe, expect, it } from "vitest";
import { FailoverError } from "./failover-error.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  isAbortedAgentStopReason,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
  resolveCliToolTerminalReason,
} from "./run-termination.js";

describe("resolveCliToolTerminalReason", () => {
  it.each([
    {
      name: "abort-timeout",
      setup: () => {
        const controller = new AbortController();
        const timeout = new Error("timed out");
        timeout.name = "TimeoutError";
        controller.abort(timeout);
        return { abortSignal: controller.signal, error: new Error("other") };
      },
      expected: "timed_out",
    },
    {
      name: "abort-cancel",
      setup: () => {
        const controller = new AbortController();
        controller.abort();
        return { abortSignal: controller.signal, error: undefined };
      },
      expected: "cancelled",
    },
    {
      name: "restart-abort reason",
      setup: () => {
        const controller = new AbortController();
        controller.abort(createAgentRunRestartAbortError());
        return { abortSignal: controller.signal, error: undefined };
      },
      expected: "cancelled",
    },
    {
      name: "FailoverError timeout",
      setup: () => ({
        error: new FailoverError("CLI timed out", { reason: "timeout" }),
      }),
      expected: "timed_out",
    },
    {
      name: "isTimeoutError error",
      setup: () => {
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        return { error };
      },
      expected: "timed_out",
    },
    {
      name: "AbortError",
      setup: () => {
        const error = new Error("CLI run aborted");
        error.name = "AbortError";
        return { error };
      },
      expected: "cancelled",
    },
    {
      name: "plain Error",
      setup: () => ({ error: new Error("tool failed") }),
      expected: "failed",
    },
    {
      name: "undefined error",
      setup: () => ({ error: undefined }),
      expected: "failed",
    },
    {
      name: "timeout abort wins over generic AbortError",
      setup: () => {
        const controller = new AbortController();
        const timeout = new Error("timed out");
        timeout.name = "TimeoutError";
        controller.abort(timeout);
        const error = new Error("CLI run aborted");
        error.name = "AbortError";
        return { abortSignal: controller.signal, error };
      },
      expected: "timed_out",
    },
    {
      name: "cancel abort wins over timeout-shaped error",
      setup: () => {
        const controller = new AbortController();
        controller.abort();
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        return { abortSignal: controller.signal, error };
      },
      expected: "cancelled",
    },
    {
      name: "hostile name getter classifies failed instead of throwing",
      setup: () => {
        const error = Object.defineProperty(new Error("boom"), "name", {
          get() {
            throw new Error("hostile getter");
          },
        });
        return { error };
      },
      expected: "failed",
    },
  ] as const)("$name", ({ setup, expected }) => {
    expect(resolveCliToolTerminalReason(setup())).toBe(expected);
  });
});

describe("resolveAgentRunAbortLifecycleFields", () => {
  it("classifies generic cancellation as aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("preserves timeout attribution", () => {
    const controller = new AbortController();
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    controller.abort(timeout);

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "timeout",
    });
  });

  it("classifies managed restart cancellation", () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "restart",
    });
  });

  it("contains hostile abort reasons", () => {
    const controller = new AbortController();
    const reason = Object.defineProperty({}, "name", {
      get() {
        throw new Error("hostile name");
      },
    });
    controller.abort(reason);

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("contains revoked abort reason proxies", () => {
    const controller = new AbortController();
    const { proxy, revoke } = Proxy.revocable({}, {});
    controller.abort(proxy);
    revoke();

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("treats restart as an aborted terminal reason", () => {
    expect(isAbortedAgentStopReason("aborted")).toBe(true);
    expect(isAbortedAgentStopReason("restart")).toBe(true);
    expect(isAbortedAgentStopReason("timeout")).toBe(false);
  });

  it("marks direct active-run cancellation independently of an AbortSignal", () => {
    const error = createAgentRunDirectAbortError();

    expect(error).toMatchObject({
      name: "AbortError",
      message: "agent run aborted",
    });
    expect(isAgentRunDirectAbortReason(error)).toBe(true);
    expect(isAgentRunDirectAbortReason(createAgentRunRestartAbortError())).toBe(false);
  });
});

describe("resolveAgentRunErrorLifecycleFields", () => {
  it("attributes structured provider watchdog timeouts", () => {
    const error = new FailoverError("CLI timed out", { reason: "timeout" });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it("does not reclassify ordinary provider failures", () => {
    const error = new FailoverError("CLI failed", { reason: "server_error" });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
  });

  it("reads the final structured timeout from a fallback summary cause", () => {
    const timeout = new FailoverError("CLI timed out", { reason: "timeout" });
    const error = new Error("All model fallback candidates failed", { cause: timeout });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it("contains throwing cause accessors", () => {
    const error = Object.defineProperty(new Error("provider failed"), "cause", {
      get() {
        throw new Error("hostile cause");
      },
    });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
  });

  it("contains hostile failover fields", () => {
    const hostileName = Object.defineProperty({}, "name", {
      get() {
        throw new Error("hostile name");
      },
    });
    const hostileReason = Object.defineProperty({ name: "FailoverError" }, "reason", {
      get() {
        throw new Error("hostile reason");
      },
    });

    expect(resolveAgentRunErrorLifecycleFields(hostileName, undefined)).toEqual({});
    expect(resolveAgentRunErrorLifecycleFields(hostileReason, undefined)).toEqual({});
  });

  it("preserves explicit cancellation over a concurrent timeout error", () => {
    const controller = new AbortController();
    controller.abort();
    const error = new FailoverError("CLI timed out", { reason: "timeout" });

    expect(resolveAgentRunErrorLifecycleFields(error, controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });
});
