import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import * as musicGenerationRuntime from "../../music-generation/runtime.js";
import * as musicGenerateBackground from "./music-generate-background.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

const taskExecutorMocks = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

const mediaStoreMocks = vi.hoisted(() => ({
  saveMediaBuffer: vi.fn(),
}));

const musicGenerationRuntimeMocks = vi.hoisted(() => ({
  generateMusic: vi.fn(),
  listRuntimeMusicGenerationProviders: vi.fn(),
}));

const musicGenerateBackgroundMocks = vi.hoisted(() => ({
  completeMusicGenerationTaskRun: vi.fn((params) => {
    if (!params.handle) {
      return;
    }
    taskExecutorMocks.completeTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
    });
  }),
  createMusicGenerationTaskRun: vi.fn((params) => {
    const sessionKey = params.sessionKey?.trim();
    if (!sessionKey) {
      return null;
    }
    const runId = "tool:music_generate:test-run";
    const task = taskExecutorMocks.createRunningTaskRun({
      runId,
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      task: params.prompt,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    return {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterOrigin: params.requesterOrigin,
      taskLabel: params.prompt,
    };
  }),
  failMusicGenerationTaskRun: vi.fn((params) => {
    if (!params.handle) {
      return;
    }
    taskExecutorMocks.failTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
    });
  }),
  recordMusicGenerationTaskProgress: vi.fn((params) => {
    if (!params.handle) {
      return;
    }
    taskExecutorMocks.recordTaskRunProgressByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      progressSummary: params.progressSummary,
      eventSummary: params.eventSummary,
    });
  }),
  wakeMusicGenerationTaskCompletion: vi.fn(),
}));

vi.mock("../../config/config.js", () => configMocks);
vi.mock("../../media/store.js", () => mediaStoreMocks);
vi.mock("../../media/web-media.js", () => ({
  loadWebMedia: vi.fn(),
}));
vi.mock("../../music-generation/runtime.js", () => musicGenerationRuntimeMocks);
vi.mock("./music-generate-background.js", () => musicGenerateBackgroundMocks);
vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);
vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("createMusicGenerateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
    taskExecutorMocks.createRunningTaskRun.mockReset();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.recordTaskRunProgressByRunId.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no music-generation config or auth-backed provider is available", () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
    expect(createMusicGenerateTool({ config: asConfig({}) })).toBeNull();
  });

  it("registers when music-generation config is present", () => {
    expect(
      createMusicGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
            },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("generates tracks, saves them, and emits MEDIA paths without a session-backed detach", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "night-drive synthwave",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      provider: "google",
      model: "lyria-3-clip-preview",
      attempts: [],
      ignoredOverrides: [],
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "night-drive.mp3",
        },
      ],
      lyrics: ["wake the city up"],
      metadata: { taskId: "music-task-1" },
    });
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-night-drive.mp3",
      id: "generated-night-drive.mp3",
      size: 11,
      contentType: "audio/mpeg",
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            mediaMaxMb: 8,
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "night-drive synthwave",
      instrumental: true,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(saveSpy).toHaveBeenCalledWith(
      Buffer.from("music-bytes"),
      "audio/mpeg",
      "tool-music-generation",
      8 * 1024 * 1024,
      "night-drive.mp3",
    );
    expect(text).toContain("Generated 1 track with google/lyria-3-clip-preview.");
    expect(text).toContain("Lyrics returned.");
    expect(text).toContain("MEDIA:/tmp/generated-night-drive.mp3");
    expect(result.details).toMatchObject({
      provider: "google",
      model: "lyria-3-clip-preview",
      count: 1,
      instrumental: true,
      lyrics: ["wake the city up"],
      media: {
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      },
      paths: ["/tmp/generated-night-drive.mp3"],
      metadata: { taskId: "music-task-1" },
    });
    expect(taskExecutorMocks.createRunningTaskRun).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("starts background generation and wakes the session with MEDIA lines", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "night-drive synthwave",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    const wakeSpy = vi
      .spyOn(musicGenerateBackground, "wakeMusicGenerationTaskCompletion")
      .mockResolvedValue(undefined);
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      provider: "google",
      model: "lyria-3-clip-preview",
      attempts: [],
      ignoredOverrides: [],
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "night-drive.mp3",
        },
      ],
      metadata: { taskId: "music-task-1" },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-night-drive.mp3",
      id: "generated-night-drive.mp3",
      size: 11,
      contentType: "audio/mpeg",
    });

    let scheduledWork: (() => Promise<void>) | undefined;
    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
      agentSessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      scheduleBackgroundWork: (work) => {
        scheduledWork = work;
      },
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "night-drive synthwave",
      instrumental: true,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Background task started for music generation (task-123).");
    expect(text).toContain("Do not call music_generate again for this request.");
    expect(result.details).toMatchObject({
      async: true,
      status: "started",
      task: {
        taskId: "task-123",
      },
      instrumental: true,
    });
    expect(typeof scheduledWork).toBe("function");
    await scheduledWork?.();
    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:music_generate:/),
        progressSummary: "Generating music",
      }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:music_generate:/),
      }),
    );
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          taskId: "task-123",
        }),
        status: "ok",
        result: expect.stringContaining("MEDIA:/tmp/generated-night-drive.mp3"),
      }),
    );
  });

  it("lists provider capabilities", async () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([
      {
        id: "minimax",
        defaultModel: "music-2.5+",
        models: ["music-2.5+"],
        capabilities: {
          generate: {
            maxTracks: 1,
            supportsLyrics: true,
            supportsInstrumental: true,
            supportsDuration: true,
            supportsFormat: true,
            supportedFormats: ["mp3"],
          },
        },
        generateMusic: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.5+" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("supportedFormats=mp3");
    expect(text).toContain("instrumental");
  });

  it("warns when optional provider overrides are ignored", async () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([
      {
        id: "google",
        defaultModel: "lyria-3-clip-preview",
        models: ["lyria-3-clip-preview"],
        capabilities: {
          generate: {
            supportsLyrics: true,
            supportsInstrumental: true,
            supportsFormat: true,
            supportedFormatsByModel: {
              "lyria-3-clip-preview": ["mp3"],
            },
          },
        },
        generateMusic: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      provider: "google",
      model: "lyria-3-clip-preview",
      attempts: [],
      ignoredOverrides: [
        { key: "durationSeconds", value: 30 },
        { key: "format", value: "wav" },
      ],
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "molty-anthem.mp3",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/molty-anthem.mp3",
      id: "molty-anthem.mp3",
      size: 11,
      contentType: "audio/mpeg",
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-google-generate", {
      prompt: "OpenClaw anthem",
      instrumental: true,
      durationSeconds: 30,
      format: "wav",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 track with google/lyria-3-clip-preview.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for google/lyria-3-clip-preview: durationSeconds=30, format=wav.",
    );
    expect(result).toMatchObject({
      details: {
        instrumental: true,
        warning:
          "Ignored unsupported overrides for google/lyria-3-clip-preview: durationSeconds=30, format=wav.",
        ignoredOverrides: [
          { key: "durationSeconds", value: 30 },
          { key: "format", value: "wav" },
        ],
      },
    });
    expect(result.details).not.toHaveProperty("durationSeconds");
    expect(result.details).not.toHaveProperty("format");
  });

  it("surfaces normalized durations from runtime metadata", async () => {
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      provider: "minimax",
      model: "music-2.5+",
      attempts: [],
      ignoredOverrides: [],
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "night-drive.mp3",
        },
      ],
      normalization: {
        durationSeconds: {
          requested: 45,
          applied: 30,
        },
      },
      metadata: {
        requestedDurationSeconds: 45,
        normalizedDurationSeconds: 30,
      },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-night-drive.mp3",
      id: "generated-night-drive.mp3",
      size: 11,
      contentType: "audio/mpeg",
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.5+" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "night-drive synthwave",
      durationSeconds: 45,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Duration normalized: requested 45s; used 30s.");
    expect(result.details).toMatchObject({
      durationSeconds: 30,
      requestedDurationSeconds: 45,
      normalization: {
        durationSeconds: {
          requested: 45,
          applied: 30,
        },
      },
    });
  });
});
