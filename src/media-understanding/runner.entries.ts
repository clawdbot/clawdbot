import fs from "node:fs/promises";
import path from "node:path";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import {
  mergeModelProviderRequestOverrides,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
} from "../agents/provider-request-config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg } from "../media/ffmpeg-exec.js";
import { runExec } from "../process/exec.js";
import { providerOperationRetryConfig } from "../provider-runtime/operation-retry.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { MediaAttachmentCache } from "./attachments.js";
import {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_AUDIO_FILE_BYTES,
} from "./defaults.constants.js";
import { MediaUnderstandingSkipError } from "./errors.js";
import { fileExists } from "./fs.js";
import { describeImageWithModel } from "./image-runtime.js";
import { extractGeminiResponse } from "./output-extract.js";
import { getMediaUnderstandingProvider, normalizeMediaProviderId } from "./provider-registry.js";
import { resolveMaxBytes, resolveMaxChars, resolvePrompt, resolveTimeoutMs } from "./resolve.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
import { estimateBase64Size, resolveVideoMaxBase64Bytes } from "./video.js";

export type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type RequireApiKey = typeof import("../agents/model-auth.js").requireApiKey;

let cachedModelAuth: {
  resolveApiKeyForProvider: ResolveApiKeyForProvider;
  requireApiKey: RequireApiKey;
} | null = null;

async function loadModelAuth() {
  cachedModelAuth ??= await import("../agents/model-auth.js");
  return cachedModelAuth;
}

function resolveLiteralProviderApiKey(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): string | null {
  const value = params.cfg.models?.providers?.[params.providerId]?.apiKey;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizeProviderHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    // Intentionally preserve marker-shaped values here. This path handles
    // explicit config/runtime provider headers, where literal values may
    // legitimately match marker patterns; discovered models.json entries are
    // sanitized separately in the model registry path.
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars).trim();
}

function extractSherpaOnnxText(raw: string): string | null {
  const tryParse = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const head = trimmed[0];
    if (head !== "{" && head !== '"') {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return tryParse(parsed);
      }
      if (parsed && typeof parsed === "object") {
        const text = (parsed as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      }
    } catch {}
    return null;
  };

  const direct = tryParse(raw);
  if (direct) {
    return direct;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i] ?? "");
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function commandBase(command: string): string {
  return path.parse(command).name;
}

function findArgValue(args: string[], keys: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (keys.includes(args[i] ?? "")) {
      const value = args[i + 1];
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function hasArg(args: string[], keys: string[]): boolean {
  return args.some((arg) => keys.includes(arg));
}

function resolveWhisperOutputPath(args: string[], mediaPath: string): string | null {
  const outputDir = findArgValue(args, ["--output_dir", "-o"]);
  const outputFormat = findArgValue(args, ["--output_format"]);
  if (!outputDir || !outputFormat) {
    return null;
  }
  const formats = outputFormat.split(",").map((value) => value.trim());
  if (!formats.includes("txt")) {
    return null;
  }
  const base = path.parse(mediaPath).name;
  return path.join(outputDir, `${base}.txt`);
}

function resolveWhisperCppOutputPath(args: string[]): string | null {
  if (!hasArg(args, ["-otxt", "--output-txt"])) {
    return null;
  }
  const outputBase = findArgValue(args, ["-of", "--output-file"]);
  if (!outputBase) {
    return null;
  }
  return `${outputBase}.txt`;
}

function resolveParakeetOutputPath(args: string[], mediaPath: string): string | null {
  const outputDir = findArgValue(args, ["--output-dir"]);
  const outputFormat = findArgValue(args, ["--output-format"]);
  if (!outputDir) {
    return null;
  }
  if (outputFormat && outputFormat !== "txt") {
    return null;
  }
  const base = path.parse(mediaPath).name;
  return path.join(outputDir, `${base}.txt`);
}

async function resolveCliOutput(params: {
  command: string;
  args: string[];
  stdout: string;
  mediaPath: string;
}): Promise<string> {
  const commandId = commandBase(params.command);
  const fileOutput =
    commandId === "whisper-cli"
      ? resolveWhisperCppOutputPath(params.args)
      : commandId === "whisper"
        ? resolveWhisperOutputPath(params.args, params.mediaPath)
        : commandId === "parakeet-mlx"
          ? resolveParakeetOutputPath(params.args, params.mediaPath)
          : null;
  if (fileOutput && (await fileExists(fileOutput))) {
    try {
      const content = await fs.readFile(fileOutput, "utf8");
      if (content.trim()) {
        return content.trim();
      }
    } catch {}
  }

  if (commandId === "gemini") {
    const response = extractGeminiResponse(params.stdout);
    if (response) {
      return response;
    }
  }

  if (commandId === "sherpa-onnx-offline") {
    const response = extractSherpaOnnxText(params.stdout);
    if (response) {
      return response;
    }
  }

  return params.stdout.trim();
}

async function resolveCliMediaPath(params: {
  capability: MediaUnderstandingCapability;
  command: string;
  mediaPath: string;
  outputDir: string;
}): Promise<string> {
  const commandId = commandBase(params.command);
  if (params.capability !== "audio" || commandId !== "whisper-cli") {
    return params.mediaPath;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.mediaPath));
  if (ext === ".wav") {
    return params.mediaPath;
  }

  const wavPath = path.join(params.outputDir, `${path.parse(params.mediaPath).name}.wav`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir: params.outputDir,
    path: path.basename(wavPath),
    write: async (outputPath) => {
      await runFfmpeg([
        "-y",
        "-i",
        params.mediaPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        outputPath,
      ]);
    },
  });
  return wavPath;
}

type ProviderQuery = Record<string, string | number | boolean>;

function normalizeProviderQuery(
  options?: Record<string, string | number | boolean>,
): ProviderQuery | undefined {
  if (!options) {
    return undefined;
  }
  const query: ProviderQuery = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) {
      continue;
    }
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildDeepgramCompatQuery(options?: {
  detectLanguage?: boolean;
  punctuate?: boolean;
  smartFormat?: boolean;
}): ProviderQuery | undefined {
  if (!options) {
    return undefined;
  }
  const query: ProviderQuery = {};
  if (typeof options.detectLanguage === "boolean") {
    query.detect_language = options.detectLanguage;
  }
  if (typeof options.punctuate === "boolean") {
    query.punctuate = options.punctuate;
  }
  if (typeof options.smartFormat === "boolean") {
    query.smart_format = options.smartFormat;
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function normalizeDeepgramQueryKeys(query: ProviderQuery): ProviderQuery {
  const normalized = { ...query };
  if ("detectLanguage" in normalized) {
    normalized.detect_language = normalized.detectLanguage as boolean;
    delete normalized.detectLanguage;
  }
  if ("smartFormat" in normalized) {
    normalized.smart_format = normalized.smartFormat as boolean;
    delete normalized.smartFormat;
  }
  return normalized;
}

function resolveProviderQuery(params: {
  providerId: string;
  config?: MediaUnderstandingConfig;
  entry: MediaUnderstandingModelConfig;
}): ProviderQuery | undefined {
  const { providerId, config, entry } = params;
  const mergedOptions = normalizeProviderQuery({
    ...config?.providerOptions?.[providerId],
    ...entry.providerOptions?.[providerId],
  });
  if (providerId !== "deepgram") {
    return mergedOptions;
  }
  const query = normalizeDeepgramQueryKeys(mergedOptions ?? {});
  const compat = buildDeepgramCompatQuery({ ...config?.deepgram, ...entry.deepgram });
  for (const [key, value] of Object.entries(compat ?? {})) {
    if (query[key] === undefined) {
      query[key] = value;
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

export function buildModelDecision(params: {
  entry: MediaUnderstandingModelConfig;
  entryType: "provider" | "cli";
  outcome: MediaUnderstandingModelDecision["outcome"];
  reason?: string;
}): MediaUnderstandingModelDecision {
  if (params.entryType === "cli") {
    const command = params.entry.command?.trim();
    return {
      type: "cli",
      provider: command ?? "cli",
      model: params.entry.model ?? command,
      outcome: params.outcome,
      reason: params.reason,
    };
  }
  const providerIdRaw = params.entry.provider?.trim();
  const providerId = providerIdRaw ? normalizeMediaProviderId(providerIdRaw) : undefined;
  return {
    type: "provider",
    provider: providerId ?? providerIdRaw,
    model: params.entry.model,
    outcome: params.outcome,
    reason: params.reason,
  };
}

function resolveEntryRunOptions(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): { maxBytes: number; maxChars?: number; timeoutMs: number; prompt: string } {
  const { capability, entry, cfg } = params;
  const maxBytes = resolveMaxBytes({ capability, entry, cfg, config: params.config });
  const maxChars = resolveMaxChars({ capability, entry, cfg, config: params.config });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ??
      params.config?.timeoutSeconds ??
      cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const prompt = resolvePrompt(
    capability,
    entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt,
    maxChars,
  );
  return { maxBytes, maxChars, timeoutMs, prompt };
}

function resolveMediaRequestOverrides(config: MediaUnderstandingConfig | undefined): {
  prompt?: string;
  language?: string;
} {
  const overrides = (config ?? {}) as MediaUnderstandingConfig & {
    _requestPromptOverride?: string;
    _requestLanguageOverride?: string;
  };
  return {
    prompt: overrides._requestPromptOverride,
    language: overrides._requestLanguageOverride,
  };
}

async function resolveProviderExecutionAuth(params: {
  providerId: string;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  agentDir?: string;
}) {
  const literalApiKey = resolveLiteralProviderApiKey({
    cfg: params.cfg,
    providerId: params.providerId,
  });
  if (literalApiKey) {
    return {
      apiKeys: collectProviderApiKeysForExecution({
        provider: params.providerId,
        primaryApiKey: literalApiKey,
      }),
      providerConfig: params.cfg.models?.providers?.[params.providerId],
    };
  }
  const { requireApiKey, resolveApiKeyForProvider } = await loadModelAuth();
  const auth = await resolveApiKeyForProvider({
    provider: params.providerId,
    cfg: params.cfg,
    profileId: params.entry.profile,
    preferredProfile: params.entry.preferredProfile,
    agentDir: params.agentDir,
  });
  return {
    apiKeys: collectProviderApiKeysForExecution({
      provider: params.providerId,
      primaryApiKey: requireApiKey(auth, params.providerId),
    }),
    providerConfig: params.cfg.models?.providers?.[params.providerId],
  };
}

async function resolveProviderExecutionContext(params: {
  providerId: string;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  config?: MediaUnderstandingConfig;
  agentDir?: string;
}) {
  const { apiKeys, providerConfig } = await resolveProviderExecutionAuth({
    providerId: params.providerId,
    cfg: params.cfg,
    entry: params.entry,
    agentDir: params.agentDir,
  });
  const baseUrl = params.entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
  const mergedHeaders = {
    ...sanitizeProviderHeaders(providerConfig?.headers as Record<string, unknown> | undefined),
    ...sanitizeProviderHeaders(params.config?.headers as Record<string, unknown> | undefined),
    ...sanitizeProviderHeaders(params.entry.headers as Record<string, unknown> | undefined),
  };
  const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
  const request = mergeModelProviderRequestOverrides(
    sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    sanitizeConfiguredProviderRequest(params.config?.request),
    sanitizeConfiguredProviderRequest(params.entry.request),
  );
  return { apiKeys, baseUrl, headers, request };
}

export function formatDecisionSummary(decision: MediaUnderstandingDecision): string {
  const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
  const total = attachments.length;
  const success = attachments.filter((entry) => entry?.chosen?.outcome === "success").length;
  const chosen = attachments.find((entry) => entry?.chosen)?.chosen;
  const provider = typeof chosen?.provider === "string" ? chosen.provider.trim() : undefined;
  const model = typeof chosen?.model === "string" ? chosen.model.trim() : undefined;
  const modelLabel = provider ? (model ? `${provider}/${model}` : provider) : undefined;
  const reason = findDecisionReason(decision, decision.outcome === "failed" ? "failed" : undefined);
  const shortReason = summarizeDecisionReason(reason);
  const countLabel = total > 0 ? ` (${success}/${total})` : "";
  const viaLabel = modelLabel ? ` via ${modelLabel}` : "";
  const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
  return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}

export function findDecisionReason(
  decision: MediaUnderstandingDecision,
  outcome?: MediaUnderstandingModelDecision["outcome"],
): string | undefined {
  const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
  for (const attachment of attachments) {
    const attempts = Array.isArray(attachment?.attempts) ? attachment.attempts : [];
    for (const attempt of attempts) {
      if (outcome && attempt.outcome !== outcome) {
        continue;
      }
      if (typeof attempt.reason !== "string" || attempt.reason.trim().length === 0) {
        continue;
      }
      return attempt.reason;
    }
  }
  return undefined;
}

export function normalizeDecisionReason(reason?: string): string | undefined {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^Error:\s*/i, "").trim();
  return normalized || undefined;
}

export function summarizeDecisionReason(reason?: string): string | undefined {
  const normalized = normalizeDecisionReason(reason);
  if (!normalized) {
    return undefined;
  }
  return normalized.split(":")[0]?.trim() || undefined;
}

function assertMinAudioSize(params: { size: number; attachmentIndex: number }): void {
  if (params.size >= MIN_AUDIO_FILE_BYTES) {
    return;
  }
  throw new MediaUnderstandingSkipError(
    "tooSmall",
    `Audio attachment ${params.attachmentIndex + 1} is too small (${params.size} bytes, minimum ${MIN_AUDIO_FILE_BYTES})`,
  );
}

export async function runProviderEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg } = params;
  const providerIdRaw = entry.provider?.trim();
  if (!providerIdRaw) {
    throw new Error(`Provider entry missing provider for ${capability}`);
  }
  const providerId = normalizeMediaProviderId(providerIdRaw);
  const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
    capability,
    entry,
    cfg,
    config: params.config,
  });

  if (capability === "image") {
    if (!params.agentDir) {
      throw new Error("Image understanding requires agentDir");
    }
    const modelId = entry.model?.trim();
    if (!modelId) {
      throw new Error("Image understanding requires model id");
    }
    const media = await params.cache.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs,
    });
    const requestOverrides = resolveMediaRequestOverrides(params.config);
    const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
    const imageInput = {
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      model: modelId,
      provider: providerId,
      prompt: requestOverrides.prompt ?? prompt,
      timeoutMs,
      profile: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentDir: params.agentDir,
      cfg: params.cfg,
    };
    const describeImage = provider?.describeImage ?? describeImageWithModel;
    const result = await describeImage(imageInput);
    return {
      kind: "image.description",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? modelId,
    };
  }

  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    throw new Error(`Media provider not available: ${providerId}`);
  }

  // Resolve proxy-aware fetch from env vars (HTTPS_PROXY, HTTP_PROXY, etc.)
  // so provider HTTP calls are routed through the proxy when configured.
  const fetchFn = resolveProxyFetchFromEnv();

  if (capability === "audio") {
    if (!provider.transcribeAudio) {
      throw new Error(`Audio transcription provider "${providerId}" not available.`);
    }
    const transcribeAudio = provider.transcribeAudio;
    const requestOverrides = resolveMediaRequestOverrides(params.config);
    const media = await params.cache.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs,
    });
    assertMinAudioSize({ size: media.size, attachmentIndex: params.attachmentIndex });
    const { apiKeys, baseUrl, headers, request } = await resolveProviderExecutionContext({
      providerId,
      cfg,
      entry,
      config: params.config,
      agentDir: params.agentDir,
    });
    const providerQuery = resolveProviderQuery({
      providerId,
      config: params.config,
      entry,
    });
    const model =
      entry.model?.trim() ||
      (await import("./defaults.js")).resolveDefaultMediaModel({
        cfg,
        providerId,
        capability: "audio",
      }) ||
      entry.model;
    const result = await executeWithApiKeyRotation({
      provider: providerId,
      apiKeys,
      transientRetry: providerOperationRetryConfig("read"),
      execute: async (apiKey) =>
        transcribeAudio({
          buffer: media.buffer,
          fileName: media.fileName,
          mime: media.mime,
          apiKey,
          baseUrl,
          headers,
          request,
          model,
          language:
            requestOverrides.language ??
            entry.language ??
            params.config?.language ??
            cfg.tools?.media?.audio?.language,
          prompt: requestOverrides.prompt ?? prompt,
          query: providerQuery,
          timeoutMs,
          fetchFn,
        }),
    });
    return {
      kind: "audio.transcription",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? model,
    };
  }

  if (!provider.describeVideo) {
    throw new Error(`Video understanding provider "${providerId}" not available.`);
  }
  const describeVideo = provider.describeVideo;
  const media = await params.cache.getBuffer({
    attachmentIndex: params.attachmentIndex,
    maxBytes,
    timeoutMs,
  });
  const estimatedBase64Bytes = estimateBase64Size(media.size);
  const maxBase64Bytes = resolveVideoMaxBase64Bytes(maxBytes);
  if (estimatedBase64Bytes > maxBase64Bytes) {
    throw new MediaUnderstandingSkipError(
      "maxBytes",
      `Video attachment ${params.attachmentIndex + 1} base64 payload ${estimatedBase64Bytes} exceeds ${maxBase64Bytes}`,
    );
  }
  const { apiKeys, baseUrl, headers, request } = await resolveProviderExecutionContext({
    providerId,
    cfg,
    entry,
    config: params.config,
    agentDir: params.agentDir,
  });
  const result = await executeWithApiKeyRotation({
    provider: providerId,
    apiKeys,
    transientRetry: providerOperationRetryConfig("read"),
    execute: (apiKey) =>
      describeVideo({
        buffer: media.buffer,
        fileName: media.fileName,
        mime: media.mime,
        apiKey,
        baseUrl,
        headers,
        request,
        model: entry.model,
        prompt,
        timeoutMs,
        fetchFn,
      }),
  });
  return {
    kind: "video.description",
    attachmentIndex: params.attachmentIndex,
    text: trimOutput(result.text, maxChars),
    provider: providerId,
    model: result.model ?? entry.model,
  };
}

export async function runCliEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg, ctx } = params;
  const command = entry.command?.trim();
  const args = entry.args ?? [];
  if (!command) {
    throw new Error(`CLI entry missing command for ${capability}`);
  }
  const requestOverrides = resolveMediaRequestOverrides(params.config);
  const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
    capability,
    entry,
    cfg,
    config: params.config,
  });
  const pathResult = await params.cache.getPath({
    attachmentIndex: params.attachmentIndex,
    maxBytes,
    timeoutMs,
  });
  if (capability === "audio") {
    const stat = await fs.stat(pathResult.path);
    assertMinAudioSize({ size: stat.size, attachmentIndex: params.attachmentIndex });
  }
  const outputDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-cli-"),
  );
  const mediaPath = await resolveCliMediaPath({
    capability,
    command,
    mediaPath: pathResult.path,
    outputDir,
  });
  const outputBase = path.join(outputDir, path.parse(mediaPath).name);

  const templCtx: MsgContext = {
    ...ctx,
    MediaPath: mediaPath,
    MediaDir: path.dirname(mediaPath),
    OutputDir: outputDir,
    OutputBase: outputBase,
    Prompt: requestOverrides.prompt ?? prompt,
    ...(requestOverrides.language ? { Language: requestOverrides.language } : {}),
    MaxChars: maxChars,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );
  try {
    if (shouldLogVerbose()) {
      logVerbose(`Media understanding via CLI: ${argv.join(" ")}`);
    }
    const { stdout } = await runExec(argv[0], argv.slice(1), {
      timeoutMs,
      maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    });
    const resolved = await resolveCliOutput({
      command,
      args: argv.slice(1),
      stdout,
      mediaPath,
    });
    const text = trimOutput(resolved, maxChars);
    if (!text) {
      return null;
    }
    return {
      kind: capability === "audio" ? "audio.transcription" : `${capability}.description`,
      attachmentIndex: params.attachmentIndex,
      text,
      provider: "cli",
      model: command,
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}
