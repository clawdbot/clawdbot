import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createMediaGenerationTaskStatusOwner,
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
} from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listFreshTasksForOwnerKey: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);
vi.mock("../config/config.js", () => configMocks);

const videoTaskStatusOwner = createMediaGenerationTaskStatusOwner({
  taskKind: "video_generation",
  toolName: "video_generate",
  nounLabel: "video",
  completionLabel: "video",
  promptCompletionLabel: "video",
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-1",
    runtime: "cli",
    taskKind: "video_generation",
    sourceId: "video_generate:byteplus",
    requesterSessionKey: "session/A",
    ownerKey: "session/A",
    scopeKind: "session",
    runId: "run-1",
    task: "generate clip 01",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now,
    startedAt: now,
    lastEventAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  resetRecentMediaGenerationDuplicateGuardsForTests();
  taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
  configMocks.getRuntimeConfig.mockReset().mockReturnValue({
    session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
  });
});

describe("media generation delivery-phase prompt guard", () => {
  it("does not warn about a task waiting only for completion delivery", () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS }),
    ]);

    expect(
      videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A"),
    ).toBeUndefined();
  });

  it("carries only bounded single-line facts while media generation is running", () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({
        taskId: `task-${"t".repeat(150)}`,
        sourceId: `video_generate:${"p".repeat(150)}`,
        progressSummary: `Generating\nvideo\u2028${"x".repeat(400)}`,
      }),
    ]);

    expect(videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A")).toBe(
      `- tool=video_generate; task=task-${"t".repeat(123)}; status=running; provider_json="${"p".repeat(128)}"; progress_json="Generatingvideo${"x".repeat(305)}"`,
    );
  });

  it("keeps a bounded task snapshot stable across registry order and elapsed time", () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeTask({
        taskId: `task-${index}`,
        sourceId: "video_generate",
        status: index % 2 === 0 ? "queued" : "running",
      }),
    );
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue(tasks.toReversed());

    const context = videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A");
    expect(context).toBe(
      [
        "- tool=video_generate; task=task-0; status=queued",
        "- tool=video_generate; task=task-1; status=running",
        "- tool=video_generate; task=task-2; status=queued",
        "- tool=video_generate; task=task-3; status=running",
        "- tool=video_generate; task=task-4; status=queued",
        "- tool=video_generate; task=task-5; status=running",
        "- tool=video_generate; task=task-6; status=queued",
        "- tool=video_generate; task=task-7; status=running",
        "- additional_tasks=2",
      ].join("\n"),
    );

    for (const task of tasks) {
      task.lastEventAt = task.createdAt + 60_000;
    }
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue(tasks);
    expect(videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A")).toBe(context);
  });

  it("keeps delivery-phase tasks available to duplicate/status lookups", () => {
    const task = makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(videoTaskStatusOwner.listActiveTasksForSession("session/A")).toEqual([task]);
    expect(videoTaskStatusOwner.findActiveTaskForSession("session/A")).toEqual(task);
  });

  it("keeps restored legacy bare tasks visible only to their persisted requester owner", () => {
    const task = makeTask({
      requesterSessionKey: "global",
      ownerKey: "global",
      requesterAgentId: undefined,
      agentId: "research",
      progressSummary: "Generating video",
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(videoTaskStatusOwner.listActiveTasksForSession("global", "ops")).toEqual([task]);
    expect(videoTaskStatusOwner.findActiveTaskForSession("global", { agentId: "ops" })).toEqual(
      task,
    );
    expect(videoTaskStatusOwner.listActiveTasksForSession("global", "research")).toEqual([]);
  });

  it("blocks the same prompt while allowing a distinct prompt", () => {
    const task = makeTask({
      task: "generate clip 01",
      progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(
      videoTaskStatusOwner.findDuplicateGuardTaskForSession("session/A", {
        prompt: "generate clip 01",
      }),
    ).toEqual(task);
    expect(
      videoTaskStatusOwner.findDuplicateGuardTaskForSession("session/A", {
        prompt: "generate clip 02",
      }),
    ).toBeUndefined();
  });
});
