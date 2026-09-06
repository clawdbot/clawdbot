import { describe, expect, it } from "vitest";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
} from "./agent-run-terminal-outcome.js";
import { createCliTimeoutError } from "./cli-runner/no-output-timeout-policy.js";
import { coerceToFailoverError } from "./failover-error.js";
import { FailoverError } from "./failover/error.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  isAbortedAgentStopReason,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
  resolveCliToolTerminalReason,
} from "./run-termination.js";

function createCliWatchdogError() {
  return createCliTimeoutError(
    {},
    {
      mode: "no-output",
      timeoutSeconds: 30,
      observedActivity: false,
      activeToolCount: 0,
      backgroundTaskCount: 0,
    },
  );
}

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
      name: "CLI watchdog timeout",
      setup: () => ({
        error: createCliWatchdogError(),
      }),
      expected: "timed_out",
    },
    {
      name: "intentional TimeoutError",
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
      name: "retryable HTTP 500 is a failure rather than a deadline",
      setup: () => ({
        error: coerceToFailoverError({
          status: 500,
          message: "500 Fixture request needs a task header",
        }),
      }),
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
  it("preserves an unphased provider-started timeout from the public harness result", () => {
    const outcome = buildAgentRunTerminalOutcomeFromAttempt({
      terminal: { kind: "timeout", phase: "compaction", source: "runtime" },
      promptTimeoutOutcome: { providerStarted: true },
    });
    expect(outcome).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      providerStarted: true,
    });
    expect(outcome).not.toHaveProperty("timeoutPhase");
    const error = new FailoverError("Attempt timed out", {
      reason: "timeout",
      timeout: { timeoutPhase: outcome.timeoutPhase, providerStarted: outcome.providerStarted },
    });

    const fields = resolveAgentRunErrorLifecycleFields(error, undefined);

    expect(fields).toEqual({ stopReason: "timeout", providerStarted: true });
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
    ).toBe("hard_timeout");
  });

  it.each(["direct", "fallback summary"])(
    "does not promote a retryable HTTP 500 to a provider timeout through %s",
    (wrapper) => {
      const failure = coerceToFailoverError({
        status: 500,
        message: "500 Fixture request needs a task header",
      });
      expect(failure).toMatchObject({ reason: "timeout", status: 500 });
      const error =
        wrapper === "direct"
          ? failure
          : new Error("All model fallback candidates failed", { cause: failure });

      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
    },
  );

  it("keeps a retryable connection reset as a failure for run and tool terminals", () => {
    const failure = coerceToFailoverError(new Error("fetch failed: ECONNRESET"));
    expect(failure?.reason).toBe("timeout");

    expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual({});
    expect(resolveCliToolTerminalReason({ error: failure })).toBe("failed");
  });

  it("preserves an intentional TimeoutError through provider coercion", () => {
    const cause = Object.assign(new Error("provider request deadline elapsed"), {
      name: "TimeoutError",
    });
    const failure = coerceToFailoverError(cause);

    expect(failure?.cause).toBe(cause);
    expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it.each([false, true])("preserves direct cancellation with caller signal=%s", (hasSignal) => {
    const signal = hasSignal ? new AbortController().signal : undefined;
    expect(resolveAgentRunErrorLifecycleFields(createAgentRunDirectAbortError(), signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("attributes structured provider watchdog timeouts", () => {
    const error = createCliWatchdogError();

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it.each([
    {
      name: "provider failure",
      error: new FailoverError("CLI failed", { reason: "server_error" }),
    },
    {
      name: "unmarked transport abort",
      error: Object.assign(new Error("request aborted"), { name: "AbortError" }),
    },
  ])("does not reclassify $name as caller cancellation", ({ error }) => {
    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
  });

  it("reads the final structured timeout from a fallback summary cause", () => {
    const timeout = createCliWatchdogError();
    const error = new FailoverError("All model fallback candidates failed", {
      reason: "timeout",
      cause: timeout,
    });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it.each(["direct", "fallback summary"])(
    "preserves a recorded unphased timeout through %s without inferring a provider phase",
    (wrapper) => {
      const cause = Object.assign(new Error("inner operation exceeded its deadline"), {
        name: "TimeoutError",
      });
      const failure = new FailoverError("Attempt timed out", {
        reason: "timeout",
        timeout: {},
        cause,
      });
      const error =
        wrapper === "direct" ? failure : new Error("Fallback exhausted", { cause: failure });

      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
        stopReason: "timeout",
      });
      expect(resolveCliToolTerminalReason({ error })).toBe("timed_out");
    },
  );

  it.each(["cause", "code"])("contains throwing %s accessors", (property) => {
    const error = Object.defineProperty(new Error("provider failed"), property, {
      get() {
        throw new Error("hostile accessor");
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

  it.each(["timeoutPhase", "providerStarted"])(
    "contains a throwing recorded timeout %s getter",
    (property) => {
      const timeout = Object.defineProperty({}, property, {
        get() {
          throw new Error("hostile timeout metadata");
        },
      });
      const error = new FailoverError("attempt failed", { reason: "timeout", timeout });

      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
    },
  );

  it("preserves explicit cancellation over a concurrent timeout error", () => {
    const controller = new AbortController();
    controller.abort();
    const error = createCliWatchdogError();

    expect(resolveAgentRunErrorLifecycleFields(error, controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });
});
