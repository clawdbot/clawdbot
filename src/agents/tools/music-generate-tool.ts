import { Type } from "typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveMusicGenerationModeCapabilities } from "../../music-generation/capabilities.js";
import { parseMusicGenerationModelRef } from "../../music-generation/model-ref.js";
import {
  generateMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import type { MusicGenerationOutputFormat } from "../../music-generation/types.js";
import type {
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  applyMusicGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  normalizeMediaReferenceInputs,
  readBooleanToolParam,
  readGenerationTimeoutMs,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
import {
  completeMusicGenerationTaskRun,
  createMusicGenerationTaskRun,
  failMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  type MusicGenerationTaskHandle,
  wakeMusicGenerationTaskCompletion,
} from "./music-generate-background.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateListActionResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES = 10;
const SUPPORTED_OUTPUT_FORMATS = new Set<MusicGenerationOutputFormat>(["mp3", "wav"]);
const DEFAULT_REFERENCE_FETCH_TIMEOUT_MS = 30_000;

const MusicGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default), "status" to inspect the active session task, or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Music generation prompt." })),
  lyrics: Type.Optional(
    Type.String({
      description: "Optional lyrics to guide sung output when the provider supports it.",
    }),
  ),
  instrumental: Type.Optional(
    Type.Boolean({
      description: "Optional toggle for instrumental-only output when the provider supports it.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description: "Optional single reference image path or URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional provider/model override, e.g. google/lyria-3-pro-preview.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      description: "Optional target duration in seconds when the provider supports duration hints.",
      minimum: 1,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Optional provider request timeout in milliseconds.",
      minimum: 1,
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: 'Optional output format hint: "mp3" or "wav" when the provider supports it.',
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename hint. OpenClaw preserves the basename and saves under its managed media directory.",
    }),
  ),
});

export function resolveMusicGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    modelConfig: params.cfg?.agents?.defaults?.musicGenerationModel,
    providers: listRuntimeMusicGenerationProviders({ config: params.cfg }),
  });
}

function resolveSelectedMusicGenerationProvider(params: {
  config?: OpenClawConfig;
  musicGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): MusicGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: listRuntimeMusicGenerationProviders({ config: params.config }),
    modelConfig: params.musicGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
  });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  return resolveGenerateAction({
    args,
    allowed: ["generate", "status", "list"],
    defaultAction: "generate",
  });
}

function normalizeOutputFormat(raw: string | undefined): MusicGenerationOutputFormat | undefined {
  const normalized = normalizeOptionalLowercaseString(raw) as
    | MusicGenerationOutputFormat
    | undefined;
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_OUTPUT_FORMATS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError('format must be one of "mp3" or "wav"');
}

function normalizeReferenceImageInputs(args: Record<string, unknown>): string[] {
  return normalizeMediaReferenceInputs({
    args,
    singularKey: "image",
    pluralKey: "images",
    maxCount: MAX_INPUT_IMAGES,
    label: "reference images",
  });
}

function validateMusicGenerationCapabilities(params: {
  provider: MusicGenerationProvider | undefined;
  model?: string;
  inputImageCount: number;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
    provider,
    inputImageCount: params.inputImageCount,
  });
  if (params.inputImageCount > 0) {
    if (!caps) {
      throw new ToolInputError(`${provider.id} does not support reference-image edit inputs.`);
    }
    if ("enabled" in caps && !caps.enabled) {
      throw new ToolInputError(`${provider.id} does not support reference-image edit inputs.`);
    }
    const maxInputImages =
      ("maxInputImages" in caps ? caps.maxInputImages : undefined) ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
  if (!caps) {
    return;
  }
}

type MusicGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

type MusicGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

function defaultScheduleMusicGenerateBackgroundWork(work: () => Promise<void>) {
  queueMicrotask(() => {
    void work().catch((error) => {
      log.error("Detached music generation job crashed", {
        error,
      });
    });
  });
}

async function loadReferenceImages(params: {
  inputs: string[];
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
}): Promise<
  Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }> = [];

  for (const rawInput of params.inputs) {
    const trimmed = rawInput.trim();
    const inputRaw = normalizeMediaReferenceSource(
      trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed,
    );
    if (!inputRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const refInfo = classifyMediaReferenceSource(inputRaw);
    const { isDataUrl, isHttpUrl } = refInfo;
    if (refInfo.hasUnsupportedScheme) {
      throw new ToolInputError(
        `Unsupported image reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError("Sandboxed music_generate does not allow remote image URLs.");
    }

    const resolvedInput = params.sandboxConfig
      ? inputRaw
      : inputRaw.startsWith("~")
        ? resolveUserPath(inputRaw)
        : inputRaw;
    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedInput,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedInput.startsWith("file://")
              ? resolvedInput.slice("file://".length)
              : resolvedInput,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );
    const media = isDataUrl
      ? decodeDataUrl(resolvedInput)
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedInput, {
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await (async () => {
            const { signal, cleanup } = buildTimeoutAbortSignal({
              timeoutMs: params.timeoutMs ?? DEFAULT_REFERENCE_FETCH_TIMEOUT_MS,
            });
            try {
              return await loadWebMedia(resolvedPath ?? resolvedInput, {
                localRoots,
                requestInit: signal ? { signal } : undefined,
                ssrfPolicy: params.ssrfPolicy,
              });
            } finally {
              cleanup();
            }
          })();
    if (media.kind !== "image") {
      throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
    }
    const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
    const fileName = "fileName" in media ? media.fileName : undefined;
    loaded.push({
      sourceImage: {
        buffer: media.buffer,
        mimeType,
        fileName,
      },
      resolvedInput,
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

type LoadedReferenceImage = Awaited<ReturnType<typeof loadReferenceImages>>[number];

type ExecutedMusicGeneration = {
  provider: string;
  model: string;
  savedPaths: string[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

async function executeMusicGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  filename?: string;
  loadedReferenceImages: LoadedReferenceImage[];
  taskHandle?: MusicGenerationTaskHandle | null;
  timeoutMs?: number;
}): Promise<ExecutedMusicGeneration> {
  if (params.taskHandle) {
    recordMusicGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating music",
    });
  }
  const result = await generateMusic({
    cfg: params.effectiveCfg,
    prompt: params.prompt,
    agentDir: params.agentDir,
    modelOverride: params.model,
    lyrics: params.lyrics,
    instrumental: params.instrumental,
    durationSeconds: params.durationSeconds,
    format: params.format,
    inputImages: params.loadedReferenceImages.map((entry) => entry.sourceImage),
    timeoutMs: params.timeoutMs,
  });
  if (params.taskHandle) {
    recordMusicGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated music",
    });
  }
  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "audio");
  const savedTracks = await Promise.all(
    result.tracks.map((track) =>
      saveMediaBuffer(
        track.buffer,
        track.mimeType,
        "tool-music-generation",
        mediaMaxBytes,
        params.filename || track.fileName,
      ),
    ),
  );
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const runtimeNormalizedDurationSeconds =
    result.normalization?.durationSeconds?.applied ??
    (typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : undefined);
  const appliedDurationSeconds =
    runtimeNormalizedDurationSeconds ??
    (!ignoredOverrideKeys.has("durationSeconds") && typeof params.durationSeconds === "number"
      ? params.durationSeconds
      : undefined);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map((entry) => `${entry.key}=${String(entry.value)}`).join(", ")}.`
      : undefined;
  const lines = [
    `Generated ${savedTracks.length} track${savedTracks.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    typeof requestedDurationSeconds === "number" &&
    typeof appliedDurationSeconds === "number" &&
    requestedDurationSeconds !== appliedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${appliedDurationSeconds}s.`
      : null,
    ...(result.lyrics?.length ? ["Lyrics returned.", ...result.lyrics] : []),
    ...savedTracks.map((track) => `MEDIA:${track.path}`),
  ].filter((entry): entry is string => Boolean(entry));
  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedTracks.map((track) => track.path),
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedTracks.length,
      media: {
        mediaUrls: savedTracks.map((track) => track.path),
      },
      paths: savedTracks.map((track) => track.path),
      ...buildTaskRunDetails(params.taskHandle),
      ...(!ignoredOverrideKeys.has("lyrics") && params.lyrics
        ? { requestedLyrics: params.lyrics }
        : {}),
      ...(!ignoredOverrideKeys.has("instrumental") && typeof params.instrumental === "boolean"
        ? { instrumental: params.instrumental }
        : {}),
      ...(typeof appliedDurationSeconds === "number"
        ? { durationSeconds: appliedDurationSeconds }
        : {}),
      ...(typeof requestedDurationSeconds === "number" &&
      typeof appliedDurationSeconds === "number" &&
      requestedDurationSeconds !== appliedDurationSeconds
        ? { requestedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("format") && params.format ? { format: params.format } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedInput,
      }),
      ...(result.lyrics?.length ? { lyrics: result.lyrics } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
  };
}

export function createMusicGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: MusicGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MusicGenerateBackgroundScheduler;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? loadConfig();
  const musicGenerationModelConfig = resolveMusicGenerationModelConfigForTool({
    cfg,
    agentDir: options?.agentDir,
  });
  if (!musicGenerationModelConfig) {
    return null;
  }

  const sandboxConfig = options?.sandbox
    ? {
        root: options.sandbox.root,
        bridge: options.sandbox.bridge,
        workspaceOnly: options.fsPolicy?.workspaceOnly === true,
      }
    : null;
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleMusicGenerateBackgroundWork;

  return {
    label: "Music Generation",
    name: "music_generate",
    displaySummary: "Generate music",
    description:
      "Generate music using configured providers. Generated tracks are saved under OpenClaw-managed media storage and delivered automatically as attachments.",
    parameters: MusicGenerateToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);
      const effectiveCfg =
        applyMusicGenerationModelConfigDefaults(cfg, musicGenerationModelConfig) ?? cfg;

      if (action === "list") {
        return createMusicGenerateListActionResult(effectiveCfg);
      }

      if (action === "status") {
        return createMusicGenerateStatusActionResult(options?.agentSessionKey);
      }

      const duplicateGuardResult = createMusicGenerateDuplicateGuardResult(
        options?.agentSessionKey,
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }

      const prompt = readStringParam(args, "prompt", { required: true });
      const lyrics = readStringParam(args, "lyrics");
      const instrumental = readBooleanToolParam(args, "instrumental");
      const model = readStringParam(args, "model");
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        integer: true,
        strict: true,
      });
      const format = normalizeOutputFormat(readStringParam(args, "format"));
      const filename = readStringParam(args, "filename");
      const timeoutMs = readGenerationTimeoutMs(args);
      const imageInputs = normalizeReferenceImageInputs(args);
      const selectedProvider = resolveSelectedMusicGenerationProvider({
        config: effectiveCfg,
        musicGenerationModelConfig,
        modelOverride: model,
      });
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
      const loadedReferenceImages = await loadReferenceImages({
        inputs: imageInputs,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
        timeoutMs,
      });
      validateMusicGenerationCapabilities({
        provider: selectedProvider,
        model:
          parseMusicGenerationModelRef(model)?.model ?? model ?? selectedProvider?.defaultModel,
        inputImageCount: loadedReferenceImages.length,
        lyrics,
        instrumental,
        durationSeconds,
        format,
      });
      const taskHandle = createMusicGenerationTaskRun({
        sessionKey: options?.agentSessionKey,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        providerId: selectedProvider?.id,
      });
      const shouldDetach = Boolean(taskHandle && options?.agentSessionKey?.trim());

      if (shouldDetach) {
        scheduleBackgroundWork(async () => {
          try {
            const executed = await executeMusicGenerationJob({
              effectiveCfg,
              prompt,
              agentDir: options?.agentDir,
              model,
              lyrics,
              instrumental,
              durationSeconds,
              format,
              filename,
              loadedReferenceImages,
              taskHandle,
              timeoutMs,
            });
            completeMusicGenerationTaskRun({
              handle: taskHandle,
              provider: executed.provider,
              model: executed.model,
              count: executed.savedPaths.length,
              paths: executed.savedPaths,
            });
            try {
              await wakeMusicGenerationTaskCompletion({
                config: effectiveCfg,
                handle: taskHandle,
                status: "ok",
                statusLabel: "completed successfully",
                result: executed.wakeResult,
                mediaUrls: executed.savedPaths,
              });
            } catch (error) {
              log.warn("Music generation completion wake failed after successful generation", {
                taskId: taskHandle?.taskId,
                runId: taskHandle?.runId,
                error,
              });
            }
          } catch (error) {
            failMusicGenerationTaskRun({
              handle: taskHandle,
              error,
            });
            await wakeMusicGenerationTaskCompletion({
              config: effectiveCfg,
              handle: taskHandle,
              status: "error",
              statusLabel: "failed",
              result: formatErrorMessage(error),
            });
            return;
          }
        });

        return {
          content: [
            {
              type: "text",
              text: `Background task started for music generation (${taskHandle?.taskId ?? "unknown"}). Do not call music_generate again for this request. Wait for the completion event; I'll post the finished music here when it's ready.`,
            },
          ],
          details: {
            async: true,
            status: "started",
            ...buildTaskRunDetails(taskHandle),
            ...buildMediaReferenceDetails({
              entries: loadedReferenceImages,
              singleKey: "image",
              pluralKey: "images",
              getResolvedInput: (entry) => entry.resolvedInput,
            }),
            ...(model ? { model } : {}),
            ...(lyrics ? { requestedLyrics: lyrics } : {}),
            ...(typeof instrumental === "boolean" ? { instrumental } : {}),
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(format ? { format } : {}),
            ...(filename ? { filename } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        };
      }

      try {
        const executed = await executeMusicGenerationJob({
          effectiveCfg,
          prompt,
          agentDir: options?.agentDir,
          lyrics,
          instrumental,
          durationSeconds,
          model,
          format,
          filename,
          loadedReferenceImages,
          taskHandle,
          timeoutMs,
        });
        completeMusicGenerationTaskRun({
          handle: taskHandle,
          provider: executed.provider,
          model: executed.model,
          count: executed.savedPaths.length,
          paths: executed.savedPaths,
        });
        return {
          content: [{ type: "text", text: executed.contentText }],
          details: executed.details,
        };
      } catch (error) {
        failMusicGenerationTaskRun({
          handle: taskHandle,
          error,
        });
        throw error;
      }
    },
  };
}
