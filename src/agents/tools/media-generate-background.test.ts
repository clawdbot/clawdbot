// Media generation background tests cover detached task creation, progress
// updates, and completion wake delivery for generated media results.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  IMAGE_GENERATION_TASK_KIND,
  MUSIC_GENERATION_TASK_KIND,
  VIDEO_GENERATION_TASK_KIND,
} from "../media-generation-task-status.js";
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
vi.mock("../subagents/announce/subagent-announce-delivery.js", () => announceDeliveryMocks);

const {
  createImageGenerationTaskRun,
  createMusicGenerationTaskRun,
  createVideoGenerationTaskRun,
  failVideoGenerationTaskRun,
  imageGenerationTaskLifecycle,
  musicGenerationTaskLifecycle,
  recordImageGenerationTaskProgress,
  recordMusicGenerationTaskProgress,
  recordVideoGenerationTaskProgress,
  videoGenerationTaskLifecycle,
} = await import("./media-generate-background.js");

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

// Music background tests cover task-run creation, progress recording, and
// completion delivery through the durable requester-agent handoff.
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

// Video generation background tests cover detached task lifecycle, keepalive
// progress and completion delivery through the durable requester-agent handoff.
describe("video generate background helpers", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    resetMediaBackgroundMocks({
      taskExecutorMocks,
      taskDeliveryRuntimeMocks,
      announceDeliveryMocks,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentEventsForTest();
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

    expect(handle?.taskId).toBe("task-123");
    expect(handle?.requesterSessionKey).toBe("agent:main:discord:direct:123");
    expect(handle?.taskLabel).toBe("friendly lobster surfing");
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

  it("keeps the detached video tool run context registered until terminal status", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createVideoGenerationTaskRun({
      sessionKey: "agent:main:discord:channel:123",
      prompt: "friendly lobster surfing",
      providerId: "fal",
    });
    if (!handle) {
      throw new Error("expected video generation task handle");
    }

    expect(handle.runId).toMatch(/^tool:video_generate:/);
    expect(getAgentRunContext(handle.runId)?.sessionKey).toBe("agent:main:discord:channel:123");

    const beforeProgress = Date.now();
    recordVideoGenerationTaskProgress({
      handle,
      progressSummary: "Generating video",
    });

    expect(getAgentRunContext(handle.runId)?.lastActiveAt).toBeGreaterThanOrEqual(beforeProgress);

    failVideoGenerationTaskRun({
      handle,
      error: new Error("provider failed"),
    });

    expect(getAgentRunContext(handle.runId)).toBeUndefined();
  });

  it("queues a completion event by default when direct send is disabled", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await videoGenerationTaskLifecycle.wakeTaskCompletion({
      ...createMediaCompletionFixture({
        runId: "tool:video_generate:abc",
        taskLabel: "friendly lobster surfing",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("keeps video generation failures in the durable agent-loop handoff", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: false,
      path: "direct",
      reason: "generated_media_missing",
      error: "completion agent did not deliver generated media",
    });

    await expect(
      videoGenerationTaskLifecycle.wakeTaskCompletion({
        ...createMediaCompletionFixture({
          runId: "tool:video_generate:abc",
          taskLabel: "friendly lobster surfing",
          result: "All video generation models failed.",
        }),
        status: "error",
        statusLabel: "failed",
      }),
    ).resolves.toEqual({ status: "permanent_failure" });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("keeps active video generation failure wakes agent-mediated", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "steered",
    });

    await videoGenerationTaskLifecycle.wakeTaskCompletion({
      ...createMediaCompletionFixture({
        runId: "tool:video_generate:abc",
        taskLabel: "friendly lobster surfing",
        result: "All video generation models failed.",
      }),
      status: "error",
      statusLabel: "failed",
    });

    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });
});
