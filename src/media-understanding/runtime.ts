// Public file-oriented media-understanding runtime for image, audio, video, and
// structured extraction calls outside normal channel message handling.
import path from "node:path";
import { detectMime, kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";
import { normalizeImageDescriptionInput } from "./image-input-normalize.js";
import { describeImageWithModel } from "./image-runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./provider-registry.js";
import { resolveMediaRuntimeTimeoutMs } from "./resolve.js";
import { findDecisionReason, normalizeDecisionReason } from "./runner.entries.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type {
  DescribePreparedImageWithModelParams,
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  PrepareImageDescriptionInputParams,
  DescribeVideoFileParams,
  ExtractStructuredWithModelParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";
export type {
  DescribePreparedImageWithModelParams,
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  PreparedImageDescriptionInput,
  PrepareImageDescriptionInputParams,
  DescribeVideoFileParams,
  ExtractStructuredWithModelParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";

type MediaUnderstandingCapability = "image" | "audio" | "video";
type MediaUnderstandingOutput = Awaited<ReturnType<typeof runCapability>>["outputs"][number];

const KIND_BY_CAPABILITY: Record<MediaUnderstandingCapability, MediaUnderstandingOutput["kind"]> = {
  audio: "audio.transcription",
  image: "image.description",
  video: "video.description",
};

function resolveDecisionFailureReason(
  decision: Awaited<ReturnType<typeof runCapability>>["decision"],
): string | undefined {
  // runCapability stores detailed failed-attempt reasons; file APIs expose the
  // first normalized reason as the thrown error message.
  return normalizeDecisionReason(findDecisionReason(decision, "failed"));
}

function buildFileContext(params: {
  filePath: string;
  mediaUrl?: string;
  mime?: string;
  capability?: MediaUnderstandingCapability;
  scopeContext?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
}) {
  // Runtime file calls reuse message-context media plumbing so scope, local roots, and
  // remote URL handling stay identical to normal channel-triggered media understanding.
  const scopeFields = {
    ...(params.scopeContext?.sessionKey ? { SessionKey: params.scopeContext.sessionKey } : {}),
    ...(params.scopeContext?.channel
      ? { Provider: params.scopeContext.channel, Surface: params.scopeContext.channel }
      : {}),
    ...(params.scopeContext?.chatType ? { ChatType: params.scopeContext.chatType } : {}),
  };
  const remoteRef =
    params.mediaUrl ??
    (isRemoteMediaReference(params.filePath) ? params.filePath.trim() : undefined);
  const extensionMime = remoteRef ? mimeTypeFromFilePath(remoteRef) : undefined;
  const extensionKind = kindFromMime(extensionMime);
  const mediaType =
    params.mime ??
    (remoteRef && params.capability && extensionKind === params.capability
      ? `${params.capability}/*`
      : extensionMime) ??
    (remoteRef && params.capability ? `${params.capability}/*` : undefined);
  if (remoteRef) {
    return {
      MediaUrl: remoteRef,
      MediaType: mediaType,
      ...scopeFields,
    };
  }
  return {
    MediaPath: params.filePath,
    MediaType: mediaType,
    ...scopeFields,
  };
}

function isRemoteMediaReference(value: string): boolean {
  return hasHttpUrlPrefix(value.trim());
}

function concreteMime(mime: string | undefined): string | undefined {
  const normalized = mime?.trim();
  if (!normalized || normalized.endsWith("/*")) {
    return undefined;
  }
  return normalized;
}

function resolveFileLocalRoots(filePath: string): string[] | undefined {
  return isRemoteMediaReference(filePath) ? undefined : [path.dirname(filePath)];
}

function basenameFromMediaReference(value: string): string {
  if (isRemoteMediaReference(value)) {
    try {
      const url = new URL(value);
      return path.basename(url.pathname) || "image";
    } catch {}
  }
  return path.basename(value);
}

function hasStructuredImageInput(input: ExtractStructuredWithModelParams["input"]): boolean {
  return input.some((entry) => entry.type === "image");
}

/** Runs media understanding for one local file or remote URL and returns the first matching output. */
export async function runMediaUnderstandingFile(
  params: RunMediaUnderstandingFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  const requestPrompt = params.prompt?.trim();
  const requestTimeoutSeconds =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.ceil(params.timeoutMs / 1000)
      : undefined;
  const cfg =
    requestPrompt || requestTimeoutSeconds !== undefined
      ? {
          ...params.cfg,
          tools: {
            ...params.cfg.tools,
            media: {
              ...params.cfg.tools?.media,
              [params.capability]: {
                ...params.cfg.tools?.media?.[params.capability],
                ...(requestPrompt
                  ? {
                      prompt: requestPrompt,
                      _requestPromptOverride: requestPrompt,
                    }
                  : {}),
                ...(requestTimeoutSeconds !== undefined
                  ? { timeoutSeconds: requestTimeoutSeconds }
                  : {}),
              },
            },
          },
        }
      : params.cfg;
  const ctx = buildFileContext({
    ...params,
    capability: params.capability,
    scopeContext: params.scopeContext,
  });
  const attachments = normalizeMediaAttachments(ctx);
  if (attachments.length === 0) {
    return {
      text: undefined,
      decision: { capability: params.capability, outcome: "no-attachment", attachments: [] },
    };
  }
  const config = cfg.tools?.media?.[params.capability];
  if (config?.enabled === false) {
    return {
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
      decision: { capability: params.capability, outcome: "disabled", attachments: [] },
    };
  }

  const providerRegistry = buildProviderRegistry(undefined, cfg);
  const agentDir =
    params.agentDir ?? (params.agentId ? resolveAgentDir(cfg, params.agentId) : undefined);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: params.mediaUrl ? undefined : resolveFileLocalRoots(params.filePath),
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
  });

  try {
    const result = await runCapability({
      capability: params.capability,
      cfg,
      ctx,
      attachments: cache,
      media: attachments,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(agentDir ? { agentDir } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      providerRegistry,
      config,
      activeModel: params.activeModel,
    });
    if (result.outputs.length === 0 && result.decision.outcome === "failed") {
      throw new Error(
        resolveDecisionFailureReason(result.decision) ??
          `${params.capability} understanding failed`,
      );
    }
    const output = result.outputs.find(
      (entry) => entry.kind === KIND_BY_CAPABILITY[params.capability],
    );
    const text = output?.text?.trim();
    const fileResult: RunMediaUnderstandingFileResult = {
      text: text || undefined,
      provider: output?.provider,
      model: output?.model,
      output,
    };
    if (result.decision) {
      fileResult.decision = result.decision;
    }
    return fileResult;
  } finally {
    await cache.cleanup();
  }
}

/** Describes one image file or URL through the configured image-understanding pipeline. */
export async function describeImageFile(
  params: DescribeImageFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "image" });
}

/** Reads and normalizes image input once before explicit-model fallback attempts. */
export async function prepareImageDescriptionInput(params: PrepareImageDescriptionInputParams) {
  const timeoutMs = resolveMediaRuntimeTimeoutMs(params.timeoutMs);
  const image = await readImageDescriptionInput({
    filePath: params.filePath,
    mediaUrl: params.mediaUrl,
    mime: params.mime,
    cfg: params.cfg,
    timeoutMs,
  });
  const normalizedImage = await normalizeImageDescriptionInput({
    buffer: image.buffer,
    fileName: image.fileName,
    mime: image.mime,
    maxBytes: DEFAULT_MAX_BYTES.image,
  });
  return {
    buffer: normalizedImage.buffer,
    fileName: image.fileName,
    mime: normalizedImage.mime,
  };
}

/** Describes a prepared image with an explicit provider/model. */
export async function describePreparedImageWithModel(params: DescribePreparedImageWithModelParams) {
  const timeoutMs = resolveMediaRuntimeTimeoutMs(params.timeoutMs);
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  const provider = providerRegistry.get(normalizeMediaProviderId(params.provider));
  const describeImage = provider?.describeImage ?? describeImageWithModel;
  const agentDir =
    params.agentDir ??
    (params.agentId
      ? resolveAgentDir(params.cfg, params.agentId)
      : resolveDefaultAgentDir(params.cfg));
  return await describeImage({
    buffer: params.image.buffer,
    fileName: params.image.fileName,
    mime: params.image.mime,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs,
    cfg: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

/** Describes one image with an explicit provider/model, bypassing configured media model selection. */
export async function describeImageFileWithModel(params: DescribeImageFileWithModelParams) {
  const image = await prepareImageDescriptionInput(params);
  return await describePreparedImageWithModel({
    ...params,
    image,
  });
}

async function readImageDescriptionInput(params: {
  filePath: string;
  mediaUrl?: string;
  mime?: string;
  cfg: OpenClawConfig;
  timeoutMs: number;
}): Promise<{ buffer: Buffer; fileName: string; mime?: string }> {
  const remoteRef =
    params.mediaUrl ??
    (isRemoteMediaReference(params.filePath) ? params.filePath.trim() : undefined);
  if (!remoteRef) {
    const { buffer } = await readLocalFileSafely({ filePath: params.filePath });
    return {
      buffer,
      fileName: basenameFromMediaReference(params.filePath),
      mime: await detectMime({
        buffer,
        filePath: params.filePath,
        headerMime: concreteMime(params.mime),
      }),
    };
  }
  const attachments = normalizeMediaAttachments(
    buildFileContext({ ...params, capability: "image" }),
  );
  const cache = createMediaAttachmentCache(attachments, {
    ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy,
  });
  try {
    const media = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: DEFAULT_MAX_BYTES.image,
      timeoutMs: params.timeoutMs,
    });
    return {
      buffer: media.buffer,
      fileName: media.fileName || basenameFromMediaReference(remoteRef),
      // The attachment cache has already resolved MIME from bytes, filename, and headers.
      // Keep the caller hint only as a fallback for cache implementations with no MIME result.
      mime: media.mime ?? concreteMime(params.mime),
    };
  } finally {
    await cache.cleanup();
  }
}

/** Runs provider-backed structured extraction for multimodal text/image input. */
export async function extractStructuredWithModel(params: ExtractStructuredWithModelParams) {
  const timeoutMs = resolveMediaRuntimeTimeoutMs(params.timeoutMs);
  if (!hasStructuredImageInput(params.input)) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  const provider = getMediaUnderstandingProvider(
    params.provider,
    buildMediaUnderstandingRegistry(undefined, params.cfg),
  );
  if (!provider?.extractStructured) {
    throw new Error(`Provider does not support structured extraction: ${params.provider}`);
  }
  return await provider.extractStructured({
    input: params.input,
    instructions: params.instructions,
    schemaName: params.schemaName,
    jsonSchema: params.jsonSchema,
    jsonMode: params.jsonMode,
    provider: params.provider,
    model: params.model,
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    authStore: params.authStore,
    timeoutMs,
    cfg: params.cfg,
    agentDir: params.agentDir ?? "",
  });
}

/** Describes one video file or URL through the configured video-understanding pipeline. */
export async function describeVideoFile(
  params: DescribeVideoFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "video" });
}

/** Transcribes one audio file or URL through the configured audio-understanding pipeline. */
export async function transcribeAudioFile(
  params: TranscribeAudioFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  const cfg =
    params.language || params.prompt
      ? {
          ...params.cfg,
          tools: {
            ...params.cfg.tools,
            media: {
              ...params.cfg.tools?.media,
              audio: {
                ...params.cfg.tools?.media?.audio,
                ...(params.language ? { _requestLanguageOverride: params.language } : {}),
                ...(params.prompt ? { _requestPromptOverride: params.prompt } : {}),
                ...(params.language ? { language: params.language } : {}),
                ...(params.prompt ? { prompt: params.prompt } : {}),
              },
            },
          },
        }
      : params.cfg;
  const result = await runMediaUnderstandingFile({ ...params, cfg, capability: "audio" });
  return result;
}
