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
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(result?.content).toHaveLength(1);
    expect(text).toContain("Music generation task task-active is already running with google.");
    expect(text).toContain("Do not call music_generate again for this request.");
    expect(result?.details).toMatchObject({
      action: "status",
      duplicateGuard: true,
      active: true,
      existingTask: true,
      status: "running",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      provider: "google",
      task: {
        taskId: "task-active",
        runId: "tool:music_generate:active",
      },
      progressSummary: "Generating music",
    });
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
    expect(result.details).toMatchObject({
      action: "status",
      active: true,
      existingTask: true,
      status: "queued",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      provider: "minimax",
      task: {
        taskId: "task-active",
      },
      progressSummary: "Queued music generation",
    });
  });
});
