import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as musicGenerationRuntime from "../../music-generation/runtime.js";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

function resetMusicStatusMocks() {
  vi.restoreAllMocks();
  vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
  taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
  taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
}

describe("createMusicGenerateTool status actions", () => {
  beforeEach(resetMusicStatusMocks);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns active task status instead of starting a duplicate generation", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-active",
        runtime: "cli",
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourceId: "music_generate:google",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:music_generate:active",
        task: "night-drive synthwave",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating music",
      },
    ]);

    const result = createMusicGenerateDuplicateGuardResult("agent:main:discord:direct:123");

    const [content] = result?.content ?? [];
    expect(result?.content).toStrictEqual([
      {
        type: "text",
        text: "Music generation task task-active is already running with google.\nProgress: Generating music.\nDo not call music_generate again for this request. Wait for the completion event; I will post the finished music here.",
      },
    ]);
    const text = content?.text ?? "";
    expect(text).toContain("Music generation task task-active is already running with google.");
    expect(text).toContain("Do not call music_generate again for this request.");
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
    expect(details?.taskKind).toBe(MUSIC_GENERATION_TASK_KIND);
    expect(details?.provider).toBe("google");
    expect(details?.task?.taskId).toBe("task-active");
    expect(details?.task?.runId).toBe("tool:music_generate:active");
    expect(details?.progressSummary).toBe("Generating music");
  });

  it("reports active task status when action=status is requested", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-active",
        runtime: "cli",
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourceId: "music_generate:minimax",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:music_generate:active",
        task: "night-drive synthwave",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Queued music generation",
      },
    ]);

    const result = createMusicGenerateStatusActionResult("agent:main:discord:direct:123");
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Music generation task task-active is already queued with minimax.");
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
    expect(details.taskKind).toBe(MUSIC_GENERATION_TASK_KIND);
    expect(details.provider).toBe("minimax");
    expect(details.task?.taskId).toBe("task-active");
    expect(details.progressSummary).toBe("Queued music generation");
  });
});
