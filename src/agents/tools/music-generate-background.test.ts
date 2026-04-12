import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  announceDeliveryMocks,
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
  createMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  wakeMusicGenerationTaskCompletion,
} = await import("./music-generate-background.js");

describe("music generate background helpers", () => {
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

    const handle = createMusicGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "night-drive synthwave",
      providerId: "google",
    });

    expect(handle).toMatchObject({
      taskId: "task-123",
      requesterSessionKey: "agent:main:discord:direct:123",
      taskLabel: "night-drive synthwave",
    });
    expectQueuedTaskRun({
      taskExecutorMocks,
      taskKind: MUSIC_GENERATION_TASK_KIND,
      sourceId: "music_generate:google",
      progressSummary: "Queued music generation",
    });
  });

  it("records task progress updates", () => {
    recordMusicGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "night-drive synthwave",
      },
      progressSummary: "Saving generated music",
    });

    expectRecordedTaskProgress({
      taskExecutorMocks,
      runId: "tool:music_generate:abc",
      progressSummary: "Saving generated music",
    });
  });

  it("queues a completion event by default when direct send is disabled", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeMusicGenerationTaskCompletion({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "night-drive synthwave",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalled();
  });

  it("delivers completed music directly to the requester channel when enabled", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockResolvedValue({
      channel: "discord",
      messageId: "msg-1",
    });

    await wakeMusicGenerationTaskCompletion({
      config: { tools: { media: { asyncCompletion: { directSend: true } } } },
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "night-drive synthwave",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
    });

    expectDirectMediaSend({
      sendMessageMock: taskDeliveryRuntimeMocks.sendMessage,
      channel: "discord",
      to: "channel:1",
      threadId: "thread-1",
      content: "Generated 1 track.",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to a music-generation completion event when direct delivery fails", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockRejectedValue(new Error("discord upload failed"));
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeMusicGenerationTaskCompletion({
      config: { tools: { media: { asyncCompletion: { directSend: true } } } },
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:1",
          threadId: "thread-1",
        },
        taskLabel: "night-drive synthwave",
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });

    expectFallbackMediaAnnouncement({
      deliverAnnouncementMock: announceDeliveryMocks.deliverSubagentAnnouncement,
      requesterSessionKey: "agent:main:discord:direct:123",
      channel: "discord",
      to: "channel:1",
      source: "music_generation",
      announceType: "music generation task",
      resultMediaPath: "MEDIA:/tmp/generated-night-drive.mp3",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });
  });
});
