// @vitest-environment node
// Channel wizard controller: step/answer state machine over wizard.* RPCs.
import { describe, expect, it, vi } from "vitest";
import { ChannelWizardController } from "./wizard-controller.ts";

type RequestHandler = (method: string, params?: unknown) => Promise<unknown>;

function createController(handler: RequestHandler) {
  const request = vi.fn(handler);
  const onChange = vi.fn();
  const controller = new ChannelWizardController(() => ({ request: request as never }), onChange);
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
        message: "Error: wizard request timed out: wizard.start",
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
