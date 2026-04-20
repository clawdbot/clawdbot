import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasAvailableAuthForProvider } from "../agents/model-auth.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { findNormalizedProviderValue } from "../agents/provider-id.js";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { logWarn } from "../logger.js";
import { resolveChannelInboundAttachmentRoots } from "../media/channel-inbound-roots.js";
import { mergeInboundPathRoots } from "../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { runExec } from "../process/exec.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import { MediaAttachmentCache, selectAttachments } from "./attachments.js";
import { resolveAutoMediaKeyProviders, resolveDefaultMediaModel } from "./defaults.js";
import { isMediaUnderstandingSkipError } from "./errors.js";
import { fileExists } from "./fs.js";
import { extractGeminiResponse } from "./output-extract.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./provider-registry.js";
import { providerSupportsCapability } from "./provider-supports.js";
import { resolveModelEntries, resolveScopeDecision } from "./resolve.js";
import {
  buildModelDecision,
  formatDecisionSummary,
  runCliEntry,
  runProviderEntry,
} from "./runner.entries.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
export { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
export type { ActiveMediaModel } from "./active-model.types.js";

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;

export type RunCapabilityResult = {
  outputs: MediaUnderstandingOutput[];
  decision: MediaUnderstandingDecision;
};

function resolveConfiguredKeyProviderOrder(params: {
  cfg: OpenClawConfig;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  fallbackProviders: readonly string[];
}): string[] {
  const configuredProviders = Object.keys(params.cfg.models?.providers ?? {})
    .map((providerId) => normalizeMediaProviderId(providerId))
    .filter(Boolean)
    .filter((providerId, index, values) => values.indexOf(providerId) === index)
    .filter((providerId) =>
      providerSupportsCapability(params.providerRegistry.get(providerId), params.capability),
    );

  return [...new Set([...configuredProviders, ...params.fallbackProviders])];
}

function resolveConfiguredImageModelId(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const providerCfg = findNormalizedProviderValue(
    params.cfg.models?.providers,
    params.providerId,
  ) as
    | {
        models?: Array<{
          id?: string;
          input?: string[];
        }>;
      }
    | undefined;
  const configured = providerCfg?.models?.find((entry) => {
    const id = entry?.id?.trim();
    return Boolean(id) && entry?.input?.includes("image");
  });
  const id = configured?.id?.trim();
  return id || undefined;
}

function resolveCatalogImageModelId(params: {
  providerId: string;
  catalog: Awaited<ReturnType<typeof loadModelCatalog>>;
}): string | undefined {
  const matches = params.catalog.filter(
    (entry) =>
      normalizeMediaProviderId(entry.provider) === params.providerId && modelSupportsVision(entry),
  );
  if (matches.length === 0) {
    return undefined;
  }
  const autoEntry = matches.find((entry) => normalizeLowercaseStringOrEmpty(entry.id) === "auto");
  return normalizeOptionalString((autoEntry ?? matches[0])?.id);
}

async function resolveAutoImageModelId(params: {
  cfg: OpenClawConfig;
  providerId: string;
  explicitModel?: string;
}): Promise<string | undefined> {
  const explicit = normalizeOptionalString(params.explicitModel);
  if (explicit) {
    return explicit;
  }
  const configuredModel = resolveConfiguredImageModelId(params);
  if (configuredModel) {
    return configuredModel;
  }
  const defaultModel = resolveDefaultMediaModel({
    cfg: params.cfg,
    providerId: params.providerId,
    capability: "image",
  });
  if (defaultModel) {
    return defaultModel;
  }
  const catalog = await loadModelCatalog({ config: params.cfg });
  return resolveCatalogImageModelId({
    providerId: params.providerId,
    catalog,
  });
}

export function buildProviderRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): ProviderRegistry {
  return buildMediaUnderstandingRegistry(overrides, cfg);
}

export function resolveMediaAttachmentLocalRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] {
  return mergeInboundPathRoots(
    getDefaultMediaLocalRoots(),
    resolveChannelInboundAttachmentRoots(params),
  );
}

const binaryCache = new Map<string, Promise<string | null>>();
const geminiProbeCache = new Map<string, Promise<boolean>>();

export function clearMediaUnderstandingBinaryCacheForTests(): void {
  binaryCache.clear();
  geminiProbeCache.clear();
}

function expandHomeDir(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }
  const home = os.homedir();
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function candidateBinaryNames(name: string): string[] {
  if (process.platform !== "win32") {
    return [name];
  }
  const ext = path.extname(name);
  if (ext) {
    return [name];
  }
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
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(name: string): Promise<string | null> {
  const cached = binaryCache.get(name);
  if (cached) {
    return cached;
  }
  const resolved = (async () => {
    const direct = expandHomeDir(name.trim());
    if (direct && hasPathSeparator(direct)) {
      for (const candidate of candidateBinaryNames(direct)) {
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }

    const searchName = name.trim();
    if (!searchName) {
      return null;
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    const candidates = candidateBinaryNames(searchName);
    for (const entryRaw of pathEntries) {
      const entry = expandHomeDir(entryRaw.trim().replace(/^"(.*)"$/, "$1"));
      if (!entry) {
        continue;
      }
      for (const candidate of candidates) {
        const fullPath = path.join(entry, candidate);
        if (await isExecutable(fullPath)) {
          return fullPath;
        }
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

async function probeGeminiCli(): Promise<boolean> {
  const cached = geminiProbeCache.get("gemini");
  if (cached) {
    return cached;
  }
  const resolved = (async () => {
    if (!(await hasBinary("gemini"))) {
      return false;
    }
    try {
      const { stdout } = await runExec("gemini", ["--output-format", "json", "ok"], {
        timeoutMs: 8000,
      });
      return Boolean(
        extractGeminiResponse(stdout) ?? normalizeLowercaseStringOrEmpty(stdout).includes("ok"),
      );
    } catch {
      return false;
    }
  })();
  geminiProbeCache.set("gemini", resolved);
  return resolved;
}

async function resolveLocalWhisperCppEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("whisper-cli"))) {
    return null;
  }
  const envModel = process.env.WHISPER_CPP_MODEL?.trim();
  const defaultModel = "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
  const modelPath = envModel && (await fileExists(envModel)) ? envModel : defaultModel;
  if (!(await fileExists(modelPath))) {
    return null;
  }
  return {
    type: "cli",
    command: "whisper-cli",
    args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-np", "-nt", "{{MediaPath}}"],
  };
}

async function resolveLocalWhisperEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("whisper"))) {
    return null;
  }
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
  if (!(await hasBinary("sherpa-onnx-offline"))) {
    return null;
  }
  const modelDir = process.env.SHERPA_ONNX_MODEL_DIR?.trim();
  if (!modelDir) {
    return null;
  }
  const tokens = path.join(modelDir, "tokens.txt");
  const encoder = path.join(modelDir, "encoder.onnx");
  const decoder = path.join(modelDir, "decoder.onnx");
  const joiner = path.join(modelDir, "joiner.onnx");
  if (!(await fileExists(tokens))) {
    return null;
  }
  if (!(await fileExists(encoder))) {
    return null;
  }
  if (!(await fileExists(decoder))) {
    return null;
  }
  if (!(await fileExists(joiner))) {
    return null;
  }
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
  if (sherpa) {
    return sherpa;
  }
  const whisperCpp = await resolveLocalWhisperCppEntry();
  if (whisperCpp) {
    return whisperCpp;
  }
  return await resolveLocalWhisperEntry();
}

async function resolveGeminiCliEntry(
  _capability: MediaUnderstandingCapability,
): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await probeGeminiCli())) {
    return null;
  }
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
  cfg: OpenClawConfig;
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
    if (!provider) {
      return null;
    }
    if (capability === "audio" && !provider.transcribeAudio) {
      return null;
    }
    if (capability === "image" && !provider.describeImage) {
      return null;
    }
    if (capability === "video" && !provider.describeVideo) {
      return null;
    }
    if (
      !(await hasAvailableAuthForProvider({
        provider: providerId,
        cfg,
        agentDir,
      }))
    ) {
      return null;
    }
    const resolvedModel =
      capability === "image"
        ? await resolveAutoImageModelId({ cfg, providerId, explicitModel: model })
        : model;
    if (capability === "image" && !resolvedModel) {
      return null;
    }
    return { type: "provider" as const, provider: providerId, model: resolvedModel };
  };

  const activeProvider = params.activeModel?.provider?.trim();
  if (activeProvider) {
    const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
    if (activeEntry) {
      return activeEntry;
    }
  }
  for (const providerId of resolveConfiguredKeyProviderOrder({
    cfg,
    providerRegistry,
    capability,
    fallbackProviders: resolveAutoMediaKeyProviders({
      cfg,
      capability,
      providerRegistry,
    }),
  })) {
    const entry = await checkProvider(providerId, undefined);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function resolveImageModelFromAgentDefaults(cfg: OpenClawConfig): MediaUnderstandingModelConfig[] {
  const refs: string[] = [];
  const primary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel);
  if (primary?.trim()) {
    refs.push(primary.trim());
  }
  for (const fb of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) {
    if (fb?.trim()) {
      refs.push(fb.trim());
    }
  }
  if (refs.length === 0) {
    return [];
  }
  const entries: MediaUnderstandingModelConfig[] = [];
  for (const ref of refs) {
    const slashIdx = ref.indexOf("/");
    if (slashIdx <= 0 || slashIdx >= ref.length - 1) {
      continue;
    }
    entries.push({
      type: "provider",
      provider: ref.slice(0, slashIdx),
      model: ref.slice(slashIdx + 1),
    });
  }
  return entries;
}

async function resolveAutoEntries(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig[]> {
  const activeEntry = await resolveActiveModelEntry(params);
  if (activeEntry) {
    return [activeEntry];
  }
  if (params.capability === "audio") {
    const localAudio = await resolveLocalAudioEntry();
    if (localAudio) {
      return [localAudio];
    }
  }
  if (params.capability === "image") {
    const imageModelEntries = resolveImageModelFromAgentDefaults(params.cfg);
    if (imageModelEntries.length > 0) {
      return imageModelEntries;
    }
  }
  const gemini = await resolveGeminiCliEntry(params.capability);
  if (gemini) {
    return [gemini];
  }
  const keys = await resolveKeyEntry(params);
  if (keys) {
    return [keys];
  }
  return [];
}

export async function resolveAutoImageModel(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel?: ActiveMediaModel;
}): Promise<ActiveMediaModel | null> {
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  const toActive = (entry: MediaUnderstandingModelConfig | null): ActiveMediaModel | null => {
    if (!entry || entry.type === "cli") {
      return null;
    }
    const provider = entry.provider;
    const model = entry.model?.trim();
    if (!provider || !model) {
      return null;
    }
    return { provider, model };
  };
  const activeEntry = await resolveActiveModelEntry({
    cfg: params.cfg,
    agentDir: params.agentDir,
    providerRegistry,
    capability: "image",
    activeModel: params.activeModel,
  });
  const resolvedActive = toActive(activeEntry);
  if (resolvedActive) {
    return resolvedActive;
  }
  const keyEntry = await resolveKeyEntry({
    cfg: params.cfg,
    agentDir: params.agentDir,
    providerRegistry,
    capability: "image",
    activeModel: params.activeModel,
  });
  return toActive(keyEntry);
}

async function resolveActiveModelEntry(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig | null> {
  const activeProviderRaw = params.activeModel?.provider?.trim();
  if (!activeProviderRaw) {
    return null;
  }
  const providerId = normalizeMediaProviderId(activeProviderRaw);
  if (!providerId) {
    return null;
  }
  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    return null;
  }
  if (params.capability === "audio" && !provider.transcribeAudio) {
    return null;
  }
  if (params.capability === "image" && !provider.describeImage) {
    return null;
  }
  if (params.capability === "video" && !provider.describeVideo) {
    return null;
  }
  const hasAuth = await hasAvailableAuthForProvider({
    provider: providerId,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  if (!hasAuth) {
    return null;
  }
  const model =
    params.capability === "image"
      ? await resolveAutoImageModelId({
          cfg: params.cfg,
          providerId,
          explicitModel: params.activeModel?.model,
        })
      : params.activeModel?.model;
  if (params.capability === "image" && !model) {
    return null;
  }
  return {
    type: "provider",
    provider: providerId,
    model,
  };
}

async function runAttachmentEntries(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
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
        if (result.provider) {
          decision.provider = result.provider;
        }
        if (result.model) {
          decision.model = result.model;
        }
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

function hasFailedMediaAttempt(attachments: MediaUnderstandingDecision["attachments"]): boolean {
  return attachments.some((attachment) =>
    attachment.attempts.some((attempt) => attempt.outcome === "failed"),
  );
}

export async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
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
    if (output) {
      outputs.push(output);
    }
    attachmentDecisions.push({
      attachmentIndex: attachment.index,
      attempts,
      chosen: attempts.find((attempt) => attempt.outcome === "success"),
    });
  }
  const decision: MediaUnderstandingDecision = {
    capability,
    outcome:
      outputs.length > 0
        ? "success"
        : hasFailedMediaAttempt(attachmentDecisions)
          ? "failed"
          : "skipped",
    attachments: attachmentDecisions,
  };
  if (decision.outcome === "failed") {
    logWarn(`media-understanding: ${formatDecisionSummary(decision)}`);
  } else if (shouldLogVerbose()) {
    logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
  }
  return {
    outputs,
    decision,
  };
}
