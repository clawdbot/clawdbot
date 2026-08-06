import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createMediaGenerationTaskStatusOwner,
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
} from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listFreshTasksForOwnerKey: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

const videoTaskStatusOwner = createMediaGenerationTaskStatusOwner({
  taskKind: "video_generation",
  toolName: "video_generate",
  nounLabel: "video",
  completionLabel: "video",
  promptCompletionLabel: "video",
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-1",
    runtime: "cli",
    taskKind: "video_generation",
    sourceId: "video_generate:byteplus",
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
      videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A"),
    ).toBeUndefined();
  });

  it("still warns while media generation is running", () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({ progressSummary: "Generating video" }),
    ]);

    expect(videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A")).toContain(
      "Do not call `video_generate` again for the same request",
    );
  });

  it("keeps delivery-phase tasks available to duplicate/status lookups", () => {
    const task = makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(videoTaskStatusOwner.listActiveTasksForSession("session/A")).toEqual([task]);
    expect(videoTaskStatusOwner.findActiveTaskForSession("session/A")).toEqual(task);
  });

  it("blocks the same prompt while allowing a distinct prompt", () => {
    const task = makeTask({
      task: "generate clip 01",
      progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(
      videoTaskStatusOwner.findDuplicateGuardTaskForSession("session/A", {
        prompt: "generate clip 01",
      }),
    ).toEqual(task);
    expect(
      videoTaskStatusOwner.findDuplicateGuardTaskForSession("session/A", {
        prompt: "generate clip 02",
      }),
    ).toBeUndefined();
  });
});
