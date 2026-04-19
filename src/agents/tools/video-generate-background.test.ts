import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  announceDeliveryMocks,
  createMediaCompletionFixture,
  expectDirectMediaSend,
  expectFallbackMediaAnnouncement,
  expectQueuedTaskRun,
  expectRecordedTaskProgress,
  resetMediaBackgroundMocks,
  taskDeliveryRuntimeMocks,
  taskExecutorMocks,
} from "./media-generate-background.test-support.js";

vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskDeliveryRuntimeMocks);
vi.mock("../subagent-announce-delivery.js", () => announceDeliveryMocks);

const {
  createVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  wakeVideoGenerationTaskCompletion,
} = await import("./video-generate-background.js");

describe("video generate background helpers", () => {
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

    const handle = createVideoGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "friendly lobster surfing",
      providerId: "openai",
    });

    expect(handle).toMatchObject({
      taskId: "task-123",
      requesterSessionKey: "agent:main:discord:direct:123",
      taskLabel: "friendly lobster surfing",
    });
    expectQueuedTaskRun({
      taskExecutorMocks,
      taskKind: VIDEO_GENERATION_TASK_KIND,
      sourceId: "video_generate:openai",
      progressSummary: "Queued video generation",
    });
  });

  it("records task progress updates", () => {
    recordVideoGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:video_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "friendly lobster surfing",
      },
      progressSummary: "Saving generated video",
    });

    expectRecordedTaskProgress({
      taskExecutorMocks,
      runId: "tool:video_generate:abc",
      progressSummary: "Saving generated video",
    });
  });

  it("queues a completion event by default when direct send is disabled", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeVideoGenerationTaskCompletion({
      ...createMediaCompletionFixture({
        runId: "tool:video_generate:abc",
        taskLabel: "friendly lobster surfing",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalled();
  });

  it("delivers completed video directly to the requester channel when enabled", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockResolvedValue({
      channel: "discord",
      messageId: "msg-1",
    });

    await wakeVideoGenerationTaskCompletion({
      ...createMediaCompletionFixture({
        directSend: true,
        runId: "tool:video_generate:abc",
        taskLabel: "friendly lobster surfing",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
      }),
    });

    expectDirectMediaSend({
      sendMessageMock: taskDeliveryRuntimeMocks.sendMessage,
      channel: "discord",
      to: "channel:1",
      threadId: "thread-1",
      content: "Generated 1 video.",
      mediaUrls: ["/tmp/generated-lobster.mp4"],
    });
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to a video-generation completion event when direct delivery fails", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockRejectedValue(new Error("discord upload failed"));
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeVideoGenerationTaskCompletion({
      ...createMediaCompletionFixture({
        directSend: true,
        runId: "tool:video_generate:abc",
        taskLabel: "friendly lobster surfing",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      }),
    });

    expectFallbackMediaAnnouncement({
      deliverAnnouncementMock: announceDeliveryMocks.deliverSubagentAnnouncement,
      requesterSessionKey: "agent:main:discord:direct:123",
      channel: "discord",
      to: "channel:1",
      source: "video_generation",
      announceType: "video generation task",
      resultMediaPath: "MEDIA:/tmp/generated-lobster.mp4",
      mediaUrls: ["/tmp/generated-lobster.mp4"],
    });
  });
});
