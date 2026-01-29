import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRequestProfiler,
  setProfilingConfig,
  getProfilingConfig,
  isProfilingEnabled,
} from "./request-profiler.js";

describe("createRequestProfiler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a profiler with marks", () => {
    const profiler = createRequestProfiler("test-1");
    
    profiler.mark("start");
    vi.advanceTimersByTime(100);
    profiler.mark("middle");
    vi.advanceTimersByTime(200);
    profiler.mark("end");

    const report = profiler.getReport();
    
    expect(report.requestId).toBe("test-1");
    expect(report.marks).toHaveLength(3);
    expect(report.totalMs).toBe(300);
  });

  it("calculates segments correctly", () => {
    const profiler = createRequestProfiler();
    
    profiler.mark("channel_received");
    vi.advanceTimersByTime(50);
    profiler.mark("media_downloaded");
    vi.advanceTimersByTime(150);
    profiler.mark("agent_invoked");
    vi.advanceTimersByTime(800);
    profiler.mark("response_sent");

    const report = profiler.getReport();
    
    expect(report.segments).toHaveLength(3);
    expect(report.segments[0]).toMatchObject({
      from: "channel_received",
      to: "media_downloaded",
      durationMs: 50,
    });
    expect(report.segments[1]).toMatchObject({
      from: "media_downloaded",
      to: "agent_invoked",
      durationMs: 150,
    });
    expect(report.segments[2]).toMatchObject({
      from: "agent_invoked",
      to: "response_sent",
      durationMs: 800,
    });
  });

  it("generates readable log string", () => {
    const profiler = createRequestProfiler("log-test");
    
    profiler.mark("start");
    vi.advanceTimersByTime(100);
    profiler.mark("end");

    const logStr = profiler.toLogString();
    
    expect(logStr).toContain("log-test");
    expect(logStr).toContain("total=100ms");
    expect(logStr).toContain("start → end");
  });
});

describe("profiling config", () => {
  it("manages global config", () => {
    setProfilingConfig({ enabled: true, logThresholdMs: 500 });
    
    const config = getProfilingConfig();
    expect(config.enabled).toBe(true);
    expect(config.logThresholdMs).toBe(500);
    expect(isProfilingEnabled()).toBe(true);
    
    // Reset
    setProfilingConfig({ enabled: false });
    expect(isProfilingEnabled()).toBe(false);
  });
});
