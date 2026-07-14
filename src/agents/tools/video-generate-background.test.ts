// Video generation background tests cover detached task lifecycle, keepalive
// progress, completion announcement, and direct failure delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentRunContext, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
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
  createVideoGenerationTaskRun,
  failVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  videoGenerationTaskLifecycle,
} = await import("./video-generate-background.js");

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

  it("keeps completed video agent-mediated even when direct send is enabled", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await videoGenerationTaskLifecycle.wakeTaskCompletion({
      ...createMediaCompletionFixture({
        directSend: true,
        runId: "tool:video_generate:abc",
        taskLabel: "friendly lobster surfing",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-lobster.mp4",
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      }),
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
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

  it("delivers video generation failures directly instead of relying on the model handoff", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: false,
      path: "direct",
      reason: "generated_media_missing",
      error: "completion agent did not deliver generated media",
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

    expect(taskDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(taskDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:1",
        threadId: "thread-1",
        content: "Video generation failed: All video generation models failed.",
        requesterSessionKey: "agent:main:discord:direct:123",
        idempotencyKey: "video_generate:task-123:error:direct",
        mirror: expect.objectContaining({
          sessionKey: "agent:main:discord:direct:123",
          idempotencyKey: "video_generate:task-123:error:direct",
        }),
      }),
    );
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
