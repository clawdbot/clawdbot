// Media-understanding entry execution handles provider/CLI attempts, auth
// rotation, output extraction, and decision summaries.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { MediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import { extractGeminiResponse } from "../../packages/media-understanding-common/src/output-extract.js";
import {
  estimateBase64Size,
  resolveVideoMaxBase64Bytes,
} from "../../packages/media-understanding-common/src/video.js";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import {
  mergeModelProviderRequestOverrides,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
} from "../agents/provider-request-config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { hasErrnoCode } from "../infra/errors.js";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg } from "../media/media-services.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalProviderCatalogEntries,
} from "../plugins/official-external-plugin-catalog.js";
import { resolveOfficialExternalPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
import { runExec } from "../process/exec.js";
import { providerOperationRetryConfig } from "../provider-runtime/operation-retry.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { MediaAttachmentCache } from "./attachments.js";
import {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_AUDIO_FILE_BYTES,
} from "./defaults.constants.js";
import { normalizeImageDescriptionInput } from "./image-input-normalize.js";
import { describeImageWithModel } from "./image-runtime.js";
import {
  recordLocalAudioBackendObservation,
  resolveRequestedLocalAudioBackend,
} from "./local-audio.js";
import { resolveOpenAiAudioAuthModelApi } from "./openai-audio-api.js";
import { normalizeMediaExecutionProviderId } from "./provider-id.js";
import { getMediaUnderstandingProvider, normalizeMediaProviderId } from "./provider-registry.js";
import { resolveMaxBytes, resolveMaxChars, resolvePrompt, resolveTimeoutMs } from "./resolve.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
const loadModelAuth = createLazyRuntimeModule(async () => await import("../agents/model-auth.js"));

function resolveLiteralProviderApiKey(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): string | null {
  return normalizeNullableString(params.cfg.models?.providers?.[params.providerId]?.apiKey);
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
  return truncateUtf16Safe(trimmed, maxChars).trim();
}

function extractSherpaOnnxText(raw: string): { matched: boolean; text: string } {
  const noMatch = { matched: false, text: "" };
  const tryParse = (value: string): { matched: boolean; text: string } => {
    const trimmed = value.trim();
    if (!trimmed) {
      return noMatch;
    }
    const head = trimmed[0];
    if (head !== "{" && head !== '"') {
      return noMatch;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return tryParse(parsed);
      }
      if (parsed && typeof parsed === "object") {
        const text = (parsed as { text?: unknown }).text;
        if (typeof text === "string") {
          return { matched: true, text: text.trim() };
        }
      }
    } catch {}
    return noMatch;
  };

  const direct = tryParse(raw);
  if (direct.matched) {
    return direct;
  }

  const lines = normalizeStringEntries(raw.split("\n"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i] ?? "");
    if (parsed.matched) {
      return parsed;
    }
  }
  return noMatch;
}

function commandBase(command: string): string {
  return path.parse(command).name;
}

function isAntigravityCliCommand(command: string): boolean {
  const commandId = commandBase(command);
  return commandId === "agy" || commandId === "antigravity";
}

function findArgValue(args: string[], keys: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (keys.includes(arg)) {
      const value = args[index + 1];
      if (value) {
        return value;
      }
    }
    for (const key of keys) {
      const prefix = `${key}=`;
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length);
        if (value) {
          return value;
        }
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
  if (!outputDir) {
    return null;
  }
  const outputFormat = findArgValue(args, ["--output_format", "-f"]) ?? "all";
  if (outputFormat !== "txt" && outputFormat !== "all") {
    return null;
  }
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
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
  const outputFormat =
    findArgValue(args, ["--output-format"]) ?? (process.env.PARAKEET_OUTPUT_FORMAT || "srt");
  const outputTemplate =
    findArgValue(args, ["--output-template"]) ??
    (process.env.PARAKEET_OUTPUT_TEMPLATE || "{filename}");
  if (
    !outputDir ||
    (outputFormat !== "txt" && outputFormat !== "all") ||
    outputTemplate !== "{filename}"
  ) {
    return null;
  }
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

async function readCliTranscriptFile(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
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
  if (fileOutput) {
    // A known file-output contract is authoritative: falling back would expose
    // progress/status stdout as user speech when transcription is empty or missing.
    return await readCliTranscriptFile(fileOutput);
  }

  if (commandId === "gemini") {
    const response = extractGeminiResponse(params.stdout);
    if (response) {
      return response;
    }
  }

  if (commandId === "sherpa-onnx-offline") {
    const response = extractSherpaOnnxText(params.stdout);
    if (response.matched) {
      return response.text;
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

/** Builds the normalized decision record for one provider or CLI model attempt. */
export function buildModelDecision(params: {
  entry: MediaUnderstandingModelConfig;
  entryType: "provider" | "cli";
  outcome: MediaUnderstandingModelDecision["outcome"];
  reason?: string;
}): MediaUnderstandingModelDecision {
  if (params.entryType === "cli") {
    const command = params.entry.command?.trim();
    const requestedBackend = command
      ? resolveRequestedLocalAudioBackend({
          command,
          args: params.entry.args ?? [],
        })
      : undefined;
    return {
      type: "cli",
      provider: command ?? "cli",
      model: params.entry.model ?? command,
      ...(requestedBackend ? { requestedBackend } : {}),
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
}): {
  maxBytes: number;
  maxChars?: number;
  timeoutMs: number;
  prompt: string;
  hasConfiguredPrompt: boolean;
} {
  const { capability, entry, cfg } = params;
  const maxBytes = resolveMaxBytes({ capability, entry, cfg, config: params.config });
  const maxChars = resolveMaxChars({ capability, entry, cfg, config: params.config });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ??
      params.config?.timeoutSeconds ??
      cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const configuredPrompt =
    entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt;
  const prompt = resolvePrompt(capability, configuredPrompt, maxChars);
  return {
    maxBytes,
    maxChars,
    timeoutMs,
    prompt,
    hasConfiguredPrompt: Boolean(configuredPrompt?.trim()),
  };
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
    prompt: overrides["_requestPromptOverride"],
    language: overrides["_requestLanguageOverride"],
  };
}

function resolveAudioProviderPrompt(params: {
  prompt: string;
  hasConfiguredPrompt: boolean;
  language?: string;
}): string | undefined {
  const language = params.language?.trim().toLowerCase();
  const isEnglish =
    !language ||
    language === "en" ||
    language === "eng" ||
    language === "english" ||
    language.startsWith("en-") ||
    language.startsWith("en_");
  if (params.hasConfiguredPrompt || isEnglish) {
    return params.prompt;
  }
  // OpenAI-compatible transcription prompts guide style/context and should
  // match the audio language; omit OpenClaw's English default for non-English
  // language hints unless the user supplied an explicit prompt.
  return undefined;
}

type ProviderExecutionAuth =
  | {
      kind: "api-key";
      apiKeys: string[];
      source?: string;
      providerConfig?: ModelProviderConfig;
    }
  | {
      kind: "none";
      source: string;
      providerConfig?: ModelProviderConfig;
    };

function resolveProviderExecutionAuthModelApi(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
}): string | undefined {
  return resolveOpenAiAudioAuthModelApi(params);
}

async function resolveProviderExecutionAuth(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
  provider?: MediaUnderstandingProvider;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ProviderExecutionAuth> {
  const providerConfig = params.cfg.models?.providers?.[params.providerId];
  const modelApi = resolveProviderExecutionAuthModelApi({
    capability: params.capability,
    providerId: params.providerId,
  });
  const literalApiKey = resolveLiteralProviderApiKey({
    cfg: params.cfg,
    providerId: params.providerId,
  });
  if (literalApiKey) {
    return {
      kind: "api-key",
      apiKeys: collectProviderApiKeysForExecution({
        provider: params.providerId,
        primaryApiKey: literalApiKey,
      }),
      source: `models.providers.${params.providerId}.apiKey`,
      providerConfig,
    };
  }
  const resolveMediaProviderAuth = (): ProviderExecutionAuth | undefined => {
    const context = {
      config: params.cfg,
      provider: params.providerId,
      providerConfig,
    };
    const providerAuth = params.provider?.resolveAuth?.(context);
    if (!providerAuth) {
      const syntheticAuth = params.provider?.resolveSyntheticAuth?.(context);
      const syntheticApiKey = syntheticAuth?.apiKey.trim();
      const syntheticSource = syntheticAuth?.source;
      return syntheticApiKey
        ? {
            kind: "api-key",
            apiKeys: collectProviderApiKeysForExecution({
              provider: params.providerId,
              primaryApiKey: syntheticApiKey,
            }),
            source: syntheticSource,
            providerConfig,
          }
        : undefined;
    }
    if (providerAuth.kind === "none") {
      return {
        kind: "none",
        source: providerAuth.source,
        providerConfig,
      };
    }
    const apiKey = providerAuth.apiKey.trim();
    if (!apiKey) {
      return undefined;
    }
    return {
      kind: "api-key",
      apiKeys: collectProviderApiKeysForExecution({
        provider: params.providerId,
        primaryApiKey: apiKey,
      }),
      source: providerAuth.source,
      providerConfig,
    };
  };
  const { isProviderAuthError, requireApiKey, resolveApiKeyForProvider } = await loadModelAuth();
  try {
    const auth = await resolveApiKeyForProvider({
      provider: params.providerId,
      cfg: params.cfg,
      profileId: params.entry.profile,
      preferredProfile: params.entry.preferredProfile,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      modelApi,
    });
    const apiKey = requireApiKey(auth, params.providerId);
    return {
      kind: "api-key",
      apiKeys: collectProviderApiKeysForExecution({
        provider: params.providerId,
        primaryApiKey: apiKey,
      }),
      source: auth.source,
      providerConfig,
    };
  } catch (err) {
    if (
      !isProviderAuthError(err, "missing-provider-auth") &&
      !isProviderAuthError(err, "missing-api-key")
    ) {
      throw err;
    }
    const mediaAuth = resolveMediaProviderAuth();
    if (mediaAuth) {
      return mediaAuth;
    }
    throw err;
  }
}

async function resolveProviderExecutionContext(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
  provider?: MediaUnderstandingProvider;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  config?: MediaUnderstandingConfig;
  agentDir?: string;
  workspaceDir?: string;
}) {
  const auth = await resolveProviderExecutionAuth({
    capability: params.capability,
    providerId: params.providerId,
    provider: params.provider,
    cfg: params.cfg,
    entry: params.entry,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  const providerConfig = auth.providerConfig;
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
  return { auth, baseUrl, headers, request };
}

/** Formats a compact operator-facing summary of a media-understanding decision. */
export function formatDecisionSummary(decision: MediaUnderstandingDecision): string {
  const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
  const total = attachments.length;
  const success = attachments.filter((entry) => entry?.chosen?.outcome === "success").length;
  const chosen = attachments.find((entry) => entry?.chosen)?.chosen;
  const provider = typeof chosen?.provider === "string" ? chosen.provider.trim() : undefined;
  const model = typeof chosen?.model === "string" ? chosen.model.trim() : undefined;
  const modelLabel = provider
    ? model && model !== provider
      ? `${provider}/${model}`
      : provider
    : undefined;
  const backendLabel = chosen?.observedBackend
    ? ` observed=${chosen.observedBackend}`
    : chosen?.requestedBackend
      ? ` requested=${chosen.requestedBackend}`
      : "";
  const reason = findDecisionReason(decision, decision.outcome === "failed" ? "failed" : undefined);
  const shortReason = summarizeDecisionReason(reason);
  const countLabel = total > 0 ? ` (${success}/${total})` : "";
  const viaLabel = modelLabel ? ` via ${modelLabel}${backendLabel}` : "";
  const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
  return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}

/** Returns the first non-empty attempt reason, optionally filtered by outcome. */
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

/** Trims provider/runtime error prefixes into a stable human-readable reason. */
export function normalizeDecisionReason(reason?: string): string | undefined {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^Error:\s*/i, "").trim();
  return normalized || undefined;
}

/** Produces the short reason token used in status and decision summary output. */
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

/**
 * Build an actionable hint suffix for "provider not available" errors.
 *
 * Restricts the hint to ids that are owned by the official external
 * provider catalog — NOT the combined channel/plugin catalog — so a media
 * provider id like `feishu` (an official channel, not a media provider)
 * never emits a misleading install hint from a media-provider error.
 *
 * Tier 1: provider id is owned by an official external provider entry that
 *   declares a `contracts.mediaUnderstandingProviders` block listing the
 *   id — emit the catalog-backed install + registry refresh + doctor fix
 *   commands.
 * Tier 2: empty string — keeps the legacy message verbatim for ids that
 *   are not in the provider catalog (channel ids, plugin ids, unknown
 *   ids, internal ids, etc.). Newly externalized media providers must
 *   register with the official external provider catalog to receive the
 *   actionable hint.
 */
export function formatMissingProviderHint(providerId: string): string {
  const trimmed = providerId.trim();
  if (!trimmed) {
    return "";
  }
  // Look up the id only in catalog entries that declare
  // `contracts.mediaUnderstandingProviders`. This ensures the install hint
  // only fires for provider packages that actually own the missing
  // media-understanding capability. Providers that have a generic `providers[]`
  // catalog entry but no media-understanding contract (e.g. Amazon Bedrock)
  // will not emit misleading hints.
  const providerEntry = listOfficialExternalProviderCatalogEntries().find((entry) => {
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const mediaProviders = manifest?.contracts?.mediaUnderstandingProviders ?? [];
    return mediaProviders.some((mediaId) => mediaId === trimmed);
  });
  if (!providerEntry) {
    return "";
  }
  // `resolveOfficialExternalPluginRepairHint` is contract-agnostic but we
  // already validated ownership via the provider-only catalog, so the
  // returned hint is for the correct provider entry.
  const catalogHint = resolveOfficialExternalPluginRepairHint(trimmed);
  if (!catalogHint) {
    return "";
  }
  return ` Install the official external plugin with: ${formatCliCommand(catalogHint.installCommand)}, then run ${formatCliCommand("openclaw plugins registry --refresh")} and stop and start the gateway service, or run ${formatCliCommand(catalogHint.doctorFixCommand)} to repair automatically.`;
}

/** Executes one provider-backed media-understanding entry for one attachment. */
export async function runProviderEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  agentDir?: string;
  workspaceDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg } = params;
  const providerIdRaw = entry.provider?.trim();
  if (!providerIdRaw) {
    throw new Error(`Provider entry missing provider for ${capability}`);
  }
  const providerId = normalizeMediaProviderId(providerIdRaw);
  const requestProviderId = normalizeMediaExecutionProviderId(providerIdRaw);
  const { maxBytes, maxChars, timeoutMs, prompt, hasConfiguredPrompt } = resolveEntryRunOptions({
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
    const normalizedMedia = await normalizeImageDescriptionInput({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      maxBytes,
    });
    const requestOverrides = resolveMediaRequestOverrides(params.config);
    const provider = getMediaUnderstandingProvider(requestProviderId, params.providerRegistry);
    const imageInput = {
      buffer: normalizedMedia.buffer,
      fileName: media.fileName,
      mime: normalizedMedia.mime,
      model: modelId,
      provider: requestProviderId,
      prompt: requestOverrides.prompt ?? prompt,
      timeoutMs,
      profile: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
    };
    const describeImage = provider?.describeImage ?? describeImageWithModel;
    const result = await describeImage(imageInput);
    return {
      kind: "image.description",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: requestProviderId,
      model: result.model ?? modelId,
    };
  }

  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    throw new Error(
      `Media provider not available: ${providerId}${formatMissingProviderHint(providerId)}`,
    );
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
    const audioLanguage =
      requestOverrides.language ??
      entry.language ??
      params.config?.language ??
      cfg.tools?.media?.audio?.language;
    const audioPrompt =
      requestOverrides.prompt ??
      resolveAudioProviderPrompt({
        prompt,
        hasConfiguredPrompt,
        language: audioLanguage,
      });
    const { auth, baseUrl, headers, request } = await resolveProviderExecutionContext({
      capability,
      providerId,
      provider,
      cfg,
      entry,
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
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
        workspaceDir: params.workspaceDir,
      }) ||
      entry.model;
    const authSource = auth.source ?? `provider:${providerId}`;
    const buildRequest = (requestAuth: { kind: "api-key"; apiKey: string } | { kind: "none" }) => ({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      apiKey: requestAuth.kind === "api-key" ? requestAuth.apiKey : CUSTOM_LOCAL_AUTH_MARKER,
      auth:
        requestAuth.kind === "api-key"
          ? { kind: "api-key" as const, apiKey: requestAuth.apiKey, source: auth.source }
          : { kind: "none" as const, source: authSource },
      baseUrl,
      headers,
      request,
      model,
      language: audioLanguage,
      prompt: audioPrompt,
      query: providerQuery,
      timeoutMs,
      fetchFn,
    });
    const result =
      auth.kind === "api-key"
        ? await executeWithApiKeyRotation({
            provider: providerId,
            apiKeys: auth.apiKeys,
            transientRetry: providerOperationRetryConfig("read"),
            execute: async (apiKey) => transcribeAudio(buildRequest({ kind: "api-key", apiKey })),
          })
        : await transcribeAudio(buildRequest({ kind: "none" }));
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
  const { auth, baseUrl, headers, request } = await resolveProviderExecutionContext({
    capability,
    providerId,
    provider,
    cfg,
    entry,
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  const authSource = auth.source ?? `provider:${providerId}`;
  const buildRequest = (requestAuth: { kind: "api-key"; apiKey: string } | { kind: "none" }) => ({
    buffer: media.buffer,
    fileName: media.fileName,
    mime: media.mime,
    apiKey: requestAuth.kind === "api-key" ? requestAuth.apiKey : CUSTOM_LOCAL_AUTH_MARKER,
    auth:
      requestAuth.kind === "api-key"
        ? { kind: "api-key" as const, apiKey: requestAuth.apiKey, source: auth.source }
        : { kind: "none" as const, source: authSource },
    baseUrl,
    headers,
    request,
    model: entry.model,
    prompt,
    timeoutMs,
    fetchFn,
  });
  const result =
    auth.kind === "api-key"
      ? await executeWithApiKeyRotation({
          provider: providerId,
          apiKeys: auth.apiKeys,
          transientRetry: providerOperationRetryConfig("read"),
          execute: (apiKey) => describeVideo(buildRequest({ kind: "api-key", apiKey })),
        })
      : await describeVideo(buildRequest({ kind: "none" }));
  return {
    kind: "video.description",
    attachmentIndex: params.attachmentIndex,
    text: trimOutput(result.text, maxChars),
    provider: providerId,
    model: result.model ?? entry.model,
  };
}

/** Executes one CLI-backed media-understanding entry for one attachment. */
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
    const { stdout, stderr } = await runExec(
      expectDefined(argv[0], "argv entry at 0"),
      argv.slice(1),
      {
        timeoutMs,
        maxBuffer: CLI_OUTPUT_MAX_BUFFER,
        cwd: isAntigravityCliCommand(command) ? path.dirname(mediaPath) : undefined,
      },
    );
    const requestedBackend =
      capability === "audio"
        ? resolveRequestedLocalAudioBackend({
            command,
            args: argv.slice(1),
          })
        : undefined;
    const observedBackend =
      capability === "audio"
        ? recordLocalAudioBackendObservation({
            command,
            args: argv.slice(1),
            output: `${stderr ?? ""}\n${stdout}`,
          })
        : undefined;
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
      provider: capability === "audio" ? commandBase(command) : "cli",
      model: command,
      ...(requestedBackend ? { requestedBackend } : {}),
      ...(observedBackend ? { observedBackend } : {}),
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}
