// Image generation background tests cover detached task creation, progress
// updates, and completion wake delivery for generated image results.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_GENERATION_TASK_KIND } from "../image-generation-task-status.js";
import {
  announceDeliveryMocks,
  createMediaCompletionFixture,
  expectFallbackMediaAnnouncement,
  expectQueuedTaskRun,
  expectRecordedTaskProgress,
  resetMediaBackgroundMocks,
  taskDeliveryRuntimeMocks,
  taskExecutorMocks,
} from "./media-generate-background.test-support.js";

vi.mock("../../tasks/detached-task-runtime.js", () => taskExecutorMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskDeliveryRuntimeMocks);
vi.mock("../subagent-announce-delivery.js", () => announceDeliveryMocks);

const {
  createImageGenerationTaskRun,
  imageGenerationTaskLifecycle,
  recordImageGenerationTaskProgress,
} = await import("./image-generate-background.js");

describe("image generate background helpers", () => {
  beforeEach(() => {
    resetMediaBackgroundMocks({
      taskExecutorMocks,
      taskDeliveryRuntimeMocks,
      announceDeliveryMocks,
    });
  });

  it("creates a running task with queued progress text", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createImageGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "small watercolor robot",
      providerId: "openai",
    });

    if (!handle) {
      throw new Error("Expected image generation task handle");
    }
    expect(handle.taskId).toBe("task-123");
    expect(handle.requesterSessionKey).toBe("agent:main:discord:direct:123");
    expect(handle.taskLabel).toBe("small watercolor robot");
    expectQueuedTaskRun({
      taskExecutorMocks,
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourceId: "image_generate:openai",
      progressSummary: "Queued image generation",
    });
  });

  it("records task progress updates", () => {
    recordImageGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:image_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "small watercolor robot",
      },
      progressSummary: "Saving generated image",
    });

    expectRecordedTaskProgress({
      taskExecutorMocks,
      runId: "tool:image_generate:abc",
      progressSummary: "Saving generated image",
    });
  });

  it("queues a completion event through the shared generated-media wake path", async () => {
    // Successful media completion is routed through the announce handoff so the
    // requesting session receives model-mediated visible reply instructions.
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await imageGenerationTaskLifecycle.wakeTaskCompletion({
      ...createMediaCompletionFixture({
        runId: "tool:image_generate:abc",
        taskLabel: "small watercolor robot",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-robot.png",
        mediaUrls: ["/tmp/generated-robot.png"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expectFallbackMediaAnnouncement({
      deliverAnnouncementMock: announceDeliveryMocks.deliverSubagentAnnouncement,
      requesterSessionKey: "agent:main:discord:direct:123",
      channel: "discord",
      to: "channel:1",
      source: "image_generation",
      announceType: "image generation task",
      resultMediaPath: "MEDIA:/tmp/generated-robot.png",
      mediaUrls: ["/tmp/generated-robot.png"],
    });
  });

  it("keeps failed completion notices in the durable agent-loop handoff", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: false,
      path: "direct",
      reason: "generated_media_missing",
      error: "completion agent did not deliver generated media",
    });
    const completion = createMediaCompletionFixture({
      runId: "tool:image_generate:abc",
      taskLabel: "small watercolor robot",
      result: "provider failed",
    });

    await expect(
      imageGenerationTaskLifecycle.wakeTaskCompletion({
        ...completion,
        status: "error",
        statusLabel: "failed",
      }),
    ).resolves.toEqual({ status: "permanent_failure" });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
  });
});
