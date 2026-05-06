import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayHeartbeatTimers } from "./gateway-lifecycle.js";

describe("GatewayHeartbeatTimers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not false-timeout when the first heartbeat fires near the interval boundary", () => {
    vi.useFakeTimers();

    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();
    const isAcked = vi.fn().mockReturnValue(false);
    const timers = new GatewayHeartbeatTimers();

    timers.start({
      intervalMs: 45_000,
      isAcked,
      onAckTimeout,
      onHeartbeat,
      random: () => 0.95,
    });

    vi.advanceTimersByTime(42_750);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onAckTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_250);
    expect(onAckTimeout).not.toHaveBeenCalled();

    isAcked.mockReturnValue(true);
    vi.advanceTimersByTime(42_750);
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
    expect(onAckTimeout).not.toHaveBeenCalled();

    timers.stop();
  });

  it("fires an ACK timeout when a heartbeat is genuinely not acknowledged", () => {
    vi.useFakeTimers();

    const timers = new GatewayHeartbeatTimers();
    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();

    timers.start({
      intervalMs: 45_000,
      isAcked: () => false,
      onAckTimeout,
      onHeartbeat,
      random: () => 0,
    });

    vi.advanceTimersByTime(0);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(45_000);
    expect(onAckTimeout).toHaveBeenCalledTimes(1);

    timers.stop();
  });

  it("sends heartbeats at regular intervals after the initial random delay", () => {
    vi.useFakeTimers();

    const timers = new GatewayHeartbeatTimers();
    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();

    timers.start({
      intervalMs: 10_000,
      isAcked: () => true,
      onAckTimeout,
      onHeartbeat,
      random: () => 0.5,
    });

    vi.advanceTimersByTime(5_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(3);
    expect(onAckTimeout).not.toHaveBeenCalled();

    timers.stop();
  });

  it("stop cancels all pending timers", () => {
    vi.useFakeTimers();

    const timers = new GatewayHeartbeatTimers();
    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();

    timers.start({
      intervalMs: 10_000,
      isAcked: () => true,
      onAckTimeout,
      onHeartbeat,
      random: () => 0.5,
    });

    timers.stop();
    vi.advanceTimersByTime(100_000);

    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onAckTimeout).not.toHaveBeenCalled();
  });
});
