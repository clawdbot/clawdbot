import { describe, expect, it, vi } from "vitest";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));

vi.mock("../subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);

import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

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
      }),
    );
  });

  it("fails a generated media task when completion delivery cannot be confirmed", async () => {
    const scheduled: Array<() => Promise<void>> = [];
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
      onWakeFailure: vi.fn(),
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.failTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Image generation completion delivery failed after successful generation",
        }),
      }),
    );
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        result: "Image generation completion delivery failed after successful generation",
      }),
    );
  });

  it("reports a generated media task failure when completion wake throws", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const wakeError = new Error("requester wake failed");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn().mockRejectedValueOnce(wakeError).mockResolvedValueOnce(true),
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
    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.failTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Image generation completion delivery failed after successful generation",
        }),
      }),
    );
    expect(lifecycle.wakeTaskCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "error",
        result: "Image generation completion delivery failed after successful generation",
      }),
    );
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
});
