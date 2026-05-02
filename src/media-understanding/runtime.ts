import fs from "node:fs/promises";
import path from "node:path";
import { normalizeMediaProviderId } from "./provider-registry.js";
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
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";
export type {
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  DescribeVideoFileParams,
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

function buildFileContext(params: { filePath: string; mime?: string }) {
  return {
    MediaPath: params.filePath,
    MediaType: params.mime,
  };
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
  const ctx = buildFileContext(params);
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
    localPathRoots: [path.dirname(params.filePath)],
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
  if (!provider?.describeImage) {
    throw new Error(`Provider does not support image analysis: ${params.provider}`);
  }
  const buffer = await fs.readFile(params.filePath);
  return await provider.describeImage({
    buffer,
    fileName: path.basename(params.filePath),
    mime: params.mime,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
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
