import { describe, expect, it, vi } from "vitest";
import { broadcastPresenceSnapshot } from "./presence-events.js";

describe("broadcastPresenceSnapshot", () => {
  it("increments version and broadcasts presence with state versions", () => {
    const broadcast = vi.fn();
    const incrementPresenceVersion = vi.fn(() => 7);
    const getHealthVersion = vi.fn(() => 11);

    const presenceVersion = broadcastPresenceSnapshot({
      broadcast,
      incrementPresenceVersion,
      getHealthVersion,
    });

    expect(presenceVersion).toBe(7);
    expect(incrementPresenceVersion).toHaveBeenCalledTimes(1);
    expect(getHealthVersion).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);

    const [event, payload, opts] = broadcast.mock.calls.at(0) as [
      string,
      unknown,
      { dropIfSlow?: boolean; stateVersion?: { presence?: number; health?: number } } | undefined,
    ];

    expect(event).toBe("presence");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("expected object payload");
    }
    expect(Array.isArray((payload as { presence?: unknown }).presence)).toBe(true);
    expect(opts?.dropIfSlow).toBe(true);
    expect(opts?.stateVersion).toEqual({ presence: 7, health: 11 });
  });
});
