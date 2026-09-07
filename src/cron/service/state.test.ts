// Cron service state tests cover in-memory scheduler state transitions.
import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCronServiceState, emit } from "./state.js";

describe("cron service state seam coverage", () => {
  it("threads heartbeat and session-store dependencies into internal state", () => {
    const nowMs = vi.fn(() => 123_456);
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const resolveSessionStorePath = vi.fn((agentId?: string) => `/tmp/${agentId ?? "main"}.json`);

    const state = createCronServiceState({
      nowMs,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      storePath: "/tmp/cron/jobs.json",
      cronEnabled: true,
      defaultAgentId: "ops",
      sessionStorePath: "/tmp/sessions.json",
      resolveSessionStorePath,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(state.store).toBeNull();
    expect(state.durableNextRunAtMsByJobId.size).toBe(0);
    expect(state.timer).toBeNull();
    expect(state.running).toBe(false);
    expect(state.warnedDisabled).toBe(false);
    expect(state.storeLoadedAtMs).toBeNull();

    expect(state.deps.storePath).toBe("/tmp/cron/jobs.json");
    expect(state.deps.cronEnabled).toBe(true);
    expect(state.deps.defaultAgentId).toBe("ops");
    expect(state.deps.sessionStorePath).toBe("/tmp/sessions.json");
    expect(state.deps.resolveSessionStorePath).toBe(resolveSessionStorePath);
    expect(state.deps.enqueueSystemEvent).toBe(enqueueSystemEvent);
    expect(state.deps.requestHeartbeat).toBe(requestHeartbeat);
    expect(state.deps.nowMs()).toBe(123_456);
  });

  it("defaults nowMs to Date.now when not provided", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(789_000);

    const state = createCronServiceState({
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      storePath: "/tmp/cron/jobs.json",
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(state.deps.nowMs()).toBe(789_000);
    expect(state.deps.defaultAgentId).toBe("main");

    nowSpy.mockRestore();
  });

  it("projects store-private job provenance before emitting events", () => {
    const onEvent = vi.fn();
    const state = createCronServiceState({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storePath: "/tmp/cron/jobs.json",
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent,
    });
    const job = {
      ...makeCronJob({}),
      createdActor: { type: "human" as const, id: "profile-ada" },
    };

    emit(state, { action: "added", jobId: job.id, job });

    expect(onEvent.mock.calls[0]?.[0]?.job).not.toHaveProperty("createdActor");
  });
});
