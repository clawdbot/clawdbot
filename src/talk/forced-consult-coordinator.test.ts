import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { createRealtimeVoiceForcedConsultCoordinator } from "./forced-consult-coordinator.js";

describe("realtime voice forced consult coordinator", () => {
  it("runs a delayed pending consult unless a native consult arrives first", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const run = vi.fn();
      const pending = coordinator.prepare("Can you check this?", { id: "forced-1" });
      expect(pending).toBeDefined();
      coordinator.schedule(pending!, 200, run);

      expect(
        coordinator.recordNativeConsult({ question: "Can you check this?" }, "native-call"),
      ).toMatchObject({ kind: "pending", handle: { id: "forced-1" } });
      vi.advanceTimersByTime(250);

      expect(run).not.toHaveBeenCalled();
      expect(coordinator.hasRecent("Can you check this?")).toBe(true);
      vi.advanceTimersByTime(2_001);
      expect(coordinator.hasRecent("Can you check this?")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks late native consults already delivered after a forced result", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const pending = coordinator.prepare("Can you check this?", { id: "forced-1" });
      coordinator.markStarted(pending!);
      coordinator.markDelivered(pending!);

      expect(
        coordinator.recordNativeConsult({ question: "Can you check this?" }, "native-call"),
      ).toMatchObject({ kind: "already_delivered", handle: { id: "forced-1" } });
      expect(coordinator.nativeCallIds(pending!)).toEqual(["native-call"]);

      vi.advanceTimersByTime(2_001);
      expect(coordinator.hasRecent("Can you check this?")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks native-first consults during the dedupe window", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();

      expect(coordinator.recordNativeConsult({ question: "check server" })).toMatchObject({
        kind: "none",
        question: "check server",
      });
      expect(coordinator.hasRecentNativeConsult("check server")).toBe(true);
      expect(coordinator.hasRecentNativeConsult("restart server")).toBe(false);

      vi.advanceTimersByTime(2_001);
      expect(coordinator.hasRecentNativeConsult("check server")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can treat native consults without a readable question as recent", () => {
    const coordinator = createRealtimeVoiceForcedConsultCoordinator();

    coordinator.recordNativeConsult({ prompt: "   " });

    expect(coordinator.hasRecentNativeConsult("check status")).toBe(false);
    expect(coordinator.hasRecentNativeConsult("check status", { allowUnknownQuestion: true })).toBe(
      true,
    );
  });

  it("clears pending, active, and cleanup timers", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const run = vi.fn();
      const pending = coordinator.prepare("check status", { id: "forced-1" });
      coordinator.schedule(pending!, 200, run);
      coordinator.clear();
      vi.advanceTimersByTime(250);
      expect(run).not.toHaveBeenCalled();
      expect(coordinator.hasRecent("check status")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears only pending handles", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const pendingRun = vi.fn();
      const active = coordinator.prepare("active question", { id: "active" });
      const pending = coordinator.prepare("pending question", { id: "pending" });
      coordinator.markStarted(active!);
      coordinator.schedule(pending!, 200, pendingRun);

      coordinator.clearPending();
      vi.advanceTimersByTime(250);

      expect(pendingRun).not.toHaveBeenCalled();
      expect(coordinator.hasRecent("pending question")).toBe(false);
      expect(coordinator.hasRecent("active question")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches remembered question aliases", () => {
    const coordinator = createRealtimeVoiceForcedConsultCoordinator();
    const handle = coordinator.prepare("check server status", { id: "forced-1" });

    coordinator.rememberQuestion(handle!, "Please inspect the server health");

    expect(coordinator.findRecent("inspect server health")).toEqual(handle);
    expect(coordinator.hasRecent("check server status")).toBe(true);
  });

  it("consumes the only pending handle while delivered handles are retained", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const delivered = coordinator.prepare("delivered question", { id: "delivered" });
      coordinator.markStarted(delivered!);
      coordinator.markDelivered(delivered!);
      const pending = coordinator.prepare("pending question", { id: "pending" });

      expect(coordinator.consumePending()).toEqual(pending);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears an existing timer when an explicit handle id is reused", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const staleRun = vi.fn();
      const currentRun = vi.fn();
      const stale = coordinator.prepare("first question", { id: "call-1" });
      coordinator.schedule(stale!, 200, staleRun);

      const current = coordinator.prepare("second question", { id: "call-1" });
      coordinator.schedule(current!, 200, currentRun);
      vi.advanceTimersByTime(250);

      expect(staleRun).not.toHaveBeenCalled();
      expect(currentRun).toHaveBeenCalledWith(current);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized forced consult schedule delays", () => {
    const scheduledDelays: number[] = [];
    const coordinator = createRealtimeVoiceForcedConsultCoordinator({
      setTimer: (_fn, ms) => {
        scheduledDelays.push(ms);
        return { clear: vi.fn() };
      },
    });
    const pending = coordinator.prepare("check status", { id: "forced-1" });

    coordinator.schedule(pending!, Number.MAX_SAFE_INTEGER, vi.fn());

    expect(scheduledDelays).toEqual([MAX_TIMER_TIMEOUT_MS]);
  });

  it("reports cancelled handles until the dedupe window expires", () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRealtimeVoiceForcedConsultCoordinator();
      const pending = coordinator.prepare("check status", { id: "forced-1" });
      coordinator.markStarted(pending!);
      coordinator.markCancelled(pending!);

      expect(coordinator.isCancelled(pending!)).toBe(true);
      vi.advanceTimersByTime(2_001);
      expect(coordinator.isCancelled(pending!)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
