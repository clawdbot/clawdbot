import { describe, expect, it, vi } from "vitest";
import {
  mapQueueOutcomeToDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";

describe("mapQueueOutcomeToDeliveryResult", () => {
  it("maps steered to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("steered")).toEqual({
      delivered: true,
      path: "steered",
    });
  });

  it("maps queued to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("queued")).toEqual({
      delivered: true,
      path: "queued",
    });
  });

  it("maps none to not-delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("none")).toEqual({
      delivered: false,
      path: "none",
    });
  });
});

describe("runSubagentAnnounceDispatch", () => {
  async function runNonCompletionDispatch(params: {
    queueOutcome: "none" | "queued" | "steered";
    directDelivered?: boolean;
  }) {
    const queue = vi.fn(async () => params.queueOutcome);
    const direct = vi.fn(async () => ({
      delivered: params.directDelivered ?? true,
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      queue,
      direct,
    });
    return { queue, direct, result };
  }

  it("uses queue-first ordering for non-completion mode", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "none" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("short-circuits direct send when non-completion queue delivers", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "queued" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("queued");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: true, path: "queued", error: undefined },
    ]);
  });

  it("uses direct-first ordering for completion mode", async () => {
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("falls back to queue when completion direct send fails", async () => {
    const queue = vi.fn(async () => "steered" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "network",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: false, path: "direct", error: "network" },
      { phase: "queue-fallback", delivered: true, path: "steered", error: undefined },
    ]);
  });

  it("returns direct failure when completion fallback queue cannot deliver", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "failed",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(result.delivered).toBe(false);
    expect(result.path).toBe("direct");
    expect(result.error).toBe("failed");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: false, path: "direct", error: "failed" },
      { phase: "queue-fallback", delivered: false, path: "none", error: undefined },
    ]);
  });

  it("does not fall through to direct delivery when non-completion queue drops the new item", async () => {
    const queue = vi.fn(async () => "dropped" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      queue,
      direct,
    });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [{ phase: "queue-primary", delivered: false, path: "none", error: undefined }],
    });
  });

  it("preserves direct failure when completion dispatch aborts before fallback queue", async () => {
    const controller = new AbortController();
    const queue = vi.fn(async () => "queued" as const);
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
      queue,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
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
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      queue,
      direct,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [],
    });
  });
});
