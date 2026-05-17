import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildActiveImageGenerationTaskPromptContextForSession,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findActiveImageGenerationTaskForSession,
  getImageGenerationTaskProviderId,
  isActiveImageGenerationTask,
  IMAGE_GENERATION_TASK_KIND,
} from "./image-generation-task-status.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

function expectActiveImageGenerationTask(
  task: ReturnType<typeof findActiveImageGenerationTaskForSession>,
): NonNullable<ReturnType<typeof findActiveImageGenerationTaskForSession>> {
  if (task == null) {
    throw new Error("Expected active image generation task");
  }
  return task;
}

describe("image generation task status", () => {
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
  });

  it("recognizes active session-backed image generation tasks", () => {
    expect(
      isActiveImageGenerationTask({
        taskId: "task-1",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make watercolor robot",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      isActiveImageGenerationTask({
        taskId: "task-2",
        runtime: "cron",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make watercolor robot",
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
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:google",
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
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating image",
      },
    ]);

    const task = findActiveImageGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveImageGenerationTask(task);
    expect(getImageGenerationTaskProviderId(activeTask)).toBe("openai");
    expect(buildImageGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not call image_generate again for this request.",
    );
    const details = buildImageGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(IMAGE_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating image");
  });

  it("builds prompt context for active session work", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating image",
      },
    ]);

    const context = buildActiveImageGenerationTaskPromptContextForSession("agent:main");

    expect(context).toContain("An active image generation background task already exists");
    expect(context).toContain("Task task-running is currently running via openai.");
    expect(context).toContain('call `image_generate` with `action:"status"`');
  });
});
