import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastTypingThrottled,
  clearSessionTypingState,
  updateTypingConnections,
} from "./session-typing-state.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  clearSessionTypingState();
});

afterEach(() => {
  clearSessionTypingState();
  vi.useRealTimers();
});

describe("session typing connection state", () => {
  it("retains the newest live preview across an actor's connections", () => {
    const key = "shared-preview";

    expect(
      updateTypingConnections({
        key,
        connectionId: "preview-tab",
        typing: true,
        preview: "first draft",
        now: 10_000,
      }),
    ).toEqual({ typing: true, preview: "first draft" });
    expect(
      updateTypingConnections({
        key,
        connectionId: "presence-tab",
        typing: true,
        now: 10_100,
      }),
    ).toEqual({ typing: true, preview: "first draft" });
    expect(
      updateTypingConnections({
        key,
        connectionId: "presence-tab",
        typing: true,
        preview: "newer draft",
        now: 10_200,
      }),
    ).toEqual({ typing: true, preview: "newer draft" });
  });

  it("removes a stopped connection's preview while preserving another connection's liveness", () => {
    const key = "stopped-preview";

    updateTypingConnections({
      key,
      connectionId: "preview-tab",
      typing: true,
      preview: "draft",
      now: 10_000,
    });
    updateTypingConnections({
      key,
      connectionId: "presence-tab",
      typing: true,
      now: 10_100,
    });

    expect(
      updateTypingConnections({
        key,
        connectionId: "preview-tab",
        typing: false,
        now: 10_200,
      }),
    ).toEqual({ typing: true });
    expect(
      updateTypingConnections({
        key,
        connectionId: "presence-tab",
        typing: false,
        now: 10_300,
      }),
    ).toEqual({ typing: false });
    expect(
      updateTypingConnections({
        key,
        connectionId: "missing-tab",
        typing: false,
        now: 10_400,
      }),
    ).toEqual({ typing: false });
  });

  it("expires stale previews while a refreshed boolean-only connection remains live", () => {
    const key = "expired-preview";

    updateTypingConnections({
      key,
      connectionId: "preview-tab",
      typing: true,
      preview: "expired draft",
      now: 10_000,
    });
    updateTypingConnections({
      key,
      connectionId: "presence-tab",
      typing: true,
      now: 11_000,
    });

    expect(
      updateTypingConnections({
        key,
        connectionId: "presence-tab",
        typing: true,
        now: 12_500,
      }),
    ).toEqual({ typing: true });
  });
});

describe("session typing broadcast throttle", () => {
  it("broadcasts a changed preview while the actor remains typing", () => {
    const emit = vi.fn(() => true);
    const broadcast = (preview: string) =>
      broadcastTypingThrottled({
        key: "preview-change",
        typing: true,
        signature: `true\0${preview}`,
        intervalMs: 250,
        now: Date.now(),
        emit,
      });

    expect(broadcast("first")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(broadcast("second")).toBe(false);
    vi.advanceTimersByTime(150);

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "draft previews", intervalMs: 250, signature: "true\0draft" },
    { label: "boolean-only presence", intervalMs: 1_000, signature: "true\0" },
  ])("throttles $label at $intervalMs ms", ({ intervalMs, signature }) => {
    const emit = vi.fn(() => true);
    const broadcast = () =>
      broadcastTypingThrottled({
        key: signature,
        typing: true,
        signature,
        intervalMs,
        now: Date.now(),
        emit,
      });

    broadcast();
    vi.advanceTimersByTime(25);
    broadcast();
    vi.advanceTimersByTime(intervalMs - 26);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("emits only the latest draft at the trailing edge of a burst", () => {
    const previews: string[] = [];
    const broadcast = (preview: string) =>
      broadcastTypingThrottled({
        key: "preview-burst",
        typing: true,
        signature: `true\0${preview}`,
        intervalMs: 250,
        now: Date.now(),
        emit: () => {
          previews.push(preview);
          return true;
        },
      });

    broadcast("first");
    vi.advanceTimersByTime(50);
    broadcast("second");
    vi.advanceTimersByTime(50);
    broadcast("latest");
    vi.advanceTimersByTime(150);

    expect(previews).toEqual(["first", "latest"]);
  });

  it("preserves boolean-only cancellation and trailing stop behavior", () => {
    const updates: boolean[] = [];
    const broadcast = (typing: boolean) =>
      broadcastTypingThrottled({
        key: "boolean-only",
        typing,
        signature: `${typing}\0`,
        intervalMs: 1_000,
        now: Date.now(),
        emit: () => {
          updates.push(typing);
          return true;
        },
      });

    broadcast(true);
    vi.advanceTimersByTime(100);
    broadcast(false);
    vi.advanceTimersByTime(100);
    broadcast(true);
    vi.advanceTimersByTime(800);
    expect(updates).toEqual([true, true]);

    vi.advanceTimersByTime(100);
    broadcast(false);
    vi.advanceTimersByTime(900);
    expect(updates).toEqual([true, true, false]);
  });
});
