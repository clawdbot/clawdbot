import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

type Continuation = NonNullable<SessionEntry["cronRunContinuation"]>;
const mocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(async () => ({ deleted: true, archivedTranscripts: [] })),
  hasPendingMedia: vi.fn(() => false),
  loadPendingSessionDeliveries: vi.fn(async () => []),
  loadEntry: vi.fn<() => SessionEntry | undefined>(),
  sleep: vi.fn(async () => {}),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: mocks.sleep,
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/tmp/sessions.json",
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  deleteSessionEntryLifecycle: mocks.deleteEntry,
  loadSessionEntry: mocks.loadEntry,
}));
vi.mock("../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "current-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) =>
    generation === "current-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../infra/session-delivery-queue-storage.js", () => ({
  loadPendingSessionDeliveries: mocks.loadPendingSessionDeliveries,
}));
vi.mock("./task-status-access.js", () => ({
  hasPendingGeneratedMediaTaskForSessionKey: mocks.hasPendingMedia,
}));

import { removeCronRunContinuationSessionIfIdle } from "./cron-run-continuation-cleanup.js";

const marker = (overrides: Partial<Continuation> = {}): Continuation => ({
  lifecycleRevision: "revision-1",
  phase: "ready",
  basePersisted: true,
  ...overrides,
});
const ownedMarker = (ownerLifecycleGeneration: string, basePersisted = true) =>
  marker({
    phase: "continuing",
    basePersisted,
    ownerRunId: "owner-run",
    ownerLifecycleGeneration,
  });
const cases: Array<[string, Continuation, boolean, boolean]> = [
  ["idle ready", marker(), false, true],
  ["idle retired owner", ownedMarker("retired-generation"), false, true],
  ["current owner", ownedMarker("current-generation"), false, false],
  ["unpersisted base", ownedMarker("retired-generation", false), false, false],
  ["pending media", marker(), true, false],
];

describe("removeCronRunContinuationSessionIfIdle", () => {
  const sessionKey = "agent:main:cron:one-shot:run:run-123";

  beforeEach(() => {
    mocks.deleteEntry.mockReset().mockResolvedValue({ deleted: true, archivedTranscripts: [] });
    mocks.hasPendingMedia.mockReset();
    mocks.loadPendingSessionDeliveries.mockReset().mockResolvedValue([]);
    mocks.loadEntry.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
  });

  it.each(cases)("handles %s", async (_name, continuation, pending, deleted) => {
    mocks.hasPendingMedia.mockReturnValue(pending);
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: continuation,
    });

    await removeCronRunContinuationSessionIfIdle(sessionKey);

    expect(mocks.deleteEntry).toHaveBeenCalledTimes(deleted ? 1 : 0);
  });

  it("keeps a continuation while its durable session delivery is pending", async () => {
    mocks.loadPendingSessionDeliveries.mockResolvedValueOnce([
      {
        id: "pending-media",
        kind: "agentTurn",
        sessionKey,
        message: "generated image ready",
        messageId: "image:task-1:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
      },
    ] as never);

    await removeCronRunContinuationSessionIfIdle(sessionKey);

    expect(mocks.loadEntry).not.toHaveBeenCalled();
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
  });

  it("removes a continuation while finalizing its settled delivery row", async () => {
    mocks.loadPendingSessionDeliveries.mockResolvedValueOnce([
      {
        id: "settled-media",
        kind: "agentTurn",
        sessionKey,
        message: "generated image ready",
        messageId: "image:task-1:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        settlementOutcome: "recovered",
      },
    ] as never);
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });

    await removeCronRunContinuationSessionIfIdle(sessionKey, "settled-media");

    expect(mocks.deleteEntry).toHaveBeenCalledTimes(1);
  });

  it("retries deletion when it races with a still-releasing work admission", async () => {
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });
    mocks.deleteEntry
      .mockRejectedValueOnce(
        new Error(
          "Cannot delete session while competing work is in flight for agent:main:cron:one-shot:run:run-123; retry after the run completes",
        ),
      )
      .mockResolvedValueOnce({ deleted: true, archivedTranscripts: [] });

    await removeCronRunContinuationSessionIfIdle(sessionKey);

    expect(mocks.deleteEntry).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded retry budget is exhausted", async () => {
    mocks.loadEntry.mockReturnValue({
      sessionId: "run-123",
      updatedAt: 123,
      lifecycleRevision: "revision-1",
      cronRunContinuation: marker(),
    });
    mocks.deleteEntry.mockRejectedValue(
      new Error(
        "Cannot delete session while competing work is in flight for agent:main:cron:one-shot:run:run-123; retry after the run completes",
      ),
    );

    await expect(removeCronRunContinuationSessionIfIdle(sessionKey)).rejects.toThrow(
      "competing work is in flight",
    );

    expect(mocks.deleteEntry).toHaveBeenCalledTimes(5);
    expect(mocks.sleep).toHaveBeenCalledTimes(4);
  });
});
