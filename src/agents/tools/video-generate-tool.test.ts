import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MAX_VIDEO_BYTES } from "../../media/constants.js";
import * as mediaStore from "../../media/store.js";
import * as webMedia from "../../media/web-media.js";
import * as videoGenerationRuntime from "../../video-generation/runtime.js";
import * as videoGenerateBackground from "./video-generate-background.js";
import {
  createVideoGenerateTool,
  resolveVideoGenerationModelConfigForTool,
} from "./video-generate-tool.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

const taskExecutorMocks = vi.hoisted(() => ({
  recordTaskRunProgressByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(),
}));

const VIDEO_GENERATION_PROVIDER_AUTH_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "GOOGLE_API_KEYS",
  "DEEPINFRA_API_KEY",
  "MODELSTUDIO_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "BYTEPLUS_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "FAL_KEY",
  "FAL_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "RUNWAYML_API_SECRET",
  "RUNWAY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "VYDRA_API_KEY",
] as const;

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);
vi.mock("../../tasks/detached-task-runtime.js", () => taskExecutorMocks);

const GENERATION_PROVIDER_ENV_VARS = [
  "BYTEPLUS_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPINFRA_API_KEY",
  "FAL_API_KEY",
  "FAL_KEY",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "GOOGLE_API_KEYS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "LITELLM_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_OAUTH_TOKEN",
  "MODELSTUDIO_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENROUTER_API_KEY",
  "QWEN_API_KEY",
  "RUNWAY_API_KEY",
  "RUNWAYML_API_SECRET",
  "TOGETHER_API_KEY",
  "VYDRA_API_KEY",
  "XAI_API_KEY",
];

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function expectVideoGenerateTool(
  tool: ReturnType<typeof createVideoGenerateTool>,
): NonNullable<ReturnType<typeof createVideoGenerateTool>> {
  if (tool === null) {
    throw new Error("expected video_generate tool");
  }
  expect(typeof tool.execute).toBe("function");
  return tool;
}

function mockVideoPluginProvider(capabilities: Record<string, unknown> = {}) {
  vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
    {
      id: "video-plugin",
      defaultModel: "vid-v1",
      models: ["vid-v1"],
      capabilities,
      generateVideo: vi.fn(async () => ({
        videos: [{ buffer: Buffer.from("x"), mimeType: "video/mp4" }],
      })),
    },
  ]);
}

function createVideoPluginTool() {
  const tool = createVideoGenerateTool({
    config: asConfig({
      agents: {
        defaults: {
          videoGenerationModel: { primary: "video-plugin/vid-v1" },
        },
      },
    }),
  });
  if (!tool) {
    throw new Error("expected video_generate tool");
  }
  return tool;
}

function mockSavedVideoResult(fileName = "out.mp4") {
  const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
    provider: "video-plugin",
    model: "vid-v1",
    attempts: [],
    ignoredOverrides: [],
    videos: [{ buffer: Buffer.from("video-bytes"), mimeType: "video/mp4", fileName }],
  });
  vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
    path: `/tmp/${fileName}`,
    id: fileName,
    size: 11,
    contentType: "video/mp4",
  });
  return generateSpy;
}

function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(result.details).toBeDefined();
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

function firstMockCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
  const firstCall = mock.mock.calls[0];
  expect(firstCall).toBeDefined();
  return firstCall[0];
}

function resetVideoGenerateMocks() {
  vi.restoreAllMocks();
  for (const key of VIDEO_GENERATION_PROVIDER_AUTH_ENV_VARS) {
    vi.stubEnv(key, "");
  }
  vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);
  taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
  taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
  taskExecutorMocks.createRunningTaskRun.mockReset();
  taskExecutorMocks.completeTaskRunByRunId.mockReset();
  taskExecutorMocks.failTaskRunByRunId.mockReset();
  taskExecutorMocks.recordTaskRunProgressByRunId.mockReset();
}

describe("createVideoGenerateTool", () => {
  beforeEach(() => {
    resetVideoGenerateMocks();
    for (const envVar of GENERATION_PROVIDER_ENV_VARS) {
      vi.stubEnv(envVar, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no video-generation config or auth-backed provider is available", () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);

    expect(createVideoGenerateTool({ config: asConfig({}) })).toBeNull();
  });

  it("registers when video-generation config is present", () => {
    expectVideoGenerateTool(
      createVideoGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
            },
          },
        }),
      }),
    );
  });

  it("does not load runtime providers while registering an explicitly configured tool", () => {
    const listProviders = vi
      .spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders")
      .mockImplementation(() => {
        throw new Error("runtime provider list should not run during tool registration");
      });

    expectVideoGenerateTool(
      createVideoGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
            },
          },
        }),
      }),
    );
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("does not load runtime providers while resolving an explicitly configured model", () => {
    const listProviders = vi
      .spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders")
      .mockImplementation(() => {
        throw new Error("runtime provider list should not run for explicit video model config");
      });

    expect(
      resolveVideoGenerationModelConfigForTool({
        cfg: asConfig({
          agents: {
            defaults: {
              videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
            },
          },
        }),
      }),
    ).toEqual({ primary: "qwen/wan2.6-t2v" });
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("orders auto-detected provider defaults by canonical aliases", () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        id: "fal",
        defaultModel: "fal-ai/minimax/video-01-live",
        models: ["fal-ai/minimax/video-01-live"],
        capabilities: {},
        isConfigured: () => true,
        generateVideo: vi.fn(async () => ({ videos: [] })),
      },
      {
        id: "openai",
        aliases: ["openai-codex"],
        defaultModel: "sora-2",
        models: ["sora-2"],
        capabilities: {},
        isConfigured: () => true,
        generateVideo: vi.fn(async () => ({ videos: [] })),
      },
    ]);

    expect(
      resolveVideoGenerationModelConfigForTool({
        cfg: asConfig({
          agents: {
            defaults: {
              model: {
                primary: "openai-codex/gpt-5.5",
              },
            },
          },
        }),
      }),
    ).toEqual({
      primary: "openai/sora-2",
      fallbacks: ["fal/fal-ai/minimax/video-01-live"],
    });
  });

  it("generates videos, saves them, and emits MEDIA paths without a session-backed detach", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "friendly lobster surfing",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValue(undefined);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "qwen",
      model: "wan2.6-t2v",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      metadata: { taskId: "task-1" },
    });
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            mediaMaxMb: 8,
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
    });
    expect(typeof tool?.execute).toBe("function");
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { prompt: "friendly lobster surfing" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(saveSpy).toHaveBeenCalledWith(
      Buffer.from("video-bytes"),
      "video/mp4",
      "tool-video-generation",
      8 * 1024 * 1024,
      "lobster.mp4",
    );
    expect(text).toContain("Generated 1 video with qwen/wan2.6-t2v.");
    expect(text).toContain("MEDIA:/tmp/generated-lobster.mp4");
    const details = resultDetails(result);
    expect(details.provider).toBe("qwen");
    expect(details.model).toBe("wan2.6-t2v");
    expect(details.count).toBe(1);
    expect((details.media as { mediaUrls?: string[] }).mediaUrls).toEqual([
      "/tmp/generated-lobster.mp4",
    ]);
    expect(details.paths).toEqual(["/tmp/generated-lobster.mp4"]);
    expect(details.metadata).toEqual({ taskId: "task-1" });
    expect(taskExecutorMocks.createRunningTaskRun).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("uses the video media cap when mediaMaxMb is not configured", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "qwen",
      model: "wan2.6-t2v",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
    });
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await tool.execute("call-default-cap", { prompt: "friendly lobster surfing" });

    expect(saveSpy).toHaveBeenCalledWith(
      Buffer.from("video-bytes"),
      "video/mp4",
      "tool-video-generation",
      MAX_VIDEO_BYTES,
      "lobster.mp4",
    );
  });

  it("surfaces url-only generated videos without saving local files", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          url: "https://example.com/generated-lobster.mp4",
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      metadata: { taskId: "task-1" },
    });
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer");

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "vydra/veo3" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-url", { prompt: "friendly lobster surfing" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(saveSpy).not.toHaveBeenCalled();
    expect(text).toContain("Generated 1 video with vydra/veo3.");
    expect(text).toContain("MEDIA:https://example.com/generated-lobster.mp4");
    const details = resultDetails(result);
    expect(details.provider).toBe("vydra");
    expect(details.model).toBe("veo3");
    expect(details.count).toBe(1);
    expect((details.media as { mediaUrls?: string[] }).mediaUrls).toEqual([
      "https://example.com/generated-lobster.mp4",
    ]);
    expect(details.paths).toEqual(["https://example.com/generated-lobster.mp4"]);
    expect(details.metadata).toEqual({ taskId: "task-1" });
  });

  it("falls back to the provider URL when generated video persistence exceeds the media cap", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "fal",
      model: "fal-ai/minimax/video-01-live",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          buffer: Buffer.from("large-video-bytes"),
          url: "https://fal.run/files/generated-lobster.mp4",
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockRejectedValueOnce(
      new Error("Media exceeds 16MB limit"),
    );

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "fal/fal-ai/minimax/video-01-live" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-url-fallback", {
      prompt: "friendly lobster surfing",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 video with fal/fal-ai/minimax/video-01-live.");
    expect(text).toContain("MEDIA:https://fal.run/files/generated-lobster.mp4");
    const details = resultDetails(result);
    expect(details.provider).toBe("fal");
    expect(details.model).toBe("fal-ai/minimax/video-01-live");
    expect(details.count).toBe(1);
    expect((details.media as { mediaUrls?: string[] }).mediaUrls).toEqual([
      "https://fal.run/files/generated-lobster.mp4",
    ]);
    expect(details.paths).toEqual(["https://fal.run/files/generated-lobster.mp4"]);
  });

  it("starts background generation and wakes the session with url-only MEDIA lines", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "friendly lobster surfing",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    const wakeSpy = vi
      .spyOn(videoGenerateBackground, "wakeVideoGenerationTaskCompletion")
      .mockResolvedValue(undefined);
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer");
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          url: "https://example.com/generated-lobster.mp4",
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      metadata: { taskId: "task-1" },
    });

    let scheduledWork: (() => Promise<void>) | undefined;
    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "vydra/veo3" },
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
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { prompt: "friendly lobster surfing" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Background task started for video generation (task-123).");
    expect(text).toContain("Do not call video_generate again for this request.");
    const details = resultDetails(result);
    expect(details.async).toBe(true);
    expect(details.status).toBe("started");
    expect((details.task as { taskId?: string }).taskId).toBe("task-123");
    if (!scheduledWork) {
      throw new Error("expected scheduled video generation work");
    }
    await scheduledWork();
    expect(saveSpy).not.toHaveBeenCalled();
    const progress = firstMockCallArg(taskExecutorMocks.recordTaskRunProgressByRunId) as {
      runId: string;
      progressSummary: string;
    };
    expect(progress.runId).toMatch(/^tool:video_generate:/);
    expect(progress.progressSummary).toBe("Generating video");
    const completion = firstMockCallArg(taskExecutorMocks.completeTaskRunByRunId) as {
      runId: string;
    };
    expect(completion.runId).toMatch(/^tool:video_generate:/);
    const wake = firstMockCallArg(wakeSpy) as {
      handle: { taskId?: string };
      status: string;
      mediaUrls: string[];
      result: string;
    };
    expect(wake.handle.taskId).toBe("task-123");
    expect(wake.status).toBe("ok");
    expect(wake.mediaUrls).toEqual(["https://example.com/generated-lobster.mp4"]);
    expect(wake.result).toContain("MEDIA:https://example.com/generated-lobster.mp4");
  });

  it("surfaces provider generation failures inline when there is no detached session", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockRejectedValue(new Error("queue boom"));

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
    });
    expect(typeof tool?.execute).toBe("function");
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await expect(tool.execute("call-2", { prompt: "broken lobster" })).rejects.toThrow(
      "queue boom",
    );
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("shows duration normalization details from runtime metadata", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      normalization: {
        durationSeconds: {
          requested: 5,
          applied: 6,
          supportedValues: [4, 6, 8],
        },
      },
      metadata: {
        requestedDurationSeconds: 5,
        normalizedDurationSeconds: 6,
        supportedDurationSeconds: [4, 6, 8],
      },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "google/veo-3.1-fast-generate-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "friendly lobster surfing",
      durationSeconds: 5,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Duration normalized: requested 5s; used 6s.");
    const details = resultDetails(result);
    expect(details.durationSeconds).toBe(6);
    expect(details.requestedDurationSeconds).toBe(5);
    expect(details.supportedDurationSeconds).toEqual([4, 6, 8]);
    expect(
      (
        details.normalization as {
          durationSeconds?: { requested?: number; applied?: number; supportedValues?: number[] };
        }
      ).durationSeconds,
    ).toEqual({
      requested: 5,
      applied: 6,
      supportedValues: [4, 6, 8],
    });
  });

  it("surfaces normalized video geometry from runtime metadata", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "runway",
      model: "gen4.5",
      attempts: [],
      ignoredOverrides: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      normalization: {
        aspectRatio: {
          applied: "16:9",
          derivedFrom: "size",
        },
      },
      metadata: {
        requestedSize: "1280x720",
        normalizedAspectRatio: "16:9",
      },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "runway/gen4.5" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "friendly lobster surfing",
      size: "1280x720",
    });

    const details = resultDetails(result);
    expect(details.aspectRatio).toBe("16:9");
    expect(
      (details.normalization as { aspectRatio?: { applied?: string; derivedFrom?: string } })
        .aspectRatio,
    ).toEqual({
      applied: "16:9",
      derivedFrom: "size",
    });
    expect(details.metadata).toEqual({
      requestedSize: "1280x720",
      normalizedAspectRatio: "16:9",
    });
    expect(details).not.toHaveProperty("size");
  });

  it("lists supported provider durations when advertised", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        id: "google",
        defaultModel: "veo-3.1-fast-generate-preview",
        models: ["veo-3.1-fast-generate-preview"],
        capabilities: {
          generate: {
            maxDurationSeconds: 8,
            supportedDurationSeconds: [4, 6, 8],
          },
          imageToVideo: {
            enabled: true,
            maxInputImages: 1,
            maxDurationSeconds: 8,
            supportedDurationSeconds: [4, 6, 8],
          },
        },
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "google/veo-3.1-fast-generate-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("modes=generate/imageToVideo");
    expect(text).toContain("supportedDurationSeconds=4/6/8");
    const providers = resultDetails(result).providers as Array<{
      id?: string;
      modes?: string[];
    }>;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("google");
    expect(providers[0]?.modes).toEqual(["generate", "imageToVideo"]);
  });

  it("rejects image-to-video when the provider disables that mode", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        id: "video-plugin",
        defaultModel: "vid-v1",
        models: ["vid-v1"],
        capabilities: {
          imageToVideo: {
            enabled: false,
          },
        },
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo");

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await expect(
      tool.execute("call-1", {
        prompt: "lobster timelapse",
        image: "data:image/png;base64,cG5n",
      }),
    ).rejects.toThrow("video-plugin does not support image-to-video reference inputs.");
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("warns when optional provider overrides are ignored", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        id: "openai",
        defaultModel: "sora-2",
        models: ["sora-2"],
        capabilities: {
          generate: {
            supportsSize: true,
          },
        },
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "openai",
      model: "sora-2",
      attempts: [],
      ignoredOverrides: [
        { key: "resolution", value: "720P" },
        { key: "audio", value: false },
        { key: "watermark", value: false },
      ],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openai/sora-2" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-openai-generate", {
      prompt: "A lobster on a neon bridge",
      size: "1280x720",
      resolution: "720P",
      audio: false,
      watermark: false,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 video with openai/sora-2.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for openai/sora-2: resolution=720P, audio=false, watermark=false.",
    );
    const details = resultDetails(result);
    expect(details.size).toBe("1280x720");
    expect(details.warning).toBe(
      "Ignored unsupported overrides for openai/sora-2: resolution=720P, audio=false, watermark=false.",
    );
    expect(details.ignoredOverrides).toEqual([
      { key: "resolution", value: "720P" },
      { key: "audio", value: false },
      { key: "watermark", value: false },
    ]);
    expect(details).not.toHaveProperty("resolution");
    expect(details).not.toHaveProperty("audio");
    expect(details).not.toHaveProperty("watermark");
  });

  it("rejects providerOptions that is not a plain JSON object", async () => {
    mockVideoPluginProvider();
    const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo");
    const tool = createVideoPluginTool();

    // Array-shaped providerOptions should be rejected up front, not cast to a
    // Record with numeric-string keys and silently forwarded.
    await expect(
      tool.execute("call-1", {
        prompt: "lobster",
        providerOptions: ["seed", 42] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(
      "providerOptions must be a JSON object keyed by provider-specific option name.",
    );
    // String providerOptions should also be rejected.
    await expect(
      tool.execute("call-2", {
        prompt: "lobster",
        providerOptions: "seed=42" as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(
      "providerOptions must be a JSON object keyed by provider-specific option name.",
    );
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("forwards providerOptions to the runtime for valid JSON-object payloads", async () => {
    mockVideoPluginProvider({
      providerOptions: { seed: "number", draft: "boolean" },
    });
    const generateSpy = mockSavedVideoResult();
    const tool = createVideoPluginTool();

    await tool.execute("call-1", {
      prompt: "lobster",
      providerOptions: { seed: 42, draft: true },
    });

    const input = firstMockCallArg(generateSpy) as {
      autoProviderFallback?: boolean;
      providerOptions?: unknown;
    };
    expect(input.autoProviderFallback).toBe(false);
    expect(input.providerOptions).toEqual({ seed: 42, draft: true });
  });

  it("rejects *Roles arrays that are longer than the asset list", async () => {
    mockVideoPluginProvider({
      imageToVideo: { enabled: true, maxInputImages: 2 },
    });
    const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo");
    const tool = createVideoPluginTool();

    await expect(
      tool.execute("call-1", {
        prompt: "lobster",
        image: "data:image/png;base64,cG5n",
        // Only one image is provided, so passing two roles is an off-by-one bug.
        imageRoles: ["first_frame", "last_frame"],
      }),
    ).rejects.toThrow(/imageRoles has 2 entries but only 1 reference image/);
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("rejects *Roles that are not arrays", async () => {
    mockVideoPluginProvider();
    const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo");
    const tool = createVideoPluginTool();

    await expect(
      tool.execute("call-1", {
        prompt: "lobster",
        imageRoles: "first_frame" as unknown as string[],
      }),
    ).rejects.toThrow(
      "imageRoles must be a JSON array of role strings, parallel to the reference list.",
    );
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("attaches positional role hints to loaded reference assets", async () => {
    mockVideoPluginProvider({
      imageToVideo: { enabled: true, maxInputImages: 2 },
    });
    const generateSpy = mockSavedVideoResult();
    const tool = createVideoPluginTool();

    await tool.execute("call-1", {
      prompt: "lobster",
      images: ["data:image/png;base64,Zmlyc3Q=", "data:image/png;base64,bGFzdA=="],
      imageRoles: ["first_frame", "last_frame"],
    });

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const call = generateSpy.mock.calls[0]?.[0] as {
      inputImages?: Array<{ role?: string }>;
    };
    expect(call.inputImages).toHaveLength(2);
    expect(call.inputImages?.[0]?.role).toBe("first_frame");
    expect(call.inputImages?.[1]?.role).toBe("last_frame");
  });

  it("passes web_fetch SSRF policy when loading reference assets", async () => {
    mockVideoPluginProvider({
      imageToVideo: { enabled: true, maxInputImages: 1 },
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    mockSavedVideoResult();
    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
        tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await tool.execute("call-1", {
      prompt: "lobster",
      image: "/tmp/reference.png",
    });

    const loadCall = vi.mocked(webMedia.loadWebMedia).mock.calls[0];
    expect(loadCall?.[0]).toBe("/tmp/reference.png");
    const loadOptions = loadCall?.[1] as { ssrfPolicy?: unknown } | undefined;
    expect(loadOptions?.ssrfPolicy).toEqual({ allowRfc2544BenchmarkRange: true });
  });

  it("rejects audio data: URLs via the templated rejection branch", async () => {
    mockVideoPluginProvider({
      maxInputAudios: 1,
    });
    const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo");
    const tool = createVideoPluginTool();

    await expect(
      tool.execute("call-1", {
        prompt: "lobster",
        audioRef: "data:audio/mpeg;base64,bXAz",
      }),
    ).rejects.toThrow("audio data: URLs are not supported for video_generate.");
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("accepts aspectRatio=adaptive and forwards it to the runtime", async () => {
    mockVideoPluginProvider();
    const generateSpy = mockSavedVideoResult();
    const tool = createVideoPluginTool();

    await tool.execute("call-1", {
      prompt: "lobster",
      aspectRatio: "adaptive",
    });

    expect((firstMockCallArg(generateSpy) as { aspectRatio?: string }).aspectRatio).toBe(
      "adaptive",
    );
  });

  it("accepts provider-specific aspectRatio and resolution values and forwards them to the runtime", async () => {
    mockVideoPluginProvider();
    const generateSpy = mockSavedVideoResult();
    const tool = createVideoPluginTool();

    await tool.execute("call-1", {
      prompt: "lobster",
      aspectRatio: "17:9",
      resolution: "draft-large",
    });

    const input = firstMockCallArg(generateSpy) as { aspectRatio?: string; resolution?: string };
    expect(input.aspectRatio).toBe("17:9");
    expect(input.resolution).toBe("draft-large");
  });
});
