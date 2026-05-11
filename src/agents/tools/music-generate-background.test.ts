import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
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
  createMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  wakeMusicGenerationTaskCompletion,
} = await import("./music-generate-background.js");

function getDeliveredInternalEvents(): Array<Record<string, unknown>> {
  const params = announceDeliveryMocks.deliverSubagentAnnouncement.mock.calls[0]?.[0] as
    | { internalEvents?: unknown }
    | undefined;
  expect(params?.internalEvents).toBeTruthy();
  if (!Array.isArray(params?.internalEvents)) {
    throw new Error("Expected delivered internal events");
  }
  return params.internalEvents as Array<Record<string, unknown>>;
}

function expectReplyInstructionContains(text: string) {
  const event = getDeliveredInternalEvents().find(
    (item) => typeof item.replyInstruction === "string" && item.replyInstruction.includes(text),
  );
  expect(event).toBeDefined();
}

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

    expect(handle).not.toBeNull();
    if (!handle) {
      throw new Error("Expected music generation task handle");
    }
    expect(handle.taskId).toBe("task-123");
    expect(handle.requesterSessionKey).toBe("agent:main:discord:direct:123");
    expect(handle.taskLabel).toBe("night-drive synthwave");
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
      ...createMediaCompletionFixture({
        runId: "tool:music_generate:abc",
        taskLabel: "night-drive synthwave",
        result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalled();
  });

  it("warns channel completion agents that normal final replies are private", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });
    const completion = createMediaCompletionFixture({
      runId: "tool:music_generate:abc",
      taskLabel: "night-drive synthwave",
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });

    await wakeMusicGenerationTaskCompletion({
      ...completion,
      handle: {
        ...completion.handle,
        requesterSessionKey: "agent:main:discord:channel:C123",
      },
    });

    expectReplyInstructionContains("the user will NOT see your normal assistant final reply");
    expectReplyInstructionContains("Do not put MEDIA: lines only in your final answer");
  });

  it.each(["agent:main:discord:guild-123:channel-456", "agent:main:whatsapp:123@g.us"])(
    "warns legacy group/channel completion agents for %s",
    async (requesterSessionKey) => {
      announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: true,
        path: "direct",
      });
      const completion = createMediaCompletionFixture({
        runId: "tool:music_generate:abc",
        taskLabel: "night-drive synthwave",
        result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      });

      await wakeMusicGenerationTaskCompletion({
        ...completion,
        handle: {
          ...completion.handle,
          requesterSessionKey,
        },
      });

      expectReplyInstructionContains("the user will NOT see your normal assistant final reply");
      expectReplyInstructionContains("Do not put MEDIA: lines only in your final answer");
    },
  );

  it("queues a completion event when direct send is enabled globally", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockResolvedValue({
      channel: "discord",
      messageId: "msg-1",
    });
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeMusicGenerationTaskCompletion({
      ...createMediaCompletionFixture({
        directSend: true,
        runId: "tool:music_generate:abc",
        taskLabel: "night-drive synthwave",
        result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
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
