/**
 * Shared helpers for CLI runner prompts, args, queueing, sessions, and image
 * payload preparation.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { privateFileStore } from "../../infra/private-file-store.js";
import { tempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { ImageContent } from "../../llm/types.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
} from "../embedded-agent-runner/run/images.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import type { AgentTool } from "../runtime/index.js";
import { detectRuntimeShell } from "../shell-utils.js";
import { buildConfiguredAgentSystemPrompt } from "../system-prompt-config.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";
import { cliBackendLog } from "./log.js";
import { formatTomlConfigOverride } from "./toml-inline.js";
/** Re-export CLI reliability helpers used by older runner call sites. */
export {
  buildCliSupervisorScopeKey,
  resolveCliNoOutputTimeoutMs,
  resolveCliRunTimeoutOverrideMs,
} from "./reliability.js";

const CLI_RUN_QUEUE = new KeyedAsyncQueue();
const CLI_IMAGE_SWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const sweptCliImageRoots = new Set<string>();

export function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === "claude-cli";
}

/** Enqueues a CLI run under a backend/session key to prevent unsafe overlap. */
export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  return CLI_RUN_QUEUE.enqueue(key, task);
}

/**
 * Hashes the (account, agent, auth-profile, session) tuple to a stable owner key
 * shared between the CLI run queue (`resolveCliRunQueueKey`) and the Claude live
 * session map (`buildClaudeLiveKey`). The two paths must agree byte-for-byte
 * within a single process so a fresh queued turn picks up the same live session
 * the registry already holds; the golden-hash test below pins the encoding.
 */
export function buildClaudeOwnerKey(input: {
  agentAccountId?: string;
  agentId?: string;
  authProfileId?: string;
  sessionId?: string;
  sessionKey?: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        agentAccountId: input.agentAccountId,
        agentId: input.agentId,
        authProfileId: input.authProfileId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
      }),
    )
    .digest("hex");
}

/** Resolves the serialization key for a CLI backend run. */
export function resolveCliRunQueueKey(params: {
  backendId: string;
  liveSession?: CliBackendConfig["liveSession"];
  serialize?: boolean;
  runId: string;
  workspaceDir: string;
  cliSessionId?: string;
  ownerKey?: string;
}): string {
  const requiresLiveSessionSerialization =
    isClaudeCliProvider(params.backendId) && params.liveSession === "claude-stdio";
  if (params.serialize === false && !requiresLiveSessionSerialization) {
    return `${params.backendId}:${params.runId}`;
  }
  if (isClaudeCliProvider(params.backendId)) {
    const ownerKey = params.ownerKey?.trim();
    if (requiresLiveSessionSerialization && ownerKey) {
      return `${params.backendId}:owner:${ownerKey}`;
    }
    const sessionId = params.cliSessionId?.trim();
    if (sessionId) {
      return `${params.backendId}:session:${sessionId}`;
    }
    if (ownerKey) {
      return `${params.backendId}:owner:${ownerKey}`;
    }
    const workspaceDir = params.workspaceDir.trim();
    if (workspaceDir) {
      return `${params.backendId}:workspace:${workspaceDir}`;
    }
  }
  return params.backendId;
}

/** Builds the system prompt sent to a CLI-backed agent runtime. */
export function buildCliAgentSystemPrompt(params: {
  workspaceDir: string;
  cwd?: string;
  config?: OpenClawConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  silentReplyPromptMode?: SilentReplyPromptMode;
  runtimeChannel?: string;
  runtimeChatType?: ChatType;
  runtimeCapabilities?: string[];
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  sourcePath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  bootstrapMode?: BootstrapMode;
  skillsPrompt?: string;
  modelDisplay: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}) {
  const runtimeWorkspaceDir = params.cwd?.trim() || params.workspaceDir;
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: runtimeWorkspaceDir,
    cwd: runtimeWorkspaceDir,
    runtime: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      host: "openclaw",
      os: resolveRuntimeOsLabel(),
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
      channel: params.runtimeChannel,
      chatType: params.runtimeChatType,
      capabilities: params.runtimeCapabilities,
    },
  });
  return buildConfiguredAgentSystemPrompt({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: runtimeWorkspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    silentReplyPromptMode: params.silentReplyPromptMode,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    sourcePath: params.sourcePath,
    acpEnabled: isAcpRuntimeSpawnAvailable({ config: params.config }),
    promptSurface: "cli_backend",
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
      surface: "cli_backend",
    }),
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    skillsPrompt: params.skillsPrompt,
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: params.contextFiles,
    bootstrapMode: params.bootstrapMode,
  });
}

/** Applies backend model aliases to a requested CLI model id. */
export function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const direct = backend.modelAliases?.[trimmed];
  if (direct) {
    return direct;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const mapped = backend.modelAliases?.[lower];
  if (mapped) {
    return mapped;
  }
  return trimmed;
}

/** Decides whether a system prompt should be sent for this CLI turn. */
export function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  if (!systemPrompt) {
    return null;
  }
  const when = params.backend.systemPromptWhen ?? "first";
  if (when === "never") {
    return null;
  }
  if (when === "first" && !params.isNewSession) {
    return null;
  }
  if (
    !params.backend.systemPromptArg?.trim() &&
    !params.backend.systemPromptFileArg?.trim() &&
    !params.backend.systemPromptFileConfigKey?.trim()
  ) {
    return null;
  }
  return systemPrompt;
}

/** Resolves the CLI session id to send and whether the turn starts a new session. */
export function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  if (mode === "none") {
    return { sessionId: undefined, isNew: !existing };
  }
  if (mode === "existing") {
    return { sessionId: existing, isNew: !existing };
  }
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

/** Routes prompt text to argv or stdin based on backend input policy. */
export function resolvePromptInput(params: { backend: CliBackendConfig; prompt: string }): {
  argsPrompt?: string;
  stdin?: string;
} {
  const inputMode = params.backend.input ?? "arg";
  if (inputMode === "stdin") {
    return { stdin: params.prompt };
  }
  if (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveCliImagePath(image: ImageContent): string {
  const ext = extensionForMime(image.mimeType) ?? ".bin";
  const digest = crypto
    .createHash("sha256")
    .update(image.mimeType)
    .update("\0")
    .update(image.data)
    .digest("hex");
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", `${digest}${ext}`);
}

function resolveCliImageRoot(params: { backend: CliBackendConfig; workspaceDir: string }): string {
  if (params.backend.imagePathScope === "workspace") {
    return path.join(params.workspaceDir, ".openclaw-cli-images");
  }
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images");
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

async function sweepCliImageRoot(imageRoot: string): Promise<void> {
  if (sweptCliImageRoots.has(imageRoot)) {
    return;
  }
  sweptCliImageRoots.add(imageRoot);
  try {
    const cutoffMs = Date.now() - CLI_IMAGE_SWEEP_TTL_MS;
    const entries = await fs.readdir(imageRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const entryPath = path.join(imageRoot, entry.name);
      const stat = await fs.stat(entryPath).catch((error: unknown) => {
        if (isFileNotFoundError(error)) {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        continue;
      }
      if (stat.mtimeMs >= cutoffMs) {
        continue;
      }
      try {
        await fs.rm(entryPath, { force: true });
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
      }
    }
  } catch (error) {
    cliBackendLog.debug(`cli image cache sweep failed: ${String(error)}`);
  }
}

function appendImagePathsToPrompt(prompt: string, paths: string[], prefix = ""): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.map((entry) => `${prefix}${entry}`).join("\n")}`;
}

/** Writes CLI image payloads to private paths and returns their file paths. */
async function writeCliImages(params: {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
}): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const imageRoot = resolveCliImageRoot({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
  });
  await fs.mkdir(imageRoot, { recursive: true, mode: 0o700 });
  await sweepCliImageRoot(imageRoot);
  const store = privateFileStore(imageRoot);
  const paths: string[] = [];
  for (const image of params.images) {
    const fileName = path.basename(resolveCliImagePath(image));
    const buffer = Buffer.from(image.data, "base64");
    await store.writeText(fileName, buffer);
    paths.push(store.path(fileName));
  }
  // Keep content-addressed image paths stable across Claude CLI runs so prompt
  // text and argv don't churn on every turn with fresh temp-dir suffixes.
  const cleanup = async () => {};
  return { paths, cleanup };
}

/** Writes a temporary system prompt file when the backend needs file-based prompts. */
export async function writeCliSystemPromptFile(params: {
  backend: CliBackendConfig;
  systemPrompt: string;
}): Promise<{ filePath?: string; cleanup: () => Promise<void> }> {
  if (
    !params.backend.systemPromptFileArg?.trim() &&
    !params.backend.systemPromptFileConfigKey?.trim()
  ) {
    return { cleanup: async () => {} };
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-cli-system-prompt-",
  });
  const filePath = await workspace.write(
    "system-prompt.md",
    stripSystemPromptCacheBoundary(params.systemPrompt),
  );
  return {
    filePath,
    cleanup: async () => await workspace.cleanup(),
  };
}

/** Prepares prompt text and image paths for a CLI backend run. */
export async function prepareCliPromptImagePayload(params: {
  backend: CliBackendConfig;
  prompt: string;
  imagePrompt?: string;
  workspaceDir: string;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  media?: MediaFact[];
}): Promise<{
  prompt: string;
  imagePaths?: string[];
  cleanupImages?: () => Promise<void>;
}> {
  let prompt = params.prompt;
  const imagePrompt = params.imagePrompt ?? prompt;
  const needsHydration =
    params.imagePrompt !== undefined ||
    Boolean(params.media?.length) ||
    (!params.images?.length && detectImageReferences(imagePrompt).length > 0);
  const imageResult = needsHydration
    ? await detectAndLoadPromptImages({
        prompt: imagePrompt,
        media: params.media,
        workspaceDir: params.workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: params.images,
        imageOrder: params.imageOrder,
        maxBytes: MAX_IMAGE_BYTES,
      })
    : undefined;
  if (imageResult?.failedMediaCount) {
    throw new Error(
      `failed to hydrate ${imageResult.failedMediaCount} structured image attachment(s) for CLI input`,
    );
  }
  const resolvedImages = imageResult?.images ?? params.images ?? [];
  if (resolvedImages.length === 0) {
    return { prompt };
  }
  const imagePayload = await writeCliImages({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
    images: resolvedImages,
  });
  const imagePaths = imagePayload.paths;
  if (
    !params.backend.imageArg ||
    params.backend.input === "stdin" ||
    params.backend.imageArg === "@"
  ) {
    prompt = appendImagePathsToPrompt(
      prompt,
      imagePaths,
      params.backend.imageArg === "@" ? "@" : "",
    );
  }
  return {
    prompt,
    imagePaths,
    cleanupImages: imagePayload.cleanup,
  };
}

/** Builds final CLI argv from backend config and prepared prompt/session inputs. */
export function buildCliArgs(params: {
  backend: CliBackendConfig;
  baseArgs: string[];
  modelId: string;
  sessionId?: string;
  systemPrompt?: string | null;
  systemPromptFilePath?: string;
  imagePaths?: string[];
  promptArg?: string;
  useResume: boolean;
  forkResume?: boolean;
  sendSystemPromptOnResume?: boolean;
}): string[] {
  const args: string[] = [...params.baseArgs];
  const shouldSendSystemPrompt =
    !params.useResume ||
    params.backend.systemPromptWhen === "always" ||
    params.sendSystemPromptOnResume;
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (
    shouldSendSystemPrompt &&
    params.systemPrompt &&
    params.systemPromptFilePath &&
    params.backend.systemPromptFileArg
  ) {
    args.push(params.backend.systemPromptFileArg, params.systemPromptFilePath);
  } else if (
    shouldSendSystemPrompt &&
    params.systemPrompt &&
    params.systemPromptFilePath &&
    params.backend.systemPromptFileConfigKey
  ) {
    args.push(
      params.backend.systemPromptFileConfigArg ?? "-c",
      formatTomlConfigOverride(
        params.backend.systemPromptFileConfigKey,
        params.systemPromptFilePath,
      ),
    );
  } else if (shouldSendSystemPrompt && params.systemPrompt && params.backend.systemPromptArg) {
    args.push(params.backend.systemPromptArg, stripSystemPromptCacheBoundary(params.systemPrompt));
  }
  if (!params.useResume && params.sessionId) {
    if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) {
      for (const entry of params.backend.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", params.sessionId));
      }
    }
  }
  if (params.useResume && params.forkResume) {
    if (!params.backend.forkArg) {
      throw new Error("CLI backend does not support forked session resume");
    }
    args.push(params.backend.forkArg);
  }
  if (params.promptArg !== undefined) {
    let replacedPromptPlaceholder = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "{prompt}") {
        args[i] = params.promptArg;
        replacedPromptPlaceholder = true;
      }
    }
    if (!replacedPromptPlaceholder) {
      args.push(params.promptArg);
    }
  }
  if (params.imagePaths && params.imagePaths.length > 0) {
    const mode = params.backend.imageMode ?? "repeat";
    const imageArg = params.backend.imageArg;
    if (imageArg && imageArg !== "@") {
      if (mode === "list") {
        args.push(imageArg, params.imagePaths.join(","));
      } else {
        for (const imagePath of params.imagePaths) {
          args.push(imageArg, imagePath);
        }
      }
    }
  }
  return args;
}
