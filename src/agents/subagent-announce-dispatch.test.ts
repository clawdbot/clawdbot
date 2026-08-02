// Subagent announce dispatch tests lock down parent-owned completion routing.
import { describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceDispatch } from "./subagent-announce-dispatch.js";

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

  it("keeps delegation acknowledgement plus child completion on the parent path", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    // The parent may already have emitted an acknowledgement before yielding.
    // A successful wake makes it the sole author of the completion update.
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "steer-primary", delivered: true, path: "steered", error: undefined },
    ]);
  });

  it("does not emit a worker echo after sessions_yield resumes its parent", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    await runSubagentAnnounceDispatch({ expectsCompletionMessage: true, steer, direct });

    expect(direct).not.toHaveBeenCalled();
  });

  it("uses one idempotent transport fallback only when the parent cannot be woken", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "steer-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-fallback", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("does not retry an uncertain fallback transport outcome", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "media send may have partially succeeded",
      terminal: true,
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe("media send may have partially succeeded");
  });

  it("keeps distinct completion updates distinct", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    await runSubagentAnnounceDispatch({ expectsCompletionMessage: true, steer, direct });
    await runSubagentAnnounceDispatch({ expectsCompletionMessage: true, steer, direct });

    expect(steer).toHaveBeenCalledTimes(2);
    expect(direct).not.toHaveBeenCalled();
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

  it("does not fall back to direct delivery when completion dispatch aborts after steering", async () => {
    const controller = new AbortController();
    const steer = vi.fn(async () => {
      controller.abort();
      return { status: "none" } as const;
    });
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
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
