import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { runWithImageModelFallback } from "../../agents/model-fallback.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import type {
  ImageGenerationBackground,
  ImageGenerationOpenAIModeration,
  ImageGenerationOutputFormat,
  ImageGenerationQuality,
} from "../../image-generation/types.js";
import {
  describeImageFile,
  describePreparedImageWithModel,
  prepareImageDescriptionInput,
} from "../../media-understanding/runtime.js";
import { getImageMetadata } from "../../media/media-services.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { getModelsCommandSecretTargetIds } from "../command-secret-targets.js";
import { collectOption } from "../program/helpers.js";
import { readInputFiles, writeOutputAsset } from "./media-output.js";
import { isMissingMediaUnderstandingProvider } from "./media-understanding-result.js";
import type { CapabilityEnvelope } from "./metadata.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  parseOptionalPositiveInteger,
  parseOptionalTimeoutMs,
  providerHasGenericConfig,
  providerSummaryText,
  requireProviderModelOverride,
  resolveLocalCapabilityRuntimeConfig,
  resolveSelectedProviderFromModelRef,
} from "./shared.js";

const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;

async function runImageGenerate(params: {
  capability: "image.generate" | "image.edit";
  prompt: string;
  model?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: "1K" | "2K" | "4K";
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  openaiBackground?: ImageGenerationBackground;
  openaiModeration?: ImageGenerationOpenAIModeration;
  quality?: ImageGenerationQuality;
  file?: string[];
  output?: string;
  timeoutMs?: number;
}) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: `infer ${params.capability}`,
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const inputImages =
    params.file && params.file.length > 0
      ? await Promise.all(
          (await readInputFiles(params.file)).map(async (entry) => ({
            buffer: entry.buffer,
            fileName: path.basename(entry.path),
            mimeType:
              (await detectMime({ buffer: entry.buffer, filePath: entry.path })) ?? "image/png",
          })),
        )
      : undefined;
  const result = await generateImage({
    cfg,
    agentDir,
    prompt: params.prompt,
    modelOverride: params.model,
    count: params.count,
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    quality: params.quality,
    outputFormat: params.outputFormat,
    background: params.background,
    providerOptions:
      params.openaiBackground || params.openaiModeration
        ? {
            openai: {
              ...(params.openaiBackground ? { background: params.openaiBackground } : {}),
              ...(params.openaiModeration ? { moderation: params.openaiModeration } : {}),
            },
          }
        : undefined,
    timeoutMs: params.timeoutMs,
    inputImages,
  });
  const outputs = await Promise.all(
    result.images.map(async (image, index) => {
      const written = await writeOutputAsset({
        buffer: image.buffer,
        mimeType: image.mimeType,
        originalFilename: image.fileName,
        outputPath: params.output,
        outputIndex: index,
        outputCount: result.images.length,
        subdir: "generated",
      });
      const metadata = await getImageMetadata(image.buffer).catch(() => undefined);
      return {
        ...written,
        width: metadata?.width,
        height: metadata?.height,
        revisedPrompt: image.revisedPrompt,
      };
    }),
  );
  return {
    ok: true,
    capability: params.capability,
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    outputs,
    ignoredOverrides: result.ignoredOverrides,
  } satisfies CapabilityEnvelope;
}

async function runImageDescribe(params: {
  capability: "image.describe" | "image.describe-many";
  files: string[];
  model?: string;
  prompt?: string;
  timeoutMs?: number;
}) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: `infer ${params.capability}`,
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
  const activeModel = requireProviderModelOverride(params.model);
  const prompt = normalizeOptionalString(params.prompt);
  const outputs = await Promise.all(
    params.files.map(async (filePath) => {
      const resolvedPath = resolveImageDescribeInput(filePath);
      const isRemoteUrl = /^https?:\/\//i.test(resolvedPath);
      const preparedImage = activeModel
        ? await prepareImageDescriptionInput({
            filePath: resolvedPath,
            ...(isRemoteUrl ? { mediaUrl: resolvedPath } : {}),
            cfg,
            timeoutMs: params.timeoutMs,
          })
        : undefined;
      const result =
        activeModel && preparedImage
          ? await runWithImageModelFallback({
              cfg,
              modelOverride: `${activeModel.provider}/${activeModel.model}`,
              run: async (provider, model) => {
                const described = await describePreparedImageWithModel({
                  image: preparedImage,
                  cfg,
                  agentDir,
                  provider,
                  model,
                  prompt: prompt ?? "Describe the image.",
                  timeoutMs: params.timeoutMs,
                });
                if (!described.text?.trim()) {
                  throw new Error(`No description returned for image: ${resolvedPath}`);
                }
                return described;
              },
            })
          : {
              result: await describeImageFile({
                filePath: resolvedPath,
                ...(isRemoteUrl ? { mediaUrl: resolvedPath } : {}),
                cfg,
                agentDir,
                prompt,
                timeoutMs: params.timeoutMs,
              }),
              provider: undefined,
              model: undefined,
              attempts: [],
            };
      if (!result.result.text) {
        if (isMissingMediaUnderstandingProvider(result.result)) {
          throw new Error(
            "No image understanding provider is configured or ready. Configure tools.media.image.models or agents.defaults.imageModel.primary, or pass --model <provider/model> after configuring that provider's auth/API key.",
          );
        }
        throw new Error(`No description returned for image: ${resolvedPath}`);
      }
      return {
        path: resolvedPath,
        text: result.result.text,
        provider: result.provider ?? result.result.provider,
        model: result.result.model ?? result.model,
        attempts: result.attempts,
        kind: "image.description",
      };
    }),
  );
  return {
    ok: true,
    capability: params.capability,
    transport: "local" as const,
    provider: outputs[0]?.provider,
    model: outputs[0]?.model,
    attempts: outputs.flatMap((output) => output.attempts),
    outputs: outputs.map(({ attempts: _attempts, ...output }) => output),
  } satisfies CapabilityEnvelope;
}

function normalizeImageOutputFormat(
  raw: string | undefined,
): ImageGenerationOutputFormat | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!normalized) {
    return undefined;
  }
  if ((IMAGE_OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOutputFormat;
  }
  throw new Error("--output-format must be one of png, jpeg, or webp");
}

function normalizeImageBackground(
  raw: string | undefined,
  label = "--background",
): ImageGenerationBackground | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!normalized) {
    return undefined;
  }
  if ((IMAGE_BACKGROUNDS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationBackground;
  }
  throw new Error(`${label} must be one of transparent, opaque, or auto`);
}

function normalizeImageQuality(raw: string | undefined): ImageGenerationQuality | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "auto"
  ) {
    return normalized;
  }
  throw new Error("--quality must be one of low, medium, high, or auto");
}

function normalizeOpenAIModeration(
  raw: string | undefined,
): ImageGenerationOpenAIModeration | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "low" || normalized === "auto") {
    return normalized;
  }
  throw new Error("--openai-moderation must be one of low or auto");
}

function resolveImageDescribeInput(filePath: string): string {
  const trimmed = filePath.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : path.resolve(filePath);
}

function addImageGenerationOptions(command: Command): Command {
  return command
    .option("--model <provider/model>", "Model override")
    .option("--count <n>", "Number of images")
    .option("--size <size>", "Size hint like 1024x1024")
    .option("--aspect-ratio <ratio>", "Aspect ratio hint like 16:9")
    .option("--resolution <value>", "Resolution hint: 1K, 2K, or 4K")
    .option("--output-format <format>", "Output format hint: png, jpeg, or webp")
    .option("--background <value>", "Background hint: transparent, opaque, or auto")
    .option("--openai-background <value>", "OpenAI background hint: transparent, opaque, or auto")
    .option("--openai-moderation <value>", "OpenAI moderation hint: low or auto")
    .option("--quality <value>", "Quality hint: low, medium, high, or auto")
    .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
    .option("--output <path>", "Output path")
    .option("--json", "Output JSON", false);
}

function resolveImageGenerationOptions(opts: Record<string, unknown>) {
  return {
    model: opts.model as string | undefined,
    count: parseOptionalPositiveInteger(opts.count, "--count"),
    size: opts.size as string | undefined,
    aspectRatio: opts.aspectRatio as string | undefined,
    resolution: opts.resolution as "1K" | "2K" | "4K" | undefined,
    outputFormat: normalizeImageOutputFormat(opts.outputFormat as string | undefined),
    background: normalizeImageBackground(opts.background as string | undefined),
    openaiBackground: normalizeImageBackground(
      opts.openaiBackground as string | undefined,
      "--openai-background",
    ),
    openaiModeration: normalizeOpenAIModeration(opts.openaiModeration as string | undefined),
    quality: normalizeImageQuality(opts.quality as string | undefined),
    timeoutMs: parseOptionalTimeoutMs(opts.timeoutMs as string | number | undefined),
    output: opts.output as string | undefined,
  };
}

export function registerImageCapabilityCommands(capability: Command): void {
  const image = capability.command("image").description("Image generation and description");

  addImageGenerationOptions(
    image
      .command("generate")
      .description("Generate images")
      .requiredOption("--prompt <text>", "Prompt text"),
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const result = await runImageGenerate({
        capability: "image.generate",
        prompt: String(opts.prompt),
        ...resolveImageGenerationOptions(opts),
      });
      emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
    });
  });

  addImageGenerationOptions(
    image
      .command("edit")
      .description("Edit images with one or more input files")
      .requiredOption("--file <path>", "Input file", collectOption, [])
      .requiredOption("--prompt <text>", "Prompt text"),
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const files = Array.isArray(opts.file) ? (opts.file as string[]) : [String(opts.file)];
      const result = await runImageGenerate({
        capability: "image.edit",
        prompt: String(opts.prompt),
        file: files,
        ...resolveImageGenerationOptions(opts),
      });
      emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
    });
  });

  image
    .command("describe")
    .description("Describe one image file")
    .requiredOption("--file <path>", "Image file")
    .option("--prompt <text>", "Prompt hint")
    .option("--model <provider/model>", "Model override")
    .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runImageDescribe({
          capability: "image.describe",
          files: [String(opts.file)],
          model: opts.model as string | undefined,
          prompt: opts.prompt as string | undefined,
          timeoutMs: parseOptionalTimeoutMs(opts.timeoutMs),
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  image
    .command("describe-many")
    .description("Describe multiple image files")
    .requiredOption("--file <path>", "Image file", collectOption, [])
    .option("--prompt <text>", "Prompt hint")
    .option("--model <provider/model>", "Model override")
    .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runImageDescribe({
          capability: "image.describe-many",
          files: opts.file as string[],
          model: opts.model as string | undefined,
          prompt: opts.prompt as string | undefined,
          timeoutMs: parseOptionalTimeoutMs(opts.timeoutMs),
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  image
    .command("providers")
    .description("List image generation providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = getRuntimeConfig();
        const selectedProvider = resolveSelectedProviderFromModelRef(
          resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageGenerationModel),
        );
        const result = listRuntimeImageGenerationProviders({ config: cfg }).map((provider) => ({
          available: true,
          configured:
            selectedProvider === provider.id ||
            providerHasGenericConfig({ cfg, providerId: provider.id }),
          selected: selectedProvider === provider.id,
          id: provider.id,
          label: provider.label,
          defaultModel: provider.defaultModel,
          models: provider.models ?? [],
          capabilities: provider.capabilities,
        }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });
}
