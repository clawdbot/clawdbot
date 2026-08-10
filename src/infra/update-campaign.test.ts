import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import { UpdateCampaignController } from "./update-campaign.js";

function createInspectors(readBusy: () => number): GatewayActiveWorkInspectors {
  return {
    getQueueSize: readBusy,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

describe("UpdateCampaignController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createController() {
    let nextId = 0;
    return new UpdateCampaignController({
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      createId: () => `campaign-${++nextId}`,
    });
  }

  it("counts down while idle and applies after one minute", async () => {
    const controller = createController();
    const apply = vi.fn(async () => "applied" as const);
    const onChange = vi.fn();

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply,
      onChange,
    });

    expect(controller.getState()).toMatchObject({
      state: "countdown",
      applyAtMs: 1_060_000,
      forceAtMs: 1_900_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getState()?.state).toBe("applying");
    expect(apply).toHaveBeenCalledWith({ forced: false });
  });

  it("keeps an announced countdown stable when active work begins", async () => {
    const controller = createController();
    let busy = 0;
    const apply = vi.fn(async () => "applied" as const);

    controller.announce({
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "one", commitsBehind: 1 },
      inspect: createInspectors(() => busy),
      apply,
      onChange: vi.fn(),
    });
    const applyAtMs = controller.getState()?.applyAtMs;
    busy = 1;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.getState()).toMatchObject({ state: "countdown", applyAtMs });

    await vi.advanceTimersByTimeAsync(55_000);
    expect(controller.getState()?.state).toBe("applying");
    expect(apply).toHaveBeenCalledWith({ forced: false });
  });

  it("starts a fresh campaign for a newer target and clears availability", () => {
    const controller = createController();
    const onChange = vi.fn();
    const inspect = createInspectors(() => 1);
    const apply = vi.fn(async () => "applied" as const);

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect,
      apply,
      onChange,
    });
    const first = controller.getState();
    vi.setSystemTime(1_010_000);
    controller.announce({
      target: { kind: "package", version: "3.0.0" },
      inspect,
      apply,
      onChange,
    });

    expect(controller.getState()).toMatchObject({
      id: "campaign-2",
      announcedAtMs: 1_010_000,
      forceAtMs: 1_910_000,
    });
    expect(controller.getState()?.id).not.toBe(first?.id);
    controller.clear();
    expect(controller.getState()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("lets update.run adopt a campaign without invoking automatic apply", async () => {
    const controller = createController();
    const apply = vi.fn(async () => "applied" as const);

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply,
      onChange: vi.fn(),
    });
    expect(controller.adopt()).toEqual({
      campaignId: "campaign-1",
      target: { kind: "package", version: "2.0.0" },
    });
    expect(controller.getState()?.state).toBe("applying");
    expect(controller.hold()).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("holds a waiting campaign once and shifts its hard deadline", async () => {
    const controller = createController();
    const apply = vi.fn(async () => "applied" as const);

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect: createInspectors(() => 1),
      apply,
      onChange: vi.fn(),
    });

    expect(controller.hold()).toBe(true);
    expect(controller.getState()).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 4_600_000,
      forceAtMs: 5_500_000,
      updatedAtMs: 1_000_000,
    });
    expect(controller.getState()?.applyAtMs).toBeUndefined();
    expect(controller.hold()).toBe(false);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(controller.getState()).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 4_600_000,
    });
    expect(controller.hold()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(controller.getState()?.state).toBe("applying");
    expect(apply).toHaveBeenCalledWith({ forced: true });
  });

  it("holds a countdown, drops its apply deadline, and allows adoption", async () => {
    const controller = createController();
    const apply = vi.fn(async () => "applied" as const);

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply,
      onChange: vi.fn(),
    });
    expect(controller.getState()?.state).toBe("countdown");

    expect(controller.hold(10_000)).toBe(true);
    expect(controller.getState()).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 1_010_000,
      forceAtMs: 1_910_000,
    });
    expect(controller.getState()?.applyAtMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(controller.getState()?.state).toBe("waiting-for-idle");
    expect(apply).not.toHaveBeenCalled();

    expect(controller.adopt()).toMatchObject({
      campaignId: "campaign-1",
      target: { kind: "package", version: "2.0.0" },
    });
    expect(controller.getState()?.state).toBe("applying");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves a consumed hold while returning to countdown without spinning timers", async () => {
    const controller = createController();
    const apply = vi.fn(async () => "applied" as const);

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply,
      onChange: vi.fn(),
    });
    expect(controller.hold(10_000)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getState()).toMatchObject({
      state: "countdown",
      holdUntilMs: 1_010_000,
      applyAtMs: 1_070_000,
    });
    expect(controller.hold()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("returns false when holding without a campaign", () => {
    expect(createController().hold()).toBe(false);
  });

  it("clears a failed apply and lets the next announcement start fresh", async () => {
    const controller = createController();
    const onChange = vi.fn();
    const announcement = {
      target: { kind: "package" as const, version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply: vi.fn(async () => "failed" as const),
      onChange,
    };

    controller.announce(announcement);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(controller.getState()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    controller.announce(announcement);
    expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });
  });

  it("clears a campaign when apply rejects", async () => {
    const controller = createController();
    const onChange = vi.fn();
    const announcement = {
      target: { kind: "package" as const, version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply: vi.fn(async () => {
        throw new Error("update failed");
      }),
      onChange,
    };

    controller.announce(announcement);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(controller.getState()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    controller.announce(announcement);
    expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });
  });

  it.each(["handoff", "applied"] as const)(
    "keeps the campaign applying when apply resolves %s",
    async (outcome) => {
      const controller = createController();

      controller.announce({
        target: { kind: "package", version: "2.0.0" },
        inspect: createInspectors(() => 0),
        apply: vi.fn(async () => outcome),
        onChange: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(controller.getState()).toMatchObject({ id: "campaign-1", state: "applying" });
    },
  );

  it("does not clear a replacement campaign when an earlier apply fails", async () => {
    const controller = createController();
    let resolveApply!: (outcome: "failed") => void;
    const apply = vi.fn(
      async () =>
        await new Promise<"failed">((resolve) => {
          resolveApply = resolve;
        }),
    );

    controller.announce({
      target: { kind: "package", version: "2.0.0" },
      inspect: createInspectors(() => 0),
      apply,
      onChange: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getState()).toMatchObject({ id: "campaign-1", state: "applying" });

    controller.announce({
      target: { kind: "package", version: "3.0.0" },
      inspect: createInspectors(() => 0),
      apply: vi.fn(async () => "applied" as const),
      onChange: vi.fn(),
    });
    expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });

    resolveApply("failed");
    await apply.mock.results[0]?.value;
    expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });
  });
});
