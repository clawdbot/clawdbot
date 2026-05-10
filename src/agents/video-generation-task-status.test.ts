import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildActiveVideoGenerationTaskPromptContextForSession,
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  getVideoGenerationTaskProviderId,
  isActiveVideoGenerationTask,
  VIDEO_GENERATION_TASK_KIND,
} from "./video-generation-task-status.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

function expectActiveVideoGenerationTask(
  task: ReturnType<typeof findActiveVideoGenerationTaskForSession>,
): NonNullable<ReturnType<typeof findActiveVideoGenerationTaskForSession>> {
  if (task == null) {
    throw new Error("Expected active video generation task");
  }
  return task;
}

describe("video generation task status", () => {
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
  });

  it("recognizes active session-backed video generation tasks", () => {
    expect(
      isActiveVideoGenerationTask({
        taskId: "task-1",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make lobster video",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      isActiveVideoGenerationTask({
        taskId: "task-2",
        runtime: "cron",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make lobster video",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(false);
  });

  it("prefers a running task over queued session siblings", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-queued",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:google",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "queued task",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
    ]);

    const task = findActiveVideoGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveVideoGenerationTask(task);
    expect(getVideoGenerationTaskProviderId(activeTask)).toBe("openai");
    expect(buildVideoGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not call video_generate again for this request.",
    );
    const details = buildVideoGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(VIDEO_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating video");
  });

  it("builds prompt context for active session work", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
    ]);

    const context = buildActiveVideoGenerationTaskPromptContextForSession("agent:main");

    expect(context).toContain("An active video generation background task already exists");
    expect(context).toContain("Task task-running is currently running via openai.");
    expect(context).toContain('call `video_generate` with `action:"status"`');
  });
});
