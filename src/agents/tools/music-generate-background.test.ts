// Music background tests cover task-run creation, progress recording, and
// completion delivery through the durable requester-agent handoff.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  announceDeliveryMocks,
  createMediaCompletionFixture,
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
  musicGenerationTaskLifecycle,
  recordMusicGenerationTaskProgress,
} = await import("./music-generate-background.js");

function getDeliveredInternalEvents(): Array<Record<string, unknown>> {
  // Completion agents receive internal events; tests inspect them to keep the
  // visible-reply media contract explicit.
  const params = announceDeliveryMocks.deliverSubagentAnnouncement.mock.calls.at(0)?.[0] as
    | { internalEvents?: unknown }
    | undefined;
  if (!Array.isArray(params?.internalEvents)) {
    throw new Error("Expected delivered internal events");
  }
  return params.internalEvents as Array<Record<string, unknown>>;
}

function expectReplyInstructionContains(text: string) {
  const event = getDeliveredInternalEvents().find(
    (item) => typeof item.replyInstruction === "string" && item.replyInstruction.includes(text),
  );
  if (!event) {
    throw new Error(`Expected reply instruction containing ${text}`);
  }
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

    await musicGenerationTaskLifecycle.wakeTaskCompletion({
      ...createMediaCompletionFixture({
        runId: "tool:music_generate:abc",
        taskLabel: "night-drive synthwave",
        result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("tells channel completion agents to follow the visible-reply contract", async () => {
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

    await musicGenerationTaskLifecycle.wakeTaskCompletion({
      ...completion,
      handle: {
        ...completion.handle,
        requesterSessionKey: "agent:main:discord:channel:C123",
      },
    });

    expectReplyInstructionContains("visible-reply contract");
    expectReplyInstructionContains("final-reply MEDIA lines");
  });

  it("keeps failed completion notices in the durable agent-loop handoff", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: false,
      path: "direct",
      reason: "generated_media_missing",
      error: "completion agent did not deliver generated media",
    });
    const completion = createMediaCompletionFixture({
      runId: "tool:music_generate:abc",
      taskLabel: "night-drive synthwave",
      result: "provider failed",
    });

    await expect(
      musicGenerationTaskLifecycle.wakeTaskCompletion({
        ...completion,
        status: "error",
        statusLabel: "failed",
      }),
    ).resolves.toEqual({ status: "permanent_failure" });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
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

      await musicGenerationTaskLifecycle.wakeTaskCompletion({
        ...completion,
        handle: {
          ...completion.handle,
          requesterSessionKey,
        },
      });

      expectReplyInstructionContains("visible-reply contract");
      expectReplyInstructionContains("final-reply MEDIA lines");
    },
  );
});
