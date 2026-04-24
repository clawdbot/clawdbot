import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { normalizeGoogleApiBaseUrl } from "./api.js";
import {
  createGoogleVideoGenerationProviderMetadata,
  DEFAULT_GOOGLE_VIDEO_MODEL,
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
  GOOGLE_VIDEO_MAX_DURATION_SECONDS,
  GOOGLE_VIDEO_MIN_DURATION_SECONDS,
} from "./generation-provider-metadata.js";
import { createGoogleGenAI, type GoogleGenAIClient } from "./google-genai-runtime.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 90;

function resolveConfiguredGoogleVideoBaseUrl(req: VideoGenerationRequest): string | undefined {
  const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
  return configured ? normalizeGoogleApiBaseUrl(configured) : undefined;
}

function parseVideoSize(size: string | undefined): { width: number; height: number } | undefined {
  const trimmed = normalizeOptionalString(size);
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return { width, height };
}

function resolveAspectRatio(params: {
  aspectRatio?: string;
  size?: string;
}): "16:9" | "9:16" | undefined {
  const direct = normalizeOptionalString(params.aspectRatio);
  if (direct === "16:9" || direct === "9:16") {
    return direct;
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  return parsedSize.width >= parsedSize.height ? "16:9" : "9:16";
}

function resolveResolution(params: {
  resolution?: string;
  size?: string;
}): "720p" | "1080p" | undefined {
  if (params.resolution === "720P") {
    return "720p";
  }
  if (params.resolution === "1080P") {
    return "1080p";
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  const maxEdge = Math.max(parsedSize.width, parsedSize.height);
  return maxEdge >= 1920 ? "1080p" : maxEdge >= 1280 ? "720p" : undefined;
}

function resolveDurationSeconds(durationSeconds: number | undefined): number | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.min(
    GOOGLE_VIDEO_MAX_DURATION_SECONDS,
    Math.max(GOOGLE_VIDEO_MIN_DURATION_SECONDS, Math.round(durationSeconds)),
  );
  return GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}

function resolveInputImage(req: VideoGenerationRequest) {
  const input = req.inputImages?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    imageBytes: input.buffer.toString("base64"),
    mimeType: normalizeOptionalString(input.mimeType) || "image/png",
  };
}

function resolveInputVideo(req: VideoGenerationRequest) {
  const input = req.inputVideos?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    videoBytes: input.buffer.toString("base64"),
    mimeType: normalizeOptionalString(input.mimeType) || "video/mp4",
  };
}

async function downloadGeneratedVideo(params: {
  client: GoogleGenAIClient;
  file: unknown;
  index: number;
}): Promise<GeneratedVideoAsset> {
  const tempDir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-google-video-"),
  );
  const downloadPath = path.join(tempDir, `video-${params.index + 1}.mp4`);
  try {
    await params.client.files.download({
      file: params.file as never,
      downloadPath,
    });
    const buffer = await readFile(downloadPath);
    return {
      buffer,
      mimeType: "video/mp4",
      fileName: `video-${params.index + 1}.mp4`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function buildGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createGoogleVideoGenerationProviderMetadata(),
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input image.");
      }
      if ((req.inputVideos?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input video.");
      }
      if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
        throw new Error(
          "Google video generation does not support image and video inputs together.",
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);
      const durationSeconds = resolveDurationSeconds(req.durationSeconds);
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "Google video generation",
      });
      const client = createGoogleGenAI({
        apiKey: auth.apiKey,
        httpOptions: {
          ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
          timeout: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        },
      });
      let operation = await client.models.generateVideos({
        model: normalizeOptionalString(req.model) || DEFAULT_GOOGLE_VIDEO_MODEL,
        prompt: req.prompt,
        image: resolveInputImage(req),
        video: resolveInputVideo(req),
        config: {
          ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
          ...(resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size })
            ? { aspectRatio: resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size }) }
            : {}),
          ...(resolveResolution({ resolution: req.resolution, size: req.size })
            ? { resolution: resolveResolution({ resolution: req.resolution, size: req.size }) }
            : {}),
          ...(req.audio === true ? { generateAudio: true } : {}),
        },
      });

      for (let attempt = 0; !(operation.done ?? false); attempt += 1) {
        if (attempt >= MAX_POLL_ATTEMPTS) {
          throw new Error("Google video generation did not finish in time");
        }
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
        operation = await client.operations.getVideosOperation({ operation });
      }
      if (operation.error) {
        throw new Error(JSON.stringify(operation.error));
      }
      const generatedVideos = operation.response?.generatedVideos ?? [];
      if (generatedVideos.length === 0) {
        throw new Error("Google video generation response missing generated videos");
      }
      const videos = await Promise.all(
        generatedVideos.map(async (entry, index) => {
          const inline = entry.video;
          if (inline?.videoBytes) {
            return {
              buffer: Buffer.from(inline.videoBytes, "base64"),
              mimeType: normalizeOptionalString(inline.mimeType) || "video/mp4",
              fileName: `video-${index + 1}.mp4`,
            };
          }
          if (!inline) {
            throw new Error("Google generated video missing file handle");
          }
          return await downloadGeneratedVideo({
            client,
            file: inline,
            index,
          });
        }),
      );
      return {
        videos,
        model: normalizeOptionalString(req.model) || DEFAULT_GOOGLE_VIDEO_MODEL,
        metadata: operation.name
          ? {
              operationName: operation.name,
            }
          : undefined,
      };
    },
  };
}
