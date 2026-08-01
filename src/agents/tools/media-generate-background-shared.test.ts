// Background media generation tests cover detached task completion, requester
// wake delivery, and direct media fallback behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithOwnedSessionTranscriptWriteLock,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
  loadRequesterSessionEntry: vi.fn<() => { entry: Partial<SessionEntry> | undefined }>(() => ({
    entry: undefined,
  })),
}));
const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(() => ({ taskId: "task-pinned-route" })),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));
const taskRegistryDeliveryRuntimeMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);
vi.mock("../../tasks/detached-task-runtime.js", () => detachedTaskRuntimeMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskRegistryDeliveryRuntimeMocks);

import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
  shouldDetachMediaGenerationTask,
} from "./media-generate-background-shared.js";

beforeEach(() => {
  subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
  subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReset();
  subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({ entry: undefined });
  detachedTaskRuntimeMocks.createRunningTaskRun.mockClear();
  taskRegistryDeliveryRuntimeMocks.sendMessage.mockReset();
});

function createImageMediaLifecycle() {
  return createMediaGenerationTaskLifecycle({
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
}

describe("shouldDetachMediaGenerationTask", () => {
  it("detaches session-backed media generation", () => {
    expect(shouldDetachMediaGenerationTask("agent:main:discord:direct:123")).toBe(true);
    expect(shouldDetachMediaGenerationTask("agent:main:cron:daily-media")).toBe(true);
    expect(shouldDetachMediaGenerationTask("agent:main:cron:daily-media:run:run-123")).toBe(true);
    expect(shouldDetachMediaGenerationTask(undefined)).toBe(false);
  });
});

describe("scheduleMediaGenerationTaskCompletion", () => {
  it("runs detached completion outside a disposed requester transcript owner", async () => {
    const sessionKey = "agent:qa:image-generate";
    let disposed = false;
    let releaseBackground!: () => void;
    const backgroundReady = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    let scheduled: Promise<void> | undefined;
    const staleWriteLock = vi.fn();
    const withStaleWriteLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      staleWriteLock();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const wakeTaskCompletion = vi.fn(async () => {
      await runWithOwnedSessionTranscriptWriteLock({ sessionKey }, freshTranscriptWrite);
      return true;
    });
    const completeTaskRun = vi.fn();
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun,
      failTaskRun: vi.fn(),
      wakeTaskCompletion,
    };
    const run = vi.fn(async () => ({
      provider: "openai",
      model: "gpt-image-1",
      count: 1,
      paths: ["/tmp/qa-lighthouse.png"],
      wakeResult: "generated" as const,
    }));

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withSessionWriteLock: withStaleWriteLock },
      async () => {
        scheduleMediaGenerationTaskCompletion({
          lifecycle,
          handle: {
            taskId: "task-image-disposed-owner",
            runId: "tool:image_generate:disposed-owner",
            requesterSessionKey: sessionKey,
            taskLabel: "QA lighthouse",
          },
          scheduleBackgroundWork: (work) => {
            scheduled = backgroundReady.then(work);
          },
          progressSummary: "Generating image",
          toolName: "Image generation",
          onWakeFailure: vi.fn(),
          run,
        });
      },
    );

    disposed = true;
    releaseBackground();
    if (!scheduled) {
      throw new Error("expected scheduled media work");
    }
    await scheduled;

    expect(staleWriteLock).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(wakeTaskCompletion).toHaveBeenCalledOnce();
    expect(completeTaskRun).toHaveBeenCalledOnce();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("keeps a generated media task active until completion delivery finishes", async () => {
    // Mark completion only after the requester wake has been attempted; otherwise
    // task status can say done before the visible media reaches the requester.
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
  it("pins a missing requester target from session state when the task starts", async () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: {
        lastChannel: "telegram",
        lastTo: "5866004662",
        lastAccountId: "bot-1",
      },
    });
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:5866004662",
      requesterOrigin: { channel: "telegram" },
      prompt: "proof image",
    });
    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: "5866004662",
      accountId: "bot-1",
    });

    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: {
        lastChannel: "telegram",
        lastTo: "other-peer",
        lastAccountId: "bot-1",
      },
    });
    await lifecycle.wakeTaskCompletion({
      handle,
      status: "ok",
      statusLabel: "completed successfully",
      result: "generated",
    });
    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        completionDirectOrigin: {
          channel: "telegram",
          to: "5866004662",
          accountId: "bot-1",
        },
      }),
    );
  });

  it("does not pin a session target from another account", () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: {
        lastChannel: "telegram",
        lastTo: "peer-b",
        lastAccountId: "bot-b",
      },
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:shared",
      requesterOrigin: { channel: "telegram", accountId: "bot-a" },
      prompt: "proof image",
    });

    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: "bot-a",
    });

    const accountOnlyHandle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:shared",
      requesterOrigin: { accountId: "bot-a" },
      prompt: "account-only proof image",
    });
    expect(accountOnlyHandle?.requesterOrigin).toEqual({
      channel: undefined,
      to: undefined,
      accountId: "bot-a",
    });
  });

  it("does not pin a stored thread from a different requester target", () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: {
        lastChannel: "telegram",
        lastTo: "room-b",
        lastThreadId: 99,
      },
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:room-a",
      requesterOrigin: { channel: "telegram", to: "room-a" },
      prompt: "proof image",
    });

    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: "room-a",
      accountId: undefined,
    });
  });

  it("pins the external session route for an internal requester origin", () => {
    subagentAnnounceDeliveryMocks.loadRequesterSessionEntry.mockReturnValue({
      entry: {
        lastChannel: "telegram",
        lastTo: "room-a",
        lastAccountId: "bot-1",
      },
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:room-a",
      requesterOrigin: { channel: "webchat" },
      prompt: "proof image",
    });

    expect(handle?.requesterOrigin).toEqual({
      channel: "telegram",
      to: "room-a",
      accountId: "bot-1",
    });
  });

  it("returns the completion wake delivery result", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createImageMediaLifecycle();

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
    const lifecycle = createImageMediaLifecycle();

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
    const lifecycle = createImageMediaLifecycle();

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

  it("includes MEDIA directives in music completion wake prompts for session-only delivery", async () => {
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "music_generate",
      taskKind: "music_generation",
      label: "Music generation",
      queuedProgressSummary: "Queued music generation",
      generatedLabel: "track",
      failureProgressSummary: "Music generation failed",
      eventSource: "music_generation",
      announceType: "music generation task",
      completionLabel: "music",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-music-webchat",
          runId: "tool:music_generate:webchat",
          requesterSessionKey: "agent:main:dashboard:music-session",
          taskLabel: "night-drive synthwave",
          requesterOrigin: {
            channel: "webchat",
            to: "session:dashboard",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: 'Generated 1 track.\n- path="/tmp/generated-night-drive.mp3"',
        attachments: [
          {
            type: "audio",
            path: "/tmp/generated-night-drive.mp3",
            mimeType: "audio/mpeg",
            name: "generated-night-drive.mp3",
          },
        ],
      }),
    ).resolves.toBe(true);

    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:dashboard:music-session",
        requesterSessionOrigin: {
          channel: "webchat",
          to: "session:dashboard",
        },
        completionDirectOrigin: {
          channel: "webchat",
          to: "session:dashboard",
        },
        sourceTool: "music_generate",
        bestEffortDeliver: true,
      }),
    );
    const announceParams = subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mock
      .calls[0]?.[0] as { triggerMessage?: string; internalEvents?: unknown[] } | undefined;
    expect(announceParams?.triggerMessage).toContain("MEDIA:/tmp/generated-night-drive.mp3");
    expect(announceParams?.internalEvents).toEqual([
      expect.objectContaining({
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        attachments: [
          expect.objectContaining({
            path: "/tmp/generated-night-drive.mp3",
          }),
        ],
      }),
    ]);
    expect(taskRegistryDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not direct-deliver generated media after requester abandonment", async () => {
    // Abandoned requester sessions are terminal; direct delivery would re-open a
    // conversation the task lifecycle already decided to stop.
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    const lifecycle = createImageMediaLifecycle();

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
    const lifecycle = createImageMediaLifecycle();

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
