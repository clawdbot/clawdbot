import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { createCliOutputFailoverError } from "./cli-runner/output-error.js";
import {
  FailoverError,
  findCliTerminalStopError,
  findCliTimeoutError,
  recordModelFallbackStop,
  resolveModelFallbackError,
} from "./failover-error.js";
import { AgentHarnessPreflightError, recordAgentHarnessPreflightOwner } from "./harness/errors.js";
import {
  type ModelFallbackStepHandler,
  runFallbackAttempt,
  shouldDiscardDeferredSessionSuspension,
} from "./model-fallback-attempt.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "./run-termination.js";

const { providerHook } = vi.hoisted(() => ({
  providerHook: vi.fn<() => "overloaded" | undefined>(),
}));

vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: providerHook,
}));

beforeEach(() => {
  providerHook.mockReset().mockImplementation(() => {
    throw new Error("unexpected provider policy consultation");
  });
});

function maxTurns() {
  return new FailoverError("recorded terminal stop", { reason: "unknown", code: "cli_max_turns" });
}

const terminalStops = [
  { name: "max turns", make: maxTurns },
  {
    name: "CLI turn stopped",
    make: () =>
      new FailoverError("recorded turn stop", { reason: "unknown", code: "cli_turn_stopped" }),
  },
  {
    name: "failed owned cleanup",
    make: () => {
      const error = Object.freeze(
        new FailoverError("provider auth failure", { reason: "auth", status: 401 }),
      );
      recordModelFallbackStop(error);
      return error;
    },
  },
];

const fallbackOptions = {
  cfg: undefined,
  provider: "fixture-provider",
  model: "fixture-model",
  manifestPlugins: [],
  fallbacksOverride: ["fixture-next/fixture-model"],
};

it("does not replay an unscoped preflight subclass on another model", async () => {
  class PolicyRefusal extends AgentHarnessPreflightError {}
  const error = new PolicyRefusal("handoff refused", {
    cause: new FailoverError("529 overloaded", { reason: "overloaded", status: 529 }),
  });
  const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("unexpected fallback");
  await expect(runWithModelFallback({ ...fallbackOptions, run })).rejects.toBe(error);
  expect(run).toHaveBeenCalledOnce();
  expect(providerHook).not.toHaveBeenCalled();
});

const wrappers = [
  { name: "direct", wrap: (error: FailoverError): unknown => error },
  { name: "error", wrap: (error: FailoverError): unknown => ({ error }) },
  {
    name: "cause",
    wrap: (error: FailoverError): unknown => new Error("wrapper", { cause: error }),
  },
  {
    name: "aggregate",
    wrap: (error: FailoverError): unknown =>
      new AggregateError([error, new Error("persistence failed")], "wrapper"),
  },
  {
    name: "cyclic",
    wrap: (error: FailoverError): unknown => {
      const wrapper = { message: "wrapper", cause: undefined as unknown, errors: [{ error }] };
      wrapper.cause = wrapper;
      return wrapper;
    },
  },
  {
    name: "preflight",
    wrap: (error: FailoverError): unknown =>
      new AgentHarnessPreflightError("wrapper", { cause: error }),
  },
];

it.each(
  wrappers.flatMap((wrapper) =>
    terminalStops.map((stop) => ({ ...wrapper, stop: stop.name, make: stop.make })),
  ),
)("does not replay $stop through a $name wrapper", async ({ wrap, make }) => {
  const error = wrap(make());
  expect(resolveModelFallbackError(error)).toEqual({ kind: "terminal", error });
  const run = vi.fn().mockRejectedValue(error);
  const onError = vi.fn();
  await expect(runWithModelFallback({ ...fallbackOptions, run, onError })).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  expect(providerHook).not.toHaveBeenCalled();
});

it("does not consult context policy for provider-looking text around a terminal stop", () => {
  const error = new Error("model maximum reached in wrapper", { cause: maxTurns() });
  expect(shouldDiscardDeferredSessionSuspension({ error })).toBe(false);
  expect(providerHook).not.toHaveBeenCalled();
});

it("records a CLI max-turn stop before provider policy can replace it with a retryable error", async () => {
  const run = vi.fn(async () => {
    const error = createCliOutputFailoverError({
      output: {
        text: "",
        errorText: "Reached maximum number of turns (1)",
        terminalFailure: { reason: "max_turns", limit: 1 },
      },
      provider: "fixture-provider",
      model: "fixture-model",
    });
    assert(error instanceof FailoverError);
    throw error;
  });
  await expect(
    runWithModelFallback({
      ...fallbackOptions,
      run,
    }),
  ).rejects.toMatchObject({ code: "cli_max_turns", reason: "unknown" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(providerHook).not.toHaveBeenCalled();
});

it("honors cancellation before advancing past a captured harness preflight failure", async () => {
  const controller = new AbortController();
  const error = new AgentHarnessPreflightError("harness failed after cancellation", {
    scope: "harness",
  });
  recordAgentHarnessPreflightOwner(error, "fixture-harness");
  const run = vi.fn(async () => {
    controller.abort();
    throw error;
  });
  const onError = vi.fn();
  await expect(
    runWithModelFallback({
      ...fallbackOptions,
      abortSignal: controller.signal,
      run,
      onError,
    }),
  ).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  expect(providerHook).not.toHaveBeenCalled();
});

it("honors cancellation in the failure callback before starting another candidate", async () => {
  const controller = new AbortController();
  const cancellation = new Error("caller canceled between attempts");
  const run = vi
    .fn()
    .mockRejectedValueOnce(new FailoverError("provider overloaded", { reason: "overloaded" }))
    .mockResolvedValueOnce("unexpected fallback");
  const onError = vi.fn(() => {
    controller.abort(cancellation);
  });
  await expect(
    runWithModelFallback({
      ...fallbackOptions,
      abortSignal: controller.signal,
      run,
      onError,
    }),
  ).rejects.toBe(cancellation);
  expect(run).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(providerHook).not.toHaveBeenCalled();
});

it.each(["throw", "reject"] as const)(
  "preserves recovery when its fallback observer fails by %s",
  async (observerFailure) => {
    const observerError = new Error("fallback observer failed");
    const run = vi
      .fn()
      .mockRejectedValueOnce(new FailoverError("provider overloaded", { reason: "overloaded" }))
      .mockResolvedValueOnce("recovered");
    const onError = vi.fn();
    const onFallbackStep = vi.fn<ModelFallbackStepHandler>(() => {
      if (observerFailure === "throw") {
        throw observerError;
      }
      return Promise.reject(observerError);
    });
    await expect(
      runWithModelFallback({ ...fallbackOptions, run, onError, onFallbackStep }),
    ).resolves.toMatchObject({ outcome: "completed", result: "recovered" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onFallbackStep.mock.calls.map(([step]) => step.fallbackStepFinalOutcome)).toEqual([
      "next_fallback",
      "succeeded",
    ]);
  },
);

it.each(terminalStops)(
  "does not replay $name returned by result classification",
  async ({ make }) => {
    const error = new AggregateError([make()], "wrapper");
    const run = vi.fn().mockResolvedValue("partial result");
    const onError = vi.fn();
    await expect(
      runWithModelFallback({
        ...fallbackOptions,
        run,
        onError,
        classifyResult: () => ({ error }),
      }),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(providerHook).not.toHaveBeenCalled();
  },
);

it.each(terminalStops)("stops image fallback after $name", async ({ make }) => {
  const error = new AggregateError([make()], "wrapper");
  const run = vi.fn().mockRejectedValue(error);
  await expect(
    runWithImageModelFallback({
      cfg: {
        agents: {
          defaults: {
            imageModel: {
              primary: "fixture-provider/fixture-model",
              fallbacks: ["fixture-next/fixture-model"],
            },
          },
        },
      },
      run,
    }),
  ).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
  expect(providerHook).not.toHaveBeenCalled();
});

it.each(["caller signal", "direct abort", "restart abort"])(
  "honors %s before provider consultation",
  async (kind) => {
    const controller = new AbortController();
    const error =
      kind === "direct abort"
        ? createAgentRunDirectAbortError()
        : kind === "restart abort"
          ? createAgentRunRestartAbortError()
          : new Error("fixture failure");
    if (kind === "caller signal") {
      controller.abort();
    }
    await expect(
      runFallbackAttempt({
        run: async () => {
          throw error;
        },
        provider: "fixture-provider",
        model: "fixture-model",
        attempts: [],
        attempt: 1,
        total: 2,
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(error);
    expect(shouldDiscardDeferredSessionSuspension({ error, abortSignal: controller.signal })).toBe(
      true,
    );
    expect(providerHook).not.toHaveBeenCalled();
  },
);

it("still classifies a genuine provider failure through its hook", async () => {
  providerHook.mockReturnValue("overloaded");
  const result = await runFallbackAttempt({
    run: async () => {
      throw new Error("fixture provider refusal");
    },
    provider: "fixture-provider",
    model: "fixture-model",
    attempts: [],
    attempt: 1,
    total: 2,
  });
  expect(result).toMatchObject({
    error: {
      name: "FailoverError",
      reason: "overloaded",
      provider: "fixture-provider",
      model: "fixture-model",
    },
  });
  expect(providerHook).toHaveBeenCalledTimes(1);
});

it.each(terminalStops)("preserves coordination precedence over $name", ({ make }) => {
  const error = new AggregateError([make(), new GatewayDrainingError()], "wrapper");
  expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
  expect(shouldDiscardDeferredSessionSuspension({ error })).toBe(true);
  expect(providerHook).not.toHaveBeenCalled();
});

describe.each([
  { name: "max turns", find: findCliTerminalStopError, make: maxTurns },
  {
    name: "CLI timeout",
    find: findCliTimeoutError,
    make: () =>
      new FailoverError("timeout", {
        reason: "timeout",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 1,
          observedActivity: true,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      }),
  },
])("$name finder", ({ find, make }) => {
  it("preserves depth-first error, cause, then aggregate order through cycles", () => {
    const first = make();
    const second = make();
    const third = make();
    const wrapper = { error: { cause: first }, cause: second, errors: [third] };
    expect(find(wrapper)).toBe(first);
    const cycle = { error: undefined as unknown, cause: wrapper, errors: [third] };
    cycle.error = cycle;
    expect(find(cycle)).toBe(first);
    expect(find({ cause: null, errors: [null, { error: third }] })).toBe(third);
  });
});
