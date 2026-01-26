import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { MediaAttachmentCache, normalizeAttachments, selectAttachments } from "./attachments.js";
import {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_AUDIO_MODELS,
  DEFAULT_TIMEOUT_SECONDS,
} from "./defaults.js";
import { isMediaUnderstandingSkipError, MediaUnderstandingSkipError } from "./errors.js";
import {
  resolveMaxBytes,
  resolveMaxChars,
  resolveModelEntries,
  resolvePrompt,
  resolveScopeDecision,
  resolveTimeoutMs,
} from "./resolve.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./providers/index.js";
import { describeImageWithModel } from "./providers/image.js";
import { estimateBase64Size, resolveVideoMaxBase64Bytes } from "./video.js";

const AUTO_AUDIO_KEY_PROVIDERS = ["openai", "groq", "deepgram", "google"] as const;
const AUTO_IMAGE_KEY_PROVIDERS = ["openai", "anthropic", "google", "minimax"] as const;
const AUTO_VIDEO_KEY_PROVIDERS = ["google"] as const;
const DEFAULT_IMAGE_MODELS: Record<string, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-opus-4-5",
  google: "gemini-3-flash-preview",
  minimax: "MiniMax-VL-01",
};

export type ActiveMediaModel = {
  provider: string;
  model?: string;
};

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;

export type RunCapabilityResult = {
  outputs: MediaUnderstandingOutput[];
  decision: MediaUnderstandingDecision;
};

export function buildProviderRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): ProviderRegistry {
  return buildMediaUnderstandingRegistry(overrides);
}

export function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[] {
  return normalizeAttachments(ctx);
}

export function createMediaAttachmentCache(attachments: MediaAttachment[]): MediaAttachmentCache {
  return new MediaAttachmentCache(attachments);
}

const binaryCache = new Map<string, Promise<string | null>>();
const geminiProbeCache = new Map<string, Promise<boolean>>();

function expandHomeDir(value: string): string {
  if (!value.startsWith("~")) return value;
  const home = os.homedir();
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function candidateBinaryNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const ext = path.extname(name);
  if (ext) return [name];
  const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
  const unique = Array.from(new Set(pathext));
  return [name, ...unique.map((item) => `${name}${item}`)];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(name: string): Promise<string | null> {
  const cached = binaryCache.get(name);
  if (cached) return cached;
  const resolved = (async () => {
    const direct = expandHomeDir(name.trim());
    if (direct && hasPathSeparator(direct)) {
      for (const candidate of candidateBinaryNames(direct)) {
        if (await isExecutable(candidate)) return candidate;
      }
    }

    const searchName = name.trim();
    if (!searchName) return null;
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    const candidates = candidateBinaryNames(searchName);
    for (const entryRaw of pathEntries) {
      const entry = expandHomeDir(entryRaw.trim().replace(/^"(.*)"$/, "$1"));
      if (!entry) continue;
      for (const candidate of candidates) {
        const fullPath = path.join(entry, candidate);
        if (await isExecutable(fullPath)) return fullPath;
      }
    }

    return null;
  })();
  binaryCache.set(name, resolved);
  return resolved;
}

async function hasBinary(name: string): Promise<boolean> {
  return Boolean(await findBinary(name));
}

async function fileExists(filePath?: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractLastJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.lastIndexOf("{");
  if (start === -1) return null;
  const slice = trimmed.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function extractGeminiResponse(raw: string): string | null {
  const payload = extractLastJsonObject(raw);
  if (!payload || typeof payload !== "object") return null;
  const response = (payload as { response?: unknown }).response;
  if (typeof response !== "string") return null;
  const trimmed = response.trim();
  return trimmed || null;
}

function extractSherpaOnnxText(raw: string): string | null {
  const tryParse = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const head = trimmed[0];
    if (head !== "{" && head !== '"') return null;
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
  if (direct) return direct;

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i] ?? "");
    if (parsed) return parsed;
  }
  return null;
}

async function probeGeminiCli(): Promise<boolean> {
  const cached = geminiProbeCache.get("gemini");
  if (cached) return cached;
  const resolved = (async () => {
    if (!(await hasBinary("gemini"))) return false;
    try {
      const { stdout } = await runExec("gemini", ["--output-format", "json", "ok"], {
        timeoutMs: 8000,
      });
      return Boolean(extractGeminiResponse(stdout) ?? stdout.toLowerCase().includes("ok"));
    } catch {
      return false;
    }
  })();
  geminiProbeCache.set("gemini", resolved);
  return resolved;
}

async function resolveLocalWhisperCppEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("whisper-cli"))) return null;
  const envModel = process.env.WHISPER_CPP_MODEL?.trim();
  const defaultModel = "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
  const modelPath = envModel && (await fileExists(envModel)) ? envModel : defaultModel;
  if (!(await fileExists(modelPath))) return null;
  return {
    type: "cli",
    command: "whisper-cli",
    args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-np", "-nt", "{{MediaPath}}"],
  };
}

async function resolveLocalWhisperEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("whisper"))) return null;
  return {
    type: "cli",
    command: "whisper",
    args: [
      "--model",
      "turbo",
      "--output_format",
      "txt",
      "--output_dir",
      "{{OutputDir}}",
      "--verbose",
      "False",
      "{{MediaPath}}",
    ],
  };
}

async function resolveSherpaOnnxEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("sherpa-onnx-offline"))) return null;
  const modelDir = process.env.SHERPA_ONNX_MODEL_DIR?.trim();
  if (!modelDir) return null;
  const tokens = path.join(modelDir, "tokens.txt");
  const encoder = path.join(modelDir, "encoder.onnx");
  const decoder = path.join(modelDir, "decoder.onnx");
  const joiner = path.join(modelDir, "joiner.onnx");
  if (!(await fileExists(tokens))) return null;
  if (!(await fileExists(encoder))) return null;
  if (!(await fileExists(decoder))) return null;
  if (!(await fileExists(joiner))) return null;
  return {
    type: "cli",
    command: "sherpa-onnx-offline",
    args: [
      `--tokens=${tokens}`,
      `--encoder=${encoder}`,
      `--decoder=${decoder}`,
      `--joiner=${joiner}`,
      "{{MediaPath}}",
    ],
  };
}

async function resolveLocalAudioEntry(): Promise<MediaUnderstandingModelConfig | null> {
  const sherpa = await resolveSherpaOnnxEntry();
  if (sherpa) return sherpa;
  const whisperCpp = await resolveLocalWhisperCppEntry();
  if (whisperCpp) return whisperCpp;
  return await resolveLocalWhisperEntry();
}

async function resolveGeminiCliEntry(
  _capability: MediaUnderstandingCapability,
): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await probeGeminiCli())) return null;
  return {
    type: "cli",
    command: "gemini",
    args: [
      "--output-format",
      "json",
      "--allowed-tools",
      "read_many_files",
      "--include-directories",
      "{{MediaDir}}",
      "{{Prompt}}",
      "Use read_many_files to read {{MediaPath}} and respond with only the text output.",
    ],
  };
}

async function resolveKeyEntry(params: {
  cfg: ClawdbotConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig | null> {
  const { cfg, agentDir, providerRegistry, capability } = params;
  const checkProvider = async (
    providerId: string,
    model?: string,
  ): Promise<MediaUnderstandingModelConfig | null> => {
    const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
    if (!provider) return null;
    if (capability === "audio" && !provider.transcribeAudio) return null;
    if (capability === "image" && !provider.describeImage) return null;
    if (capability === "video" && !provider.describeVideo) return null;
    try {
      await resolveApiKeyForProvider({ provider: providerId, cfg, agentDir });
      return { type: "provider" as const, provider: providerId, model };
    } catch {
      return null;
    }
  };

  if (capability === "image") {
    const activeProvider = params.activeModel?.provider?.trim();
    if (activeProvider) {
      const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
      if (activeEntry) return activeEntry;
    }
    for (const providerId of AUTO_IMAGE_KEY_PROVIDERS) {
      const model = DEFAULT_IMAGE_MODELS[providerId];
      const entry = await checkProvider(providerId, model);
      if (entry) return entry;
    }
    return null;
  }

  if (capability === "video") {
    const activeProvider = params.activeModel?.provider?.trim();
    if (activeProvider) {
      const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
      if (activeEntry) return activeEntry;
    }
    for (const providerId of AUTO_VIDEO_KEY_PROVIDERS) {
      const entry = await checkProvider(providerId, undefined);
      if (entry) return entry;
    }
    return null;
  }

  const activeProvider = params.activeModel?.provider?.trim();
  if (activeProvider) {
    const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
    if (activeEntry) return activeEntry;
  }
  for (const providerId of AUTO_AUDIO_KEY_PROVIDERS) {
    const entry = await checkProvider(providerId, undefined);
    if (entry) return entry;
  }
  return null;
}

async function resolveAutoEntries(params: {
  cfg: ClawdbotConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig[]> {
  const activeEntry = await resolveActiveModelEntry(params);
  if (activeEntry) return [activeEntry];
  if (params.capability === "audio") {
    const localAudio = await resolveLocalAudioEntry();
    if (localAudio) return [localAudio];
  }
  const gemini = await resolveGeminiCliEntry(params.capability);
  if (gemini) return [gemini];
  const keys = await resolveKeyEntry(params);
  if (keys) return [keys];
  return [];
}

async function resolveActiveModelEntry(params: {
  cfg: ClawdbotConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig | null> {
  const activeProviderRaw = params.activeModel?.provider?.trim();
  if (!activeProviderRaw) return null;
  const providerId = normalizeMediaProviderId(activeProviderRaw);
  if (!providerId) return null;
  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) return null;
  if (params.capability === "audio" && !provider.transcribeAudio) return null;
  if (params.capability === "image" && !provider.describeImage) return null;
  if (params.capability === "video" && !provider.describeVideo) return null;
  try {
    await resolveApiKeyForProvider({
      provider: providerId,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  } catch {
    return null;
  }
  return {
    type: "provider",
    provider: providerId,
    model: params.activeModel?.model,
  };
}

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

function commandBase(command: string): string {
  return path.parse(command).name;
}

function findArgValue(args: string[], keys: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (keys.includes(args[i] ?? "")) {
      const value = args[i + 1];
      if (value) return value;
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
  if (!outputDir || !outputFormat) return null;
  const formats = outputFormat.split(",").map((value) => value.trim());
  if (!formats.includes("txt")) return null;
  const base = path.parse(mediaPath).name;
  return path.join(outputDir, `${base}.txt`);
}

function resolveWhisperCppOutputPath(args: string[]): string | null {
  if (!hasArg(args, ["-otxt", "--output-txt"])) return null;
  const outputBase = findArgValue(args, ["-of", "--output-file"]);
  if (!outputBase) return null;
  return `${outputBase}.txt`;
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
        : null;
  if (fileOutput && (await fileExists(fileOutput))) {
    try {
      const content = await fs.readFile(fileOutput, "utf8");
      if (content.trim()) return content.trim();
    } catch {}
  }

  if (commandId === "gemini") {
    const response = extractGeminiResponse(params.stdout);
    if (response) return response;
  }

  if (commandId === "sherpa-onnx-offline") {
    const response = extractSherpaOnnxText(params.stdout);
    if (response) return response;
  }

  return params.stdout.trim();
}

type ProviderQuery = Record<string, string | number | boolean>;

function normalizeProviderQuery(
  options?: Record<string, string | number | boolean>,
): ProviderQuery | undefined {
  if (!options) return undefined;
  const query: ProviderQuery = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildDeepgramCompatQuery(options?: {
  detectLanguage?: boolean;
  punctuate?: boolean;
  smartFormat?: boolean;
}): ProviderQuery | undefined {
  if (!options) return undefined;
  const query: ProviderQuery = {};
  if (typeof options.detectLanguage === "boolean") query.detect_language = options.detectLanguage;
  if (typeof options.punctuate === "boolean") query.punctuate = options.punctuate;
  if (typeof options.smartFormat === "boolean") query.smart_format = options.smartFormat;
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
  let query = normalizeDeepgramQueryKeys(mergedOptions ?? {});
  const compat = buildDeepgramCompatQuery({ ...config?.deepgram, ...entry.deepgram });
  for (const [key, value] of Object.entries(compat ?? {})) {
    if (query[key] === undefined) {
      query[key] = value;
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildModelDecision(params: {
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

function formatDecisionSummary(decision: MediaUnderstandingDecision): string {
  const total = decision.attachments.length;
  const success = decision.attachments.filter(
    (entry) => entry.chosen?.outcome === "success",
  ).length;
  const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
  const provider = chosen?.provider?.trim();
  const model = chosen?.model?.trim();
  const modelLabel = provider ? (model ? `${provider}/${model}` : provider) : undefined;
  const reason = decision.attachments
    .flatMap((entry) => entry.attempts.map((attempt) => attempt.reason).filter(Boolean))
    .find(Boolean);
  const shortReason = reason ? reason.split(":")[0]?.trim() : undefined;
  const countLabel = total > 0 ? ` (${success}/${total})` : "";
  const viaLabel = modelLabel ? ` via ${modelLabel}` : "";
  const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
  return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}

async function runProviderEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
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
    const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
    const result = provider?.describeImage
      ? await provider.describeImage({
          buffer: media.buffer,
          fileName: media.fileName,
          mime: media.mime,
          model: modelId,
          provider: providerId,
          prompt,
          timeoutMs,
          profile: entry.profile,
          preferredProfile: entry.preferredProfile,
          agentDir: params.agentDir,
          cfg: params.cfg,
        })
      : await describeImageWithModel({
          buffer: media.buffer,
          fileName: media.fileName,
          mime: media.mime,
          model: modelId,
          provider: providerId,
          prompt,
          timeoutMs,
          profile: entry.profile,
          preferredProfile: entry.preferredProfile,
          agentDir: params.agentDir,
          cfg: params.cfg,
        });
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

  if (capability === "audio") {
    if (!provider.transcribeAudio) {
      throw new Error(`Audio transcription provider "${providerId}" not available.`);
    }
    const media = await params.cache.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs,
    });
    const auth = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      profileId: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentDir: params.agentDir,
    });
    const apiKey = requireApiKey(auth, providerId);
    const providerConfig = cfg.models?.providers?.[providerId];
    const baseUrl = entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
    const mergedHeaders = {
      ...providerConfig?.headers,
      ...params.config?.headers,
      ...entry.headers,
    };
    const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
    const providerQuery = resolveProviderQuery({
      providerId,
      config: params.config,
      entry,
    });
    const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[providerId] || entry.model;
    const result = await provider.transcribeAudio({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      apiKey,
      baseUrl,
      headers,
      model,
      language: entry.language ?? params.config?.language ?? cfg.tools?.media?.audio?.language,
      prompt,
      query: providerQuery,
      timeoutMs,
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
  const auth = await resolveApiKeyForProvider({
    provider: providerId,
    cfg,
    profileId: entry.profile,
    preferredProfile: entry.preferredProfile,
    agentDir: params.agentDir,
  });
  const apiKey = requireApiKey(auth, providerId);
  const providerConfig = cfg.models?.providers?.[providerId];
  const result = await provider.describeVideo({
    buffer: media.buffer,
    fileName: media.fileName,
    mime: media.mime,
    apiKey,
    baseUrl: providerConfig?.baseUrl,
    headers: providerConfig?.headers,
    model: entry.model,
    prompt,
    timeoutMs,
  });
  return {
    kind: "video.description",
    attachmentIndex: params.attachmentIndex,
    text: trimOutput(result.text, maxChars),
    provider: providerId,
    model: result.model ?? entry.model,
  };
}

async function runCliEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
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
  const pathResult = await params.cache.getPath({
    attachmentIndex: params.attachmentIndex,
    maxBytes,
    timeoutMs,
  });
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-media-cli-"));
  const mediaPath = pathResult.path;
  const outputBase = path.join(outputDir, path.parse(mediaPath).name);

  const templCtx: MsgContext = {
    ...ctx,
    MediaPath: mediaPath,
    MediaDir: path.dirname(mediaPath),
    OutputDir: outputDir,
    OutputBase: outputBase,
    Prompt: prompt,
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
    if (!text) return null;
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

async function runAttachmentEntries(params: {
  capability: MediaUnderstandingCapability;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  cache: MediaAttachmentCache;
  entries: MediaUnderstandingModelConfig[];
  config?: MediaUnderstandingConfig;
}): Promise<{
  output: MediaUnderstandingOutput | null;
  attempts: MediaUnderstandingModelDecision[];
}> {
  const { entries, capability } = params;
  const attempts: MediaUnderstandingModelDecision[] = [];
  for (const entry of entries) {
    const entryType = entry.type ?? (entry.command ? "cli" : "provider");
    try {
      const result =
        entryType === "cli"
          ? await runCliEntry({
              capability,
              entry,
              cfg: params.cfg,
              ctx: params.ctx,
              attachmentIndex: params.attachmentIndex,
              cache: params.cache,
              config: params.config,
            })
          : await runProviderEntry({
              capability,
              entry,
              cfg: params.cfg,
              ctx: params.ctx,
              attachmentIndex: params.attachmentIndex,
              cache: params.cache,
              agentDir: params.agentDir,
              providerRegistry: params.providerRegistry,
              config: params.config,
            });
      if (result) {
        const decision = buildModelDecision({ entry, entryType, outcome: "success" });
        if (result.provider) decision.provider = result.provider;
        if (result.model) decision.model = result.model;
        attempts.push(decision);
        return { output: result, attempts };
      }
      attempts.push(
        buildModelDecision({ entry, entryType, outcome: "skipped", reason: "empty output" }),
      );
    } catch (err) {
      if (isMediaUnderstandingSkipError(err)) {
        attempts.push(
          buildModelDecision({
            entry,
            entryType,
            outcome: "skipped",
            reason: `${err.reason}: ${err.message}`,
          }),
        );
        if (shouldLogVerbose()) {
          logVerbose(`Skipping ${capability} model due to ${err.reason}: ${err.message}`);
        }
        continue;
      }
      attempts.push(
        buildModelDecision({
          entry,
          entryType,
          outcome: "failed",
          reason: String(err),
        }),
      );
      if (shouldLogVerbose()) {
        logVerbose(`${capability} understanding failed: ${String(err)}`);
      }
    }
  }

  return { output: null, attempts };
}

export async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: MediaAttachment[];
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): Promise<RunCapabilityResult> {
  const { capability, cfg, ctx } = params;
  const config = params.config ?? cfg.tools?.media?.[capability];
  if (config?.enabled === false) {
    return {
      outputs: [],
      decision: { capability, outcome: "disabled", attachments: [] },
    };
  }

  const attachmentPolicy = config?.attachments;
  const selected = selectAttachments({
    capability,
    attachments: params.media,
    policy: attachmentPolicy,
  });
  if (selected.length === 0) {
    return {
      outputs: [],
      decision: { capability, outcome: "no-attachment", attachments: [] },
    };
  }

  const scopeDecision = resolveScopeDecision({ scope: config?.scope, ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose(`${capability} understanding disabled by scope policy.`);
    }
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "scope-deny",
        attachments: selected.map((item) => ({ attachmentIndex: item.index, attempts: [] })),
      },
    };
  }

  // Skip image understanding when the primary model supports vision natively.
  // The image will be injected directly into the model context instead.
  const activeProvider = params.activeModel?.provider?.trim();
  if (capability === "image" && activeProvider) {
    const catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, activeProvider, params.activeModel?.model ?? "");
    if (modelSupportsVision(entry)) {
      if (shouldLogVerbose()) {
        logVerbose("Skipping image understanding: primary model supports vision natively");
      }
      const model = params.activeModel?.model?.trim();
      const reason = "primary model supports vision natively";
      return {
        outputs: [],
        decision: {
          capability,
          outcome: "skipped",
          attachments: selected.map((item) => {
            const attempt = {
              type: "provider" as const,
              provider: activeProvider,
              model: model || undefined,
              outcome: "skipped" as const,
              reason,
            };
            return {
              attachmentIndex: item.index,
              attempts: [attempt],
              chosen: attempt,
            };
          }),
        },
      };
    }
  }

  const entries = resolveModelEntries({
    cfg,
    capability,
    config,
    providerRegistry: params.providerRegistry,
  });
  let resolvedEntries = entries;
  if (resolvedEntries.length === 0) {
    resolvedEntries = await resolveAutoEntries({
      cfg,
      agentDir: params.agentDir,
      providerRegistry: params.providerRegistry,
      capability,
      activeModel: params.activeModel,
    });
  }
  if (resolvedEntries.length === 0) {
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "skipped",
        attachments: selected.map((item) => ({ attachmentIndex: item.index, attempts: [] })),
      },
    };
  }

  const outputs: MediaUnderstandingOutput[] = [];
  const attachmentDecisions: MediaUnderstandingDecision["attachments"] = [];
  for (const attachment of selected) {
    const { output, attempts } = await runAttachmentEntries({
      capability,
      cfg,
      ctx,
      attachmentIndex: attachment.index,
      agentDir: params.agentDir,
      providerRegistry: params.providerRegistry,
      cache: params.attachments,
      entries: resolvedEntries,
      config,
    });
    if (output) outputs.push(output);
    attachmentDecisions.push({
      attachmentIndex: attachment.index,
      attempts,
      chosen: attempts.find((attempt) => attempt.outcome === "success"),
    });
  }
  const decision: MediaUnderstandingDecision = {
    capability,
    outcome: outputs.length > 0 ? "success" : "skipped",
    attachments: attachmentDecisions,
  };
  if (shouldLogVerbose()) {
    logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
  }
  return {
    outputs,
    decision,
  };
}
