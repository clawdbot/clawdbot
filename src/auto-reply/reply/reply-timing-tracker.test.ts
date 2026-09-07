// Tests reply profiler flag detection and timing tracker output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { createReplyHotPathTimingTracker } from "./dispatch-from-config.timing.js";
import { createReplyTimingTracker, isReplyProfilerEnabled } from "./reply-timing-tracker.js";

const subsystemWarn = vi.hoisted(() => vi.fn());
const subsystemInfo = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: subsystemWarn, info: subsystemInfo }),
}));

beforeEach(() => {
  subsystemWarn.mockReset();
  subsystemInfo.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("isReplyProfilerEnabled", () => {
  it("matches global and reply profiler diagnostic flags", () => {
    const cfg = { diagnostics: { flags: ["reply.profiler"] } } as OpenClawConfig;
    expect(isReplyProfilerEnabled({ config: cfg, env: {} as NodeJS.ProcessEnv })).toBe(true);
    expect(
      isReplyProfilerEnabled({
        env: { OPENCLAW_DIAGNOSTICS: "profiler" } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });
});

describe("createReplyTimingTracker", () => {
  it("reports slow preparation without profiling while keeping fast replies quiet", async () => {
    const warn = vi.fn();
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const tracker = createReplyTimingTracker({ log: { warn }, enabled: false });

    expect(tracker.measureSync("sync", () => 42)).toBe(42);
    await expect(tracker.measure("async", async () => "ok")).resolves.toBe("ok");
    tracker.logIfSlow({ message: "reply timings" });
    expect(warn).not.toHaveBeenCalled();

    await tracker.measure("prepare", async () => {
      nowMs += 5_000;
    });
    tracker.logIfSlow({ message: "reply timings", details: { runId: "run-1" } });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      runId: "run-1",
      spans: expect.arrayContaining([{ name: "prepare", durationMs: 5_000, elapsedMs: 5_000 }]),
    });
  });

  it("records and logs spans when the profiler flag is enabled", () => {
    const warn = vi.fn();
    const tracker = createReplyTimingTracker({
      log: { warn },
      env: { OPENCLAW_DIAGNOSTICS: "reply.profiler" } as NodeJS.ProcessEnv,
      totalWarnMs: 0,
      stageWarnMs: 0,
    });

    expect(tracker.measureSync("sync", () => 7)).toBe(7);
    tracker.logIfSlow({ message: "reply timings", outcome: "completed" });
    tracker.logIfSlow({ message: "reply timings", outcome: "completed" });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("stages=sync:");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      outcome: "completed",
      spans: [expect.objectContaining({ name: "sync" })],
    });
  });

  it("retains failed-stage timings and propagates the original failures", async () => {
    const warn = vi.fn();
    const tracker = createReplyTimingTracker({ log: { warn }, enabled: true, totalWarnMs: 0 });

    expect(() =>
      tracker.measureSync("sync_failure", () => {
        throw new Error("sync failed");
      }),
    ).toThrow("sync failed");
    await expect(
      tracker.measure("async_failure", async () => {
        throw new Error("async failed");
      }),
    ).rejects.toThrow("async failed");
    tracker.logIfSlow({ message: "reply timings" });

    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      spans: [{ name: "sync_failure" }, { name: "async_failure" }],
    });
  });

  it("keeps total and stage warning thresholds inclusive", () => {
    const warn = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(999);
    const totalTracker = createReplyTimingTracker({ log: { warn }, enabled: true });

    totalTracker.logIfSlow({ message: "total" });
    now.mockReturnValue(1_000);
    totalTracker.logIfSlow({ message: "total" });
    expect(warn).toHaveBeenCalledOnce();

    warn.mockReset();
    now.mockReset().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(500);
    const stageTracker = createReplyTimingTracker({ log: { warn }, enabled: true });
    stageTracker.measureSync("stage", () => undefined);
    stageTracker.logIfSlow({ message: "stage" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps agent milestones repeatable without reopening the terminal log", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1_500);
    const tracker = createAgentTurnTimingTracker({ profilerEnabled: true });
    const identity = { runId: "run-1", sessionId: "session-1", sessionKey: "agent:main" };

    tracker.logMilestoneIfSlow({ ...identity, milestone: "model_started" });
    tracker.logMilestoneIfSlow({ ...identity, milestone: "" });
    const terminal = {
      runId: "run-1",
      outcome: "error" as const,
      error: "failed",
      milestone: "unexpected",
      token: "secret",
    };
    tracker.logIfSlow(terminal);
    tracker.logIfSlow({ ...identity, outcome: "completed" });

    expect(subsystemWarn).toHaveBeenCalledTimes(3);
    expect(subsystemWarn.mock.calls[0]?.[0]).toBe(
      "agent turn milestone runId=run-1 sessionId=session-1 sessionKey=agent:main milestone=model_started totalMs=1500 stages=none",
    );
    expect(subsystemWarn.mock.calls[1]?.[0]).toContain(" milestone= totalMs=1500 ");
    expect(subsystemWarn.mock.calls[2]?.[0]).toContain("agent turn timings runId=run-1");
    expect(subsystemWarn.mock.calls[2]?.[1]).toEqual({
      runId: "run-1",
      sessionId: undefined,
      sessionKey: undefined,
      outcome: "error",
      error: "failed",
      totalMs: 1_500,
      spans: [],
    });
  });

  it("preserves dispatch timing messages and structured details", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1_500);
    const tracker = createReplyHotPathTimingTracker({ profilerEnabled: true });
    const details = {
      channel: "telegram",
      outcome: "skipped" as const,
      token: "secret",
    };

    tracker.logIfSlow(details);
    tracker.logIfSlow(details);

    expect(subsystemWarn).toHaveBeenCalledOnce();
    expect(subsystemWarn).toHaveBeenCalledWith(
      "reply hot path timings channel=telegram messageId=unknown sessionKey=unknown outcome=skipped totalMs=1500 stages=none",
      {
        channel: "telegram",
        messageId: undefined,
        sessionKey: undefined,
        outcome: "skipped",
        reason: undefined,
        totalMs: 1_500,
        spans: [],
      },
    );
  });

  it("keeps ordinary model and tool execution out of default terminal warnings", async () => {
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const agentTiming = createAgentTurnTimingTracker();
    const dispatchTiming = createReplyHotPathTimingTracker();
    const identity = { runId: "run-1", sessionId: "session-1", sessionKey: "agent:main" };

    agentTiming.logMilestoneIfSlow({ ...identity, milestone: "before_embedded_run" });
    agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "turn_accepted" });
    agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "model_call_started" });
    await dispatchTiming.measure("reply.run_reply_resolver", () =>
      agentTiming.measure("embedded_run", async () => {
        nowMs += 20_000;
        agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "assistant_output_started" });
        agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "tool_execution_started" });
      }),
    );
    agentTiming.logIfSlow({ ...identity, outcome: "completed" });
    dispatchTiming.logIfSlow({ channel: "webchat", outcome: "completed" });

    expect(subsystemWarn).not.toHaveBeenCalled();
    expect(subsystemInfo).toHaveBeenCalledTimes(2);
  });

  it("reports slow dispatch preparation before model execution without profiling", async () => {
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const tracker = createReplyHotPathTimingTracker();
    await tracker.measure("reply.load_reply_resolver", async () => {
      nowMs += 5_000;
    });
    tracker.logPreparationIfSlow({ channel: "webchat", sessionKey: "agent:main" });

    expect(subsystemWarn).toHaveBeenCalledOnce();
    expect(subsystemWarn.mock.calls[0]?.[1]).toMatchObject({
      channel: "webchat",
      sessionKey: "agent:main",
      outcome: "milestone",
      reason: "before_reply_resolver",
      totalMs: 5_000,
      spans: [{ name: "reply.load_reply_resolver", durationMs: 5_000, elapsedMs: 5_000 }],
    });
  });

  it("records the first slow execution phases without profiling or repeated tool logs", () => {
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const tracker = createAgentTurnTimingTracker();
    const identity = { runId: "run-1", sessionId: "session-1", sessionKey: "agent:main" };

    tracker.logExecutionPhaseIfSlow({ ...identity, phase: "runner_entered" });
    expect(subsystemWarn).not.toHaveBeenCalled();
    nowMs = 21_000;
    tracker.logExecutionPhaseIfSlow({ ...identity, phase: "turn_accepted" });
    nowMs = 24_000;
    tracker.logExecutionPhaseIfSlow({ ...identity, phase: "assistant_output_started" });
    tracker.logExecutionPhaseIfSlow({ ...identity, phase: "tool_execution_started" });
    nowMs = 30_000;
    tracker.logExecutionPhaseIfSlow({ ...identity, phase: "tool_execution_started" });

    expect(subsystemWarn.mock.calls.map((call) => call[1])).toEqual([
      { ...identity, milestone: "turn_accepted", totalMs: 21_000, spans: [] },
    ]);
    expect(subsystemInfo.mock.calls.map((call) => call[1])).toEqual([
      { ...identity, milestone: "assistant_output_started", totalMs: 24_000, spans: [] },
      { ...identity, milestone: "tool_execution_started", totalMs: 24_000, spans: [] },
    ]);
  });
});
