import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { kindFromMime, mimeTypeFromFilePath } from "../media/mime.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";
import { describeImageWithModel } from "./image-runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./provider-registry.js";
import { findDecisionReason, normalizeDecisionReason } from "./runner.entries.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type {
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  DescribeVideoFileParams,
  ExtractStructuredWithModelParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";
export type {
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
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
  return normalizeDecisionReason(findDecisionReason(decision, "failed"));
}

function buildFileContext(params: {
  filePath: string;
  mediaUrl?: string;
  mime?: string;
  capability?: MediaUnderstandingCapability;
}) {
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
    };
  }
  return {
    MediaPath: params.filePath,
    MediaType: mediaType,
  };
}

function isRemoteMediaReference(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
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
  const ctx = buildFileContext({ ...params, capability: params.capability });
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
      agentDir: params.agentDir,
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

export async function describeImageFile(
  params: DescribeImageFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "image" });
}

export async function describeImageFileWithModel(params: DescribeImageFileWithModelParams) {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  const provider = providerRegistry.get(normalizeMediaProviderId(params.provider));
  const image = await readImageDescriptionInput({
    filePath: params.filePath,
    mediaUrl: params.mediaUrl,
    mime: params.mime,
    cfg: params.cfg,
    timeoutMs,
  });
  const describeImage = provider?.describeImage ?? describeImageWithModel;
  return await describeImage({
    buffer: image.buffer,
    fileName: image.fileName,
    mime: image.mime,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs,
    cfg: params.cfg,
    agentDir: params.agentDir ?? "",
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
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
    return {
      buffer: (await readLocalFileSafely({ filePath: params.filePath })).buffer,
      fileName: basenameFromMediaReference(params.filePath),
      mime: params.mime,
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
      mime: concreteMime(params.mime) ?? media.mime,
    };
  } finally {
    await cache.cleanup();
  }
}

export async function extractStructuredWithModel(params: ExtractStructuredWithModelParams) {
  const timeoutMs = params.timeoutMs ?? 30_000;
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

export async function describeVideoFile(
  params: DescribeVideoFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "video" });
}

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
