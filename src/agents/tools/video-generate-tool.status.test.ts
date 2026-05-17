import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as videoGenerationRuntime from "../../video-generation/runtime.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

function resetVideoStatusMocks() {
  vi.restoreAllMocks();
  vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);
  taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
  taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
}

describe("createVideoGenerateTool status actions", () => {
  beforeEach(resetVideoStatusMocks);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns active task status instead of starting a duplicate generation", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-active",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:video_generate:active",
        task: "friendly lobster surfing",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
    ]);

    const result = createVideoGenerateDuplicateGuardResult("agent:main:discord:direct:123");

    const [content] = result?.content ?? [];
    expect(result?.content).toStrictEqual([
      {
        type: "text",
        text: "Video generation task task-active is already running with openai.\nProgress: Generating video.\nDo not call video_generate again for this request. Wait for the completion event; the completion agent will send the finished video here.",
      },
    ]);
    const text = content?.text ?? "";
    expect(text).toContain("Video generation task task-active is already running with openai.");
    expect(text).toContain("Do not call video_generate again for this request.");
    const details = result?.details as
      | {
          action?: unknown;
          duplicateGuard?: unknown;
          active?: unknown;
          existingTask?: unknown;
          status?: unknown;
          taskKind?: unknown;
          provider?: unknown;
          task?: { taskId?: unknown; runId?: unknown };
          progressSummary?: unknown;
        }
      | undefined;
    expect(details?.action).toBe("status");
    expect(details?.duplicateGuard).toBe(true);
    expect(details?.active).toBe(true);
    expect(details?.existingTask).toBe(true);
    expect(details?.status).toBe("running");
    expect(details?.taskKind).toBe(VIDEO_GENERATION_TASK_KIND);
    expect(details?.provider).toBe("openai");
    expect(details?.task?.taskId).toBe("task-active");
    expect(details?.task?.runId).toBe("tool:video_generate:active");
    expect(details?.progressSummary).toBe("Generating video");
  });

  it("reports active task status when action=status is requested", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-active",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:google",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:video_generate:active",
        task: "friendly lobster surfing",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Queued video generation",
      },
    ]);

    const result = createVideoGenerateStatusActionResult("agent:main:discord:direct:123");
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Video generation task task-active is already queued with google.");
    const details = result.details as {
      action?: unknown;
      active?: unknown;
      existingTask?: unknown;
      status?: unknown;
      taskKind?: unknown;
      provider?: unknown;
      task?: { taskId?: unknown };
      progressSummary?: unknown;
    };
    expect(details.action).toBe("status");
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("queued");
    expect(details.taskKind).toBe(VIDEO_GENERATION_TASK_KIND);
    expect(details.provider).toBe("google");
    expect(details.task?.taskId).toBe("task-active");
    expect(details.progressSummary).toBe("Queued video generation");
  });
});
