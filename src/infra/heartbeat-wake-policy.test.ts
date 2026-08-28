import { isTargetedUnscheduledWake, HeartbeatWakeIntent } from "./heartbeat-wake-policy";

describe("isTargetedUnscheduledWake", () => {
  const mockParams: Partial<Parameters<typeof isTargetedUnscheduledWake>[0]> = {
    source: undefined,
    intent: undefined,
    reason: undefined,
    agentId: undefined,
    sessionKey: undefined,
  };

  const baseParams = (overrides: Partial<typeof mockParams> = {}) =>
    ({ ...mockParams, ...overrides } as Parameters<typeof isTargetedUnscheduledWake>[0]);

  describe("restart-sentinel source", () => {
    it("returns true for immediate intent, session target, and wake reason", () => {
      const params = baseParams({
        source: "restart-sentinel",
        intent: "immediate" as HeartbeatWakeIntent,
        reason: "wake",
        sessionKey: "test-session",
      });

      expect(isTargetedUnscheduledWake(params)).toBe(true);
    });

    it("returns false for non-immediate intent", () => {
      const params = baseParams({
        source: "restart-sentinel",
        intent: "event" as HeartbeatWakeIntent,
        reason: "wake",
        sessionKey: "test-session",
      });

      expect(isTargetedUnscheduledWake(params)).toBe(false);
    });

    it("returns false for missing sessionKey", () => {
      const params = baseParams({
        source: "restart-sentinel",
        intent: "immediate" as HeartbeatWakeIntent,
        reason: "wake",
        agentId: "test-agent", // using agentId instead
      });

      expect(isTargetedUnscheduledWake(params)).toBe(false);
    });

    it("returns false for non-wake reason", () => {
      const params = baseParams({
        source: "restart-sentinel",
        intent: "immediate" as HeartbeatWakeIntent,
        reason: "something-else",
        sessionKey: "test-session",
      });

      expect(isTargetedUnscheduledWake(params)).toBe(false);
    });
  });

  describe("preserving existing behavior", () => {
    it("still works for notifications-event", () => {
      const params = baseParams({
        source: "notifications-event",
        intent: "immediate" as HeartbeatWakeIntent,
        reason: "wake",
        sessionKey: "test-session",
      });

      expect(isTargetedUnscheduledWake(params)).toBe(true);
    });

    it("still works for hook", () => {
      const params = baseParams({
        source: "hook",
        intent: "immediate" as HeartbeatWakeIntent,
        reason: "hook:something",
      });

      expect(isTargetedUnscheduledWake(params)).toBe(true);
    });

    it("still works for exec-event", () => {
      const params = baseParams({
        source: "exec-event",
        intent: "event" as HeartbeatWakeIntent,
        reason: "exec-event",
      });

      expect(isTargetedUnscheduledWake(params)).toBe(true);
    });

    it("still works for background-task", () => {
      const params = baseParams({
        source: "background-task",
        intent: "immediate" as HeartbeatWakeIntent,
      });

      expect(isTargetedUnscheduledWake(params)).toBe(true);
    });
  });
});