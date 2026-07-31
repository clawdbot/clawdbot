import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  findActiveMediaGenerationTaskForSession,
  findDuplicateGuardMediaGenerationTaskForSession,
  listActiveMediaGenerationTasksForSession,
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
} from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listFreshTasksForOwnerKey: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-1",
    runtime: "cli",
    taskKind: "video-generate",
    sourceId: "video-generate:byteplus",
    requesterSessionKey: "session/A",
    ownerKey: "session/A",
    scopeKind: "session",
    runId: "run-1",
    task: "generate clip 01",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now,
    startedAt: now,
    lastEventAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  resetRecentMediaGenerationDuplicateGuardsForTests();
  taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
});

describe("media generation delivery-phase prompt guard", () => {
  it("does not warn about a task waiting only for completion delivery", () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS }),
    ]);

    expect(
      buildActiveMediaGenerationTaskPromptContextForSession({
        sessionKey: "session/A",
        taskKind: "video-generate",
        sourcePrefix: "video-generate",
        nounLabel: "video",
        toolName: "video_generate",
        completionLabel: "video",
      }),
    ).toBeUndefined();
  });

  it("still warns while media generation is running", () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({ progressSummary: "Generating video" }),
    ]);

    expect(
      buildActiveMediaGenerationTaskPromptContextForSession({
        sessionKey: "session/A",
        taskKind: "video-generate",
        sourcePrefix: "video-generate",
        nounLabel: "video",
        toolName: "video_generate",
        completionLabel: "video",
      }),
    ).toContain("Do not call `video_generate` again for the same request");
  });

  it("keeps delivery-phase tasks available to duplicate/status lookups", () => {
    const task = makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(
      listActiveMediaGenerationTasksForSession({
        sessionKey: "session/A",
        taskKind: "video-generate",
        sourcePrefix: "video-generate",
      }),
    ).toEqual([task]);
    expect(
      findActiveMediaGenerationTaskForSession({
        sessionKey: "session/A",
        taskKind: "video-generate",
        sourcePrefix: "video-generate",
      }),
    ).toEqual(task);
  });

  it("blocks the same prompt while allowing a distinct prompt", () => {
    const task = makeTask({
      task: "generate clip 01",
      progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(
      findDuplicateGuardMediaGenerationTaskForSession({
        sessionKey: "session/A",
        taskKind: "video-generate",
        sourcePrefix: "video-generate",
        taskLabel: "generate clip 01",
        maxAgeMs: 120_000,
      }),
    ).toEqual(task);
    expect(
      findDuplicateGuardMediaGenerationTaskForSession({
        sessionKey: "session/A",
        taskKind: "video-generate",
        sourcePrefix: "video-generate",
        taskLabel: "generate clip 02",
        maxAgeMs: 120_000,
      }),
    ).toBeUndefined();
  });
});
