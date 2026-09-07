// @vitest-environment node
// Channel wizard controller: step/answer state machine over wizard.* RPCs.
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { ChannelWizardController } from "./wizard-controller.ts";

type RequestHandler = (
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number | null; signal?: AbortSignal },
) => Promise<unknown>;

function createController(handler: RequestHandler) {
  const request = vi.fn(handler);
  const onChange = vi.fn();
  const controller = new ChannelWizardController(
    () => ({ request: request as never }),
    onChange,
    () => false,
    () => "Setup expired. Close and restart setup.",
  );
  return { controller, request, onChange };
}

const selectStep = {
  id: "step-select",
  type: "select" as const,
  message: "Which channel?",
  options: [{ value: "telegram", label: "Telegram" }],
};

const tokenStep = {
  id: "step-token",
  type: "text" as const,
  message: "Paste token",
  sensitive: true,
};

describe("ChannelWizardController", () => {
  it("walks start → step → answer → done", async () => {
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      if (method === "wizard.next") {
        return {
          done: true,
          status: "done",
          channels: ["telegram"],
          accounts: [{ channel: "telegram", accountId: "default" }],
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    await controller.start("telegram");
    expect(controller.state).toMatchObject({
      phase: "step",
      channel: "telegram",
      step: { id: "step-select" },
      busy: false,
    });
    expect(request).toHaveBeenCalledWith("wizard.start", {
      flow: "channels",
      channel: "telegram",
    });

    await controller.answer("telegram");
    expect(controller.state).toEqual({
      phase: "done",
      channel: "telegram",
      channels: ["telegram"],
      accounts: [{ channel: "telegram", accountId: "default" }],
    });
    expect(request).toHaveBeenCalledWith("wizard.next", {
      sessionId: "s1",
      answer: { stepId: "step-select", value: "telegram" },
    });
  });

  it("does not treat a colliding owner selection as the channel presentation", async () => {
    let nextCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "wizard.start") {
        return {
          sessionId: "s-owner-collision",
          done: false,
          status: "running",
          step: {
            id: "step-owner",
            type: "select" as const,
            message: "Set up channels for agent",
            options: [
              { value: { agentId: "telegram" }, label: "telegram" },
              { value: { agentId: "helper" }, label: "helper" },
            ],
          },
        };
      }
      if (method !== "wizard.next") {
        throw new Error(`unexpected ${method}`);
      }
      nextCount += 1;
      if (nextCount === 1) {
        return {
          done: false,
          status: "running",
          step: {
            id: "step-channel",
            type: "select" as const,
            message: "Select channels",
            options: [{ value: "discord", label: "Discord" }],
          },
        };
      }
      return {
        done: true,
        status: "done",
        channels: ["discord"],
        accounts: [{ channel: "discord", accountId: "default" }],
      };
    });
    const controller = new ChannelWizardController(
      () => ({ request: request as never }),
      vi.fn(),
      (value) => value === "telegram" || value === "discord",
      () => "Setup expired. Close and restart setup.",
    );

    await controller.start(null);
    await controller.answer({ agentId: "telegram" });
    await controller.answer("discord");

    expect(controller.state).toEqual({
      phase: "done",
      channel: "discord",
      channels: ["discord"],
      accounts: [{ channel: "discord", accountId: "default" }],
    });
  });

  it("advances gateway-owned progress without inventing user answers", async () => {
    let resolveProgress: ((value: unknown) => void) | undefined;
    let nextCount = 0;
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return {
          sessionId: "s-progress",
          done: false,
          status: "running",
          step: { id: "progress-1", type: "progress", executor: "gateway", message: "Starting" },
        };
      }
      if (method !== "wizard.next") {
        throw new Error(`unexpected ${method}`);
      }
      nextCount += 1;
      if (nextCount === 1) {
        return await new Promise((resolve) => {
          resolveProgress = resolve;
        });
      }
      if (nextCount === 2) {
        return { done: false, status: "running", step: tokenStep };
      }
      if (nextCount === 3) {
        return {
          done: false,
          status: "running",
          step: { id: "progress-3", type: "progress", executor: "gateway", message: "Finishing" },
        };
      }
      return { done: true, status: "done", channels: ["telegram"], accounts: [] };
    });

    await controller.start("telegram");
    expect(controller.state).toMatchObject({
      phase: "step",
      step: { id: "progress-1", executor: "gateway" },
      busy: true,
    });
    expect(request).toHaveBeenLastCalledWith(
      "wizard.next",
      { sessionId: "s-progress" },
      { timeoutMs: null, signal: expect.any(AbortSignal) },
    );

    await controller.answer(null);
    expect(nextCount).toBe(1);

    resolveProgress?.({
      done: false,
      status: "running",
      step: { id: "progress-2", type: "progress", executor: "gateway", message: "Downloading" },
    });
    await vi.waitFor(() => {
      expect(controller.state).toMatchObject({ phase: "step", step: { id: "step-token" } });
    });

    await controller.answer("secret-token");
    await vi.waitFor(() => {
      expect(controller.state).toMatchObject({ phase: "done", channels: ["telegram"] });
    });

    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toEqual([
      [
        "wizard.next",
        { sessionId: "s-progress" },
        { timeoutMs: null, signal: expect.any(AbortSignal) },
      ],
      [
        "wizard.next",
        { sessionId: "s-progress" },
        { timeoutMs: null, signal: expect.any(AbortSignal) },
      ],
      [
        "wizard.next",
        { sessionId: "s-progress", answer: { stepId: "step-token", value: "secret-token" } },
      ],
      [
        "wizard.next",
        { sessionId: "s-progress" },
        { timeoutMs: null, signal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it("keeps a gateway-owned progress poll alive beyond the bounded request ceiling", async () => {
    vi.useFakeTimers();
    try {
      let resolveProgress: ((value: unknown) => void) | undefined;
      let progressSignal: AbortSignal | undefined;
      const { controller, request } = createController(async (method, _params, options) => {
        if (method === "wizard.start") {
          return {
            sessionId: "s-long-progress",
            done: false,
            status: "running",
            step: { id: "long-progress", type: "progress", executor: "gateway" },
          };
        }
        if (method === "wizard.next") {
          progressSignal = options?.signal;
          return await new Promise((resolve) => {
            resolveProgress = resolve;
          });
        }
        throw new Error(`unexpected ${method}`);
      });

      await controller.start("telegram");
      await vi.advanceTimersByTimeAsync(120_001);

      expect(controller.state).toMatchObject({
        phase: "step",
        step: { id: "long-progress", executor: "gateway" },
        busy: true,
      });
      expect(progressSignal?.aborted).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toEqual([
        [
          "wizard.next",
          { sessionId: "s-long-progress" },
          { timeoutMs: null, signal: expect.any(AbortSignal) },
        ],
      ]);

      resolveProgress?.({
        done: true,
        status: "done",
        channels: ["telegram"],
        accounts: [{ channel: "telegram", accountId: "work" }],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.state).toEqual({
        phase: "done",
        channel: "telegram",
        channels: ["telegram"],
        accounts: [{ channel: "telegram", accountId: "work" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a gateway progress response after the wizard is cancelled", async () => {
    let resolveProgress: ((value: unknown) => void) | undefined;
    let progressSignal: AbortSignal | undefined;
    const { controller, request, onChange } = createController(async (method, _params, options) => {
      if (method === "wizard.start") {
        return {
          sessionId: "s-progress-cancel",
          done: false,
          status: "running",
          step: { id: "progress", type: "progress", executor: "gateway" },
        };
      }
      if (method === "wizard.next") {
        progressSignal = options?.signal;
        return await new Promise((resolve) => {
          resolveProgress = resolve;
        });
      }
      return { status: "cancelled" };
    });

    await controller.start("telegram");
    await controller.cancel();
    const changeCountAfterCancel = onChange.mock.calls.length;
    resolveProgress?.({ done: false, status: "running", step: tokenStep });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.state).toEqual({ phase: "idle" });
    expect(progressSignal?.aborted).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(changeCountAfterCancel);
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "s-progress-cancel" });
  });

  it("reports an expired gateway progress session without fabricating an answer", async () => {
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return {
          sessionId: "s-progress-expired",
          done: false,
          status: "running",
          step: { id: "progress", type: "progress", executor: "gateway" },
        };
      }
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "wizard not found",
        details: { code: "WIZARD_NOT_FOUND" },
      });
    });

    await controller.start("telegram");
    await vi.waitFor(() => {
      expect(controller.state).toEqual({
        phase: "error",
        channel: "telegram",
        message: "Setup expired. Close and restart setup.",
      });
    });
    expect(request).toHaveBeenLastCalledWith(
      "wizard.next",
      { sessionId: "s-progress-expired" },
      { timeoutMs: null, signal: expect.any(AbortSignal) },
    );
  });

  it("surfaces validation errors on the re-emitted step", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: tokenStep };
      }
      return {
        done: false,
        status: "running",
        step: tokenStep,
        error: "Token looks invalid.",
      };
    });

    await controller.start("telegram");
    await controller.answer("nope");
    expect(controller.state).toMatchObject({
      phase: "step",
      validationError: "Token looks invalid.",
      busy: false,
    });
  });

  it("clears an expired session without cancelling, restarting, or replaying the answer", async () => {
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s-expired", done: false, status: "running", step: tokenStep };
      }
      if (method === "wizard.next") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "wizard not found",
          details: { code: "WIZARD_NOT_FOUND" },
        });
      }
      if (method === "wizard.cancel") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected ${method}`);
    });

    await controller.start("telegram");
    await controller.answer("secret-token");

    expect(controller.state).toEqual({
      phase: "error",
      channel: "telegram",
      message: "Setup expired. Close and restart setup.",
    });
    await controller.cancel();
    expect(request.mock.calls.filter(([method]) => method === "wizard.start")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
  });

  it("keeps generic request errors cancellable", async () => {
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s-failed", done: false, status: "running", step: tokenStep };
      }
      if (method === "wizard.next") {
        throw new Error("wizard unavailable");
      }
      if (method === "wizard.cancel") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected ${method}`);
    });

    await controller.start("telegram");
    await controller.answer("token");
    expect(controller.state).toEqual({
      phase: "error",
      channel: "telegram",
      message: "wizard unavailable",
    });

    await controller.cancel();
    expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([
      ["wizard.cancel", { sessionId: "s-failed" }],
    ]);
  });

  it("maps runner failures to the error phase", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: true, status: "error", error: "config invalid" };
      }
      throw new Error(`unexpected ${method}`);
    });

    await controller.start(null);
    expect(controller.state).toEqual({
      phase: "error",
      channel: null,
      message: "config invalid",
    });
  });

  it("cancels a stale in-flight start so the gateway session is not leaked", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    const cancelled: unknown[] = [];
    const { controller } = createController(async (method, params) => {
      if (method === "wizard.start") {
        return await new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      if (method === "wizard.cancel") {
        cancelled.push((params as { sessionId?: string }).sessionId);
        return { status: "cancelled" };
      }
      throw new Error(`unexpected ${method}`);
    });

    const start = controller.start("telegram");
    await Promise.resolve();
    await controller.cancel();
    resolveStart({ sessionId: "s-stale", done: false, status: "running", step: selectStep });
    await start;
    await Promise.resolve();
    expect(controller.state).toEqual({ phase: "idle" });
    expect(cancelled).toContain("s-stale");
  });

  it("cancels a session created after a local start timeout so retry can proceed", async () => {
    vi.useFakeTimers();
    try {
      let resolveFirstStart: (value: unknown) => void = () => {};
      let runningSession: string | null = null;
      let startCount = 0;
      const { controller, request } = createController(async (method, params) => {
        if (method === "wizard.start") {
          startCount += 1;
          if (startCount === 1) {
            runningSession = "s-timeout";
            return await new Promise((resolve) => {
              resolveFirstStart = resolve;
            });
          }
          if (runningSession) {
            throw new Error("wizard already running");
          }
          return { sessionId: "s-retry", done: false, status: "running", step: selectStep };
        }
        if (method === "wizard.cancel") {
          const sessionId = (params as { sessionId?: string }).sessionId;
          if (sessionId === runningSession) {
            runningSession = null;
          }
          return { status: "cancelled" };
        }
        throw new Error(`unexpected ${method}`);
      });

      const timedOutStart = controller.start("telegram");
      await vi.advanceTimersByTimeAsync(120_000);
      await timedOutStart;
      expect(controller.state).toMatchObject({
        phase: "error",
        message: "wizard request timed out: wizard.start",
      });

      resolveFirstStart({
        sessionId: "s-timeout",
        done: false,
        status: "running",
        step: selectStep,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "s-timeout" });
      expect(runningSession).toBeNull();

      await controller.start("telegram");
      expect(startCount).toBe(2);
      expect(controller.state).toMatchObject({
        phase: "step",
        step: { id: "step-select" },
        busy: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cancel a terminal start result that arrives after the local timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveStart: (value: unknown) => void = () => {};
      const { controller, request } = createController(async (method) => {
        if (method === "wizard.start") {
          return await new Promise((resolve) => {
            resolveStart = resolve;
          });
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        throw new Error(`unexpected ${method}`);
      });

      const timedOutStart = controller.start("telegram");
      await vi.advanceTimersByTimeAsync(120_000);
      await timedOutStart;

      resolveStart({ sessionId: "s-done", done: true, status: "done" });
      await Promise.resolve();
      await Promise.resolve();

      expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the gateway-reported channels for completion", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return {
        done: true,
        status: "done",
        channels: ["telegram", "whatsapp"],
        accounts: [
          { channel: "telegram", accountId: "default" },
          { channel: "whatsapp", accountId: "work" },
        ],
      };
    });

    await controller.start(null);
    await controller.answer("whatsapp");
    expect(controller.state).toEqual({
      phase: "done",
      channel: "telegram",
      channels: ["telegram", "whatsapp"],
      accounts: [
        { channel: "telegram", accountId: "default" },
        { channel: "whatsapp", accountId: "work" },
      ],
    });
  });

  it("reports no channels when the flow ends without configuring any", async () => {
    const { controller } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return { done: true, status: "done" };
    });

    await controller.start("whatsapp");
    await controller.answer("__skip__");
    expect(controller.state).toEqual({
      phase: "done",
      channel: "whatsapp",
      channels: [],
      accounts: [],
    });
  });

  it("cancel clears the session and notifies the gateway", async () => {
    const calls: string[] = [];
    const { controller } = createController(async (method) => {
      calls.push(method);
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return { status: "cancelled" };
    });

    await controller.start("slack");
    await controller.cancel();
    expect(controller.state).toEqual({ phase: "idle" });
    expect(calls).toContain("wizard.cancel");
  });

  it("ignores answers while a previous answer is in flight", async () => {
    let resolveNext: (value: unknown) => void = () => {};
    const { controller, request } = createController(async (method) => {
      if (method === "wizard.start") {
        return { sessionId: "s1", done: false, status: "running", step: selectStep };
      }
      return await new Promise((resolve) => {
        resolveNext = resolve;
      });
    });

    await controller.start("telegram");
    const first = controller.answer("telegram");
    await Promise.resolve();
    await controller.answer("again");
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
    resolveNext({
      done: true,
      status: "done",
      channels: ["telegram"],
      accounts: [{ channel: "telegram", accountId: "default" }],
    });
    await first;
    expect(controller.state).toEqual({
      phase: "done",
      channel: "telegram",
      channels: ["telegram"],
      accounts: [{ channel: "telegram", accountId: "default" }],
    });
  });
});
