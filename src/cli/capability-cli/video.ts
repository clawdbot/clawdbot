import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import type { Command } from "commander";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { assertOkOrThrowHttpError } from "../../agents/provider-http-errors.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readResponseWithLimit } from "../../infra/http-body.js";
import { buildMediaUnderstandingRegistry } from "../../media-understanding/provider-registry.js";
import { describeVideoFile } from "../../media-understanding/runtime.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import {
  fetchWithTimeoutGuarded,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../../plugin-sdk/provider-http.js";
import { defaultRuntime } from "../../runtime.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import type { VideoGenerationResolution } from "../../video-generation/types.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { getModelsCommandSecretTargetIds } from "../command-secret-targets.js";
import { writeOutputAsset } from "./media-output.js";
import type { CapabilityEnvelope } from "./metadata.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  parseOptionalFiniteNumber,
  parseOptionalTimeoutMs,
  providerHasGenericConfig,
  requireProviderModelOverride,
  resolveLocalCapabilityRuntimeConfig,
  resolveSelectedProviderFromModelRef,
} from "./shared.js";

const GENERATED_VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

function normalizeVideoResolution(raw: string | undefined): VideoGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "360P" ||
    normalized === "480P" ||
    normalized === "540P" ||
    normalized === "720P" ||
    normalized === "768P" ||
    normalized === "1080P"
  ) {
    return normalized;
  }
  throw new Error("video resolution must be one of 360P, 480P, 540P, 720P, 768P, or 1080P");
}

async function fetchGeneratedVideoDownload(params: {
  cfg: OpenClawConfig;
  provider: string;
  url: string;
}) {
  const providerConfig = params.cfg.models?.providers?.[params.provider];
  const { allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    baseUrl: params.url,
    defaultBaseUrl: params.url,
    request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    provider: params.provider,
    capability: "video",
    transport: "http",
  });
  const result = await fetchWithTimeoutGuarded(
    params.url,
    { method: "GET" },
    GENERATED_VIDEO_DOWNLOAD_TIMEOUT_MS,
    fetch,
    {
      ...(allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
      ...(dispatcherPolicy ? { dispatcherPolicy } : {}),
      auditContext: `${params.provider}-generated-video-download`,
    },
  );
  try {
    await assertOkOrThrowHttpError(
      result.response,
      `${params.provider} generated video download failed`,
    );
    return result;
  } catch (error) {
    await result.release();
    throw error;
  }
}

async function runVideoGenerate(params: {
  prompt: string;
  model?: string;
  output?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  timeoutMs?: number;
}) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer video.generate",
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const result = await generateVideo({
    cfg,
    agentDir,
    prompt: params.prompt,
    modelOverride: params.model,
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    durationSeconds: params.durationSeconds,
    audio: params.audio,
    watermark: params.watermark,
    timeoutMs: params.timeoutMs,
  });
  const outputs = await Promise.all(
    result.videos.map(async (video, index) => {
      if (!video.buffer && !video.url) {
        throw new Error(`Video asset at index ${index} has neither buffer nor url`);
      }

      let videoBuffer = video.buffer;
      if (!videoBuffer && video.url) {
        const download = await fetchGeneratedVideoDownload({
          cfg,
          provider: result.provider,
          url: video.url,
        });
        const response = download.response;
        try {
          if (params.output && response.body) {
            const mimeType = normalizeMimeType(video.mimeType);
            const ext =
              extensionForMime(mimeType) ||
              path.extname(video.fileName ?? "") ||
              path.extname(params.output ?? "");
            const resolvedOutput = path.resolve(params.output);
            const parsed = path.parse(resolvedOutput);
            const filePath =
              result.videos.length <= 1
                ? path.join(parsed.dir, `${parsed.name}${ext}`)
                : path.join(parsed.dir, `${parsed.name}-${String(index + 1)}${ext}`);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await pipeline(
              Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
              createWriteStream(filePath),
            );
            const stat = await fs.stat(filePath);
            return { path: filePath, mimeType: video.mimeType, size: stat.size };
          }
          // Provider-supplied video URLs are untrusted external sources, and the
          // in-memory fallback (no --output) must not buffer an unbounded body:
          // generated videos routinely exceed tens of MiB and a hostile/buggy
          // provider could exhaust process memory. Cap the read (fail-closed:
          // overflow cancels the stream and throws rather than silently
          // truncating) using the same shared bounded reader the rest of the
          // media stack relies on. The --output branch above already streams
          // straight to disk, so only this buffered path needs the guard. The
          // overflow error reports only the provider label and byte cap (never
          // the raw URL, which may be signed/tokenized) to match the sibling
          // generated-media downloaders.
          const videoMaxBytes = resolveGeneratedMediaMaxBytes(cfg, "video");
          videoBuffer = await readResponseWithLimit(response, videoMaxBytes, {
            onOverflow: ({ maxBytes }) =>
              new Error(
                `${result.provider} generated video download exceeds ${maxBytes} bytes; pass --output to stream large videos to disk`,
              ),
          });
        } finally {
          await download.release();
        }
      }

      return {
        ...(await writeOutputAsset({
          buffer: videoBuffer!,
          mimeType: video.mimeType,
          originalFilename: video.fileName,
          outputPath: params.output,
          outputIndex: index,
          outputCount: result.videos.length,
          subdir: "generated",
        })),
      };
    }),
  );
  return {
    ok: true,
    capability: "video.generate",
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    outputs,
  } satisfies CapabilityEnvelope;
}

async function runVideoDescribe(params: { file: string; model?: string }) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer video.describe",
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const activeModel = requireProviderModelOverride(params.model);
  const result = await describeVideoFile({
    filePath: path.resolve(params.file),
    cfg,
    activeModel,
  });
  if (!result.text) {
    throw new Error(`No description returned for video: ${path.resolve(params.file)}`);
  }
  return {
    ok: true,
    capability: "video.describe",
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: [],
    outputs: [{ path: path.resolve(params.file), text: result.text, kind: "video.description" }],
  } satisfies CapabilityEnvelope;
}

export function registerVideoCapabilityCommands(capability: Command): void {
  const video = capability.command("video").description("Video generation and description");

  video
    .command("generate")
    .description("Generate video")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <provider/model>", "Model override")
    .option("--size <size>", "Size hint like 1280x720")
    .option("--aspect-ratio <ratio>", "Aspect ratio hint like 16:9")
    .option("--resolution <value>", "Resolution hint: 360P, 480P, 540P, 720P, 768P, or 1080P")
    .option("--duration <seconds>", "Target duration in seconds")
    .option("--audio", "Enable generated audio when supported")
    .option("--watermark", "Request provider watermark when supported")
    .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
    .option("--output <path>", "Output path")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runVideoGenerate({
          prompt: String(opts.prompt),
          model: opts.model as string | undefined,
          output: opts.output as string | undefined,
          size: opts.size as string | undefined,
          aspectRatio: opts.aspectRatio as string | undefined,
          resolution: normalizeVideoResolution(opts.resolution as string | undefined),
          durationSeconds: parseOptionalFiniteNumber(opts.duration, "--duration"),
          audio: opts.audio === true ? true : undefined,
          watermark: opts.watermark === true ? true : undefined,
          timeoutMs: parseOptionalTimeoutMs(opts.timeoutMs),
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  video
    .command("describe")
    .description("Describe one video file")
    .requiredOption("--file <path>", "Video file")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runVideoDescribe({
          file: String(opts.file),
          model: opts.model as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  video
    .command("providers")
    .description("List video generation and description providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = getRuntimeConfig();
        const selectedGenerationProvider = resolveSelectedProviderFromModelRef(
          resolveAgentModelPrimaryValue(cfg.agents?.defaults?.videoGenerationModel),
        );
        const result = {
          generation: listRuntimeVideoGenerationProviders({ config: cfg }).map((provider) => ({
            available: true,
            configured:
              selectedGenerationProvider === provider.id ||
              providerHasGenericConfig({ cfg, providerId: provider.id }),
            selected: selectedGenerationProvider === provider.id,
            id: provider.id,
            label: provider.label,
            defaultModel: provider.defaultModel,
            models: provider.models ?? [],
            capabilities: provider.capabilities,
          })),
          description: [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
            .filter((provider) => provider.capabilities?.includes("video"))
            .map((provider) => ({
              available: true,
              configured: providerHasGenericConfig({ cfg, providerId: provider.id }),
              selected: false,
              id: provider.id,
              capabilities: provider.capabilities,
              defaultModels: provider.defaultModels,
            })),
        };
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });
}
