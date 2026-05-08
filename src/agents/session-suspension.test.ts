import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CommandLane } from "../process/lanes.js";

const sessionStoreMocks = vi.hoisted(() => ({
  updateSessionStoreEntry: vi.fn(async (params: { update: (entry: unknown) => unknown }) => {
    await params.update({ sessionId: "session-1" });
  }),
}));

const commandQueueMocks = vi.hoisted(() => ({
  setCommandLaneConcurrency: vi.fn(),
}));

vi.mock("../config/sessions.js", () => sessionStoreMocks);

vi.mock("../process/command-queue.js", () => commandQueueMocks);

vi.mock("./command/session.js", () => ({
  resolveStoredSessionKeyForSessionId: () => ({
    sessionKey: "session-key",
    storePath: "/tmp/openclaw-session-suspension-test/sessions.json",
  }),
}));

async function suspendMainLane(ttlMs: number, cfg: OpenClawConfig) {
  const { suspendSession } = await import("./session-suspension.js");
  await suspendSession({
    cfg,
    sessionId: "session-1",
    laneId: CommandLane.Main,
    reason: "quota_exhausted",
    failedProvider: "anthropic",
    failedModel: "claude-opus-4-6",
    ttlMs,
  });
}

describe("session suspension", () => {
  afterEach(async () => {
    const { cancelLaneAutoResume } = await import("./session-suspension.js");
    cancelLaneAutoResume(CommandLane.Main);
    vi.useRealTimers();
    sessionStoreMocks.updateSessionStoreEntry.mockClear();
    commandQueueMocks.setCommandLaneConcurrency.mockClear();
  });

  it("auto-resumes main lane to configured agent concurrency", async () => {
    vi.useFakeTimers();
    const cfg = {
      agents: { defaults: { maxConcurrent: 4 } },
    } as OpenClawConfig;

    await suspendMainLane(100, cfg);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenCalledWith(CommandLane.Main, 0);

    await vi.advanceTimersByTimeAsync(100);

    expect(commandQueueMocks.setCommandLaneConcurrency).toHaveBeenLastCalledWith(
      CommandLane.Main,
      4,
    );
  });

  it("maps failover reasons to persisted suspension reasons", async () => {
    const { __testing } = await import("./session-suspension.js");

    expect(__testing.resolveSessionSuspensionReason("rate_limit")).toBe("quota_exhausted");
    expect(__testing.resolveSessionSuspensionReason("billing")).toBe("manual");
    expect(__testing.resolveSessionSuspensionReason("overloaded")).toBe("circuit_open");
    expect(__testing.resolveSessionSuspensionReason("timeout")).toBe("circuit_open");
    expect(__testing.resolveSessionSuspensionReason("auth")).toBe("circuit_open");
  });
});
