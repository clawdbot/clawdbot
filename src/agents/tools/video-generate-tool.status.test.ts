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
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(result?.content).toHaveLength(1);
    expect(text).toContain("Video generation task task-active is already running with openai.");
    expect(text).toContain("Do not call video_generate again for this request.");
    expect(result?.details).toMatchObject({
      action: "status",
      duplicateGuard: true,
      active: true,
      existingTask: true,
      status: "running",
      taskKind: VIDEO_GENERATION_TASK_KIND,
      provider: "openai",
      task: {
        taskId: "task-active",
        runId: "tool:video_generate:active",
      },
      progressSummary: "Generating video",
    });
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
    expect(result.details).toMatchObject({
      action: "status",
      active: true,
      existingTask: true,
      status: "queued",
      taskKind: VIDEO_GENERATION_TASK_KIND,
      provider: "google",
      task: {
        taskId: "task-active",
      },
      progressSummary: "Queued video generation",
    });
  });
});
