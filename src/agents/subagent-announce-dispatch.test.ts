import { describe, expect, it, vi } from "vitest";
import {
  mapSteerOutcomeToDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";

describe("mapSteerOutcomeToDeliveryResult", () => {
  it("maps steered to delivered", () => {
    expect(mapSteerOutcomeToDeliveryResult({ status: "steered" })).toEqual({
      delivered: true,
      path: "steered",
    });
  });

  it("maps none to not-delivered", () => {
    expect(mapSteerOutcomeToDeliveryResult({ status: "none" })).toEqual({
      delivered: false,
      path: "none",
    });
  });
});

describe("runSubagentAnnounceDispatch", () => {
  async function runNonCompletionDispatch(params: {
    steerOutcome: "none" | "steered";
    directDelivered?: boolean;
  }) {
    const steer = vi.fn(async () => ({ status: params.steerOutcome }) as const);
    const direct = vi.fn(async () => ({
      delivered: params.directDelivered ?? true,
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });
    return { steer, direct, result };
  }

  it("uses steer-first ordering for non-completion mode", async () => {
    const { steer, direct, result } = await runNonCompletionDispatch({ steerOutcome: "none" });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "steer-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("short-circuits direct send when non-completion steering delivers", async () => {
    const { steer, direct, result } = await runNonCompletionDispatch({ steerOutcome: "steered" });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "steer-primary", delivered: true, path: "steered", error: undefined },
    ]);
  });

  it("uses direct-first ordering for completion mode", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("falls back to steering when completion direct send fails", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "network",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: false, path: "direct", error: "network" },
      { phase: "steer-fallback", delivered: true, path: "steered", error: undefined },
    ]);
  });

  it("returns direct failure when completion fallback steering cannot deliver", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "failed",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(result.delivered).toBe(false);
    expect(result.path).toBe("direct");
    expect(result.error).toBe("failed");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: false, path: "direct", error: "failed" },
      { phase: "steer-fallback", delivered: false, path: "none", error: undefined },
    ]);
  });

  it("does not fall through to direct delivery when non-completion steering drops the new item", async () => {
    const steer = vi.fn(async () => ({ status: "dropped" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [{ phase: "steer-primary", delivered: false, path: "none", error: undefined }],
    });
  });

  it("preserves direct failure when completion dispatch aborts before fallback steering", async () => {
    const controller = new AbortController();
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => {
      controller.abort();
      return {
        delivered: false,
        path: "direct" as const,
        error: "direct failed before abort",
      };
    });

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(result.delivered).toBe(false);
    expect(result.path).toBe("direct");
    expect(result.error).toBe("direct failed before abort");
    expect(result.phases).toEqual([
      {
        phase: "direct-primary",
        delivered: false,
        path: "direct",
        error: "direct failed before abort",
      },
    ]);
  });

  it("returns none immediately when signal is already aborted", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      steer,
      direct,
    });

    expect(steer).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [],
    });
  });
});
