import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTurnYieldAvailable } from "../plugin-sdk/tool-yield-runtime.js";
import { createTurnYieldController } from "./turn-yield-controller.js";

const markRequesterTurnYielded = vi.hoisted(() => vi.fn());

vi.mock("./subagent-registry.js", () => ({ markRequesterTurnYielded }));

describe("turn yield controller", () => {
  beforeEach(() => {
    markRequesterTurnYielded.mockReset();
  });

  it("commits the first message once and shadows helper authority in the callback", async () => {
    const observed: string[] = [];
    const onYield = vi.fn(async (message: string) => {
      expect(isTurnYieldAvailable()).toBe(false);
      observed.push(message);
    });
    const controller = createTurnYieldController({ sessionId: "session-1", onYield });

    const first = controller.commit(" first ");
    const second = controller.commit("second");

    expect(second).toBe(first);
    await first;
    expect(observed).toEqual(["first"]);
  });

  it("persists requester ownership before invoking the runtime callback", async () => {
    const order: string[] = [];
    markRequesterTurnYielded.mockImplementation(() => {
      order.push("persist");
      return 1;
    });
    const controller = createTurnYieldController({
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
      requesterTurnRunId: "run-1",
      onYield: () => {
        order.push("yield");
      },
    });

    await controller.commit("wait");
    expect(order).toEqual(["persist", "yield"]);
  });

  it("does not call the runtime when durable ownership cannot persist", async () => {
    const failure = new Error("persistence failed");
    markRequesterTurnYielded.mockImplementation(() => {
      throw failure;
    });
    const onYield = vi.fn();
    const controller = createTurnYieldController({
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
      requesterTurnRunId: "run-1",
      onYield,
    });

    await expect(controller.commit("wait")).rejects.toBe(failure);
    expect(onYield).not.toHaveBeenCalled();
  });

  it("retains callback failure and never retries the turn", async () => {
    const failure = new Error("abort failed");
    const onYield = vi.fn(async () => {
      throw failure;
    });
    const controller = createTurnYieldController({ sessionId: "session-1", onYield });

    const first = controller.commit("wait");
    await expect(first).rejects.toBe(failure);
    await expect(controller.commit("retry")).rejects.toBe(failure);
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("bounds native handoff context", async () => {
    const onYield = vi.fn();
    const controller = createTurnYieldController({ sessionId: "session-1", onYield });

    await controller.commit("x".repeat(2_000));

    expect(onYield).toHaveBeenCalledWith("x".repeat(1_000));
  });

  it("fails explicitly without both session and runtime support", async () => {
    const missingSession = createTurnYieldController({ onYield: vi.fn() });
    const missingRuntime = createTurnYieldController({ sessionId: "session-1" });

    expect(missingSession.supported).toBe(false);
    expect(missingRuntime.supported).toBe(false);
    await expect(missingSession.commit("wait")).rejects.toThrow("not supported");
    await expect(missingRuntime.commit("wait")).rejects.toThrow("not supported");
  });
});
