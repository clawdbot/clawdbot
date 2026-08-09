import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGeneratedMediaTaskActivity,
  registerGeneratedMediaTaskActivity,
} from "./generated-media-task-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "./task-runtime.test-helpers.js";
import {
  buildPendingGeneratedMediaSessionKeySet,
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
  hasPendingGeneratedMediaTaskForSessionKey,
} from "./task-status-access.js";

const mocks = vi.hoisted(() => ({
  listTaskRecords: vi.fn(),
  listTaskRecordsUnsorted: vi.fn(),
}));

vi.mock("./task-registry.js", () => ({
  findTaskByRunId: vi.fn(),
  getTaskById: vi.fn(),
  listTaskRecords: mocks.listTaskRecords,
  listTaskRecordsUnsorted: mocks.listTaskRecordsUnsorted,
  listTasksForAgentId: vi.fn(),
  listTasksForSessionKey: vi.fn(),
}));

describe("generated media task snapshots", () => {
  const sessionKey = "agent:main:cron:job:run:run-id";

  beforeEach(() => {
    resetGeneratedMediaTaskActivityForTests();
    mocks.listTaskRecords.mockReset();
    mocks.listTaskRecordsUnsorted.mockReset();
  });

  it("detects only media admitted by the current exact-run attempt", () => {
    const tasks = [
      {
        taskId: "old-image",
        taskKind: "image_generation",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
      },
    ];
    mocks.listTaskRecords.mockImplementation(() => tasks);
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);

    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(false);
    tasks.push({
      taskId: "new-video",
      taskKind: "video_generation",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
    });
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
  });

  it("does not apply exact-run replay guards to descendant sessions", () => {
    mocks.listTaskRecords.mockReturnValue([]);
    expect(getGeneratedMediaTaskIdsForSessionKey(`${sessionKey}:subagent:worker`)).toEqual(
      new Set(),
    );
    expect(mocks.listTaskRecords).not.toHaveBeenCalled();
  });

  it("tracks active media when a detached runtime does not mirror core tasks", () => {
    mocks.listTaskRecords.mockReturnValue([]);
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);

    registerGeneratedMediaTaskActivity("tool:image_generate:run-1", sessionKey);
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);

    clearGeneratedMediaTaskActivity("tool:image_generate:run-1");
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
  });
});

describe("buildPendingGeneratedMediaSessionKeySet", () => {
  const sessionKey = "agent:main:cron:job:run:run-id";

  beforeEach(() => {
    resetGeneratedMediaTaskActivityForTests();
    mocks.listTaskRecordsUnsorted.mockReset();
  });

  it("returns an empty set when no active media and no persisted tasks", () => {
    mocks.listTaskRecordsUnsorted.mockReturnValue([]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set());
  });

  it("combines active, requester, and owner session keys in one unsorted snapshot", () => {
    registerGeneratedMediaTaskActivity("tool:image_generate:run-1", "active-key");
    mocks.listTaskRecordsUnsorted.mockReturnValue([
      {
        taskId: "img-task",
        taskKind: "image_generation",
        status: "queued",
        requesterSessionKey: sessionKey,
        ownerKey: "owner-key",
      },
    ]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(
      new Set(["active-key", sessionKey, "owner-key"]),
    );
    expect(mocks.listTaskRecordsUnsorted).toHaveBeenCalledOnce();
  });

  it("excludes terminal and non-generated-media tasks", () => {
    mocks.listTaskRecordsUnsorted.mockReturnValue([
      {
        taskId: "done-task",
        taskKind: "image_generation",
        status: "succeeded",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
      },
      {
        taskId: "chat-task",
        taskKind: "chat",
        status: "running",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
      },
    ]);
    expect(buildPendingGeneratedMediaSessionKeySet()).toEqual(new Set());
  });
});
