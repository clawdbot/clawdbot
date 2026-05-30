import { beforeEach, describe, expect, it, vi } from "vitest";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
const taskRegistryDeliveryRuntimeMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskRegistryDeliveryRuntimeMocks);

import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

beforeEach(() => {
  subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
  taskRegistryDeliveryRuntimeMocks.sendMessage.mockReset();
});

describe("scheduleMediaGenerationTaskCompletion", () => {
  it("keeps a generated media task active until completion delivery finishes", async () => {
    const order: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const completeTaskRun = vi.fn(() => {
      order.push("complete");
    });
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(() => {
        order.push("progress");
      }),
      completeTaskRun,
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => {
        order.push("wake");
        expect(completeTaskRun).not.toHaveBeenCalled();
        return true;
      }),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-123",
        runId: "tool:image_generate:123",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => {
        order.push("run");
        return {
          provider: "openai",
          model: "gpt-image-1",
          count: 1,
          paths: ["/tmp/proof.png"],
          wakeResult: "generated",
        };
      },
    });

    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();

    expect(order).toEqual(["run", "progress", "wake", "complete"]);
    expect(lifecycle.recordTaskProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Generated media; delivering completion",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
        terminalResult: undefined,
      }),
    );
  });

  it("completes a generated media task when completion delivery cannot be confirmed", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const onWakeFailure = vi.fn();
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => false),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-456",
        runId: "tool:image_generate:456",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion delivery was not confirmed after successful generation",
      expect.objectContaining({
        runId: "tool:image_generate:456",
        taskId: "task-image-456",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
        terminalResult: {
          terminalOutcome: "blocked",
          terminalSummary:
            "Required completion delivery failed before reaching the requester: completion delivery was not confirmed after successful generation.",
        },
      }),
    );
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("completes a generated media task when completion wake throws", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const wakeError = new Error("requester wake failed");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn().mockRejectedValueOnce(wakeError),
    };
    const onWakeFailure = vi.fn();

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-789",
        runId: "tool:image_generate:789",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion wake failed after successful generation",
      expect.objectContaining({
        error: wakeError,
        runId: "tool:image_generate:789",
        taskId: "task-image-789",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
        terminalResult: {
          terminalOutcome: "blocked",
          terminalSummary:
            "Required completion delivery failed before reaching the requester: requester wake failed.",
        },
      }),
    );
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("records normal success when direct recovery handles a completion wake throw", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const wakeError = new Error("requester wake failed");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn().mockRejectedValueOnce(wakeError),
    };
    taskRegistryDeliveryRuntimeMocks.sendMessage.mockResolvedValueOnce({});

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-direct-recovery",
        runId: "tool:image_generate:direct-recovery",
        requesterSessionKey: "agent:main:discord:channel:123",
        requesterOrigin: {
          channel: "discord",
          to: "channel:123",
        },
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    });

    await scheduled[0]?.();

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Image generation completed.",
        mediaUrls: ["/tmp/proof.png"],
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalResult: undefined,
      }),
    );
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("still delivers completion when the post-generation progress update throws", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const progressError = new Error("progress store failed");
    const onWakeFailure = vi.fn();
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(() => {
        throw progressError;
      }),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => true),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-progress-error",
        runId: "tool:image_generate:progress-error",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion progress update failed",
      expect.objectContaining({
        error: progressError,
        runId: "tool:image_generate:progress-error",
        taskId: "task-image-progress-error",
      }),
    );
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        result: "generated",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalled();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("fails the media task when generation itself fails", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const generationError = new Error("provider returned no images");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => true),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-generation-error",
        runId: "tool:image_generate:generation-error",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => {
        throw generationError;
      },
    });

    await scheduled[0]?.();

    expect(lifecycle.failTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: generationError,
      }),
    );
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        result: "provider returned no images",
      }),
    );
    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
  });
});

describe("createMediaGenerationTaskLifecycle", () => {
  it("returns the completion wake delivery result", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "image_generate",
      taskKind: "image_generation",
      label: "Image generation",
      queuedProgressSummary: "Queued image generation",
      generatedLabel: "image",
      failureProgressSummary: "Image generation failed",
      eventSource: "image_generation",
      announceType: "image generation task",
      completionLabel: "image",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-789",
          runId: "tool:image_generate:789",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
      }),
    ).resolves.toBe(true);
  });

  it("treats terminal generated-media fallback failure as handled", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      terminal: true,
      error: "generated media direct delivery failed after partial upload",
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "image_generate",
      taskKind: "image_generation",
      label: "Image generation",
      queuedProgressSummary: "Queued image generation",
      generatedLabel: "image",
      failureProgressSummary: "Image generation failed",
      eventSource: "image_generation",
      announceType: "image generation task",
      completionLabel: "image",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-terminal",
          runId: "tool:image_generate:terminal",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
      }),
    ).resolves.toBe(true);
  });

  it("direct-delivers generated media when the completion wake misses the requester", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      reason: "generated_media_missing",
      error: "completion agent did not deliver generated media",
    });
    taskRegistryDeliveryRuntimeMocks.sendMessage.mockResolvedValueOnce({});
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "image_generate",
      taskKind: "image_generation",
      label: "Image generation",
      queuedProgressSummary: "Queued image generation",
      generatedLabel: "image",
      failureProgressSummary: "Image generation failed",
      eventSource: "image_generation",
      announceType: "image generation task",
      completionLabel: "image",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-direct",
          runId: "tool:image_generate:direct",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    ).resolves.toBe(true);

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:123",
        content: "Image generation completed.",
        mediaUrls: ["/tmp/proof.png"],
        idempotencyKey: "image_generate:task-image-direct:ok:direct",
      }),
    );
  });

  it("does not direct-deliver generated media after requester abandonment", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "image_generate",
      taskKind: "image_generation",
      label: "Image generation",
      queuedProgressSummary: "Queued image generation",
      generatedLabel: "image",
      failureProgressSummary: "Image generation failed",
      eventSource: "image_generation",
      announceType: "image generation task",
      completionLabel: "image",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-abandoned",
          runId: "tool:image_generate:abandoned",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    ).resolves.toBe(false);

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not direct-deliver generated media after a generic handoff failure", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      error: "gateway request timeout for agent",
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "image_generate",
      taskKind: "image_generation",
      label: "Image generation",
      queuedProgressSummary: "Queued image generation",
      generatedLabel: "image",
      failureProgressSummary: "Image generation failed",
      eventSource: "image_generation",
      announceType: "image generation task",
      completionLabel: "image",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-timeout",
          runId: "tool:image_generate:timeout",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
        mediaUrls: ["/tmp/proof.png"],
      }),
    ).resolves.toBe(false);

    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });
});
