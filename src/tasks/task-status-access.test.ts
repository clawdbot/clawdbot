import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGeneratedMediaTaskActivity,
  registerGeneratedMediaTaskActivity,
  resetGeneratedMediaTaskActivityForTests,
} from "./generated-media-task-activity.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
  hasPendingGeneratedMediaTaskForSessionKey,
} from "./task-status-access.js";

const mocks = vi.hoisted(() => ({ listTaskRecords: vi.fn() }));

vi.mock("./task-registry.js", () => ({
  findTaskByRunId: vi.fn(),
  getTaskById: vi.fn(),
  listTaskRecords: mocks.listTaskRecords,
  listTasksForAgentId: vi.fn(),
  listTasksForSessionKey: vi.fn(),
}));

describe("generated media task snapshots", () => {
  const sessionKey = "agent:main:cron:job:run:run-id";

  beforeEach(() => {
    resetGeneratedMediaTaskActivityForTests();
    mocks.listTaskRecords.mockReset();
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
