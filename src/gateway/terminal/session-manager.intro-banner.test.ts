import { describe, expect, it, vi } from "vitest";
import { composeTerminalIntroBanner } from "./intro-banner.js";
import { TerminalSessionManager } from "./session-manager.js";
import { baseOpenRequest, makeFakePty } from "./session-manager.test-helpers.js";

describe("TerminalSessionManager intro banner", () => {
  it("seeds only fresh operator sessions and delivers the intro to the opening client", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const manager = new TerminalSessionManager({ emit, spawn: async () => makeFakePty() });
    try {
      const operator = await manager.open(baseOpenRequest());
      if (!operator.ok) {
        throw new Error("expected operator open");
      }
      const intro = composeTerminalIntroBanner();
      expect(manager.snapshot(operator.sessionId)).toBe(intro);

      await vi.advanceTimersByTimeAsync(4);
      expect(emit).toHaveBeenCalledWith("conn-1", "terminal.data", {
        sessionId: operator.sessionId,
        seq: intro.length,
        data: intro,
      });

      emit.mockClear();
      const agent = await manager.open(
        baseOpenRequest({ owner: { kind: "agent", agentSessionKey: "agent:main:main" } }),
      );
      if (!agent.ok) {
        throw new Error("expected agent open");
      }
      expect(manager.snapshotAgent("agent:main:main", agent.sessionId)).toBe("");
      await vi.advanceTimersByTimeAsync(4);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      manager.disposeAll();
      vi.useRealTimers();
    }
  });
});
