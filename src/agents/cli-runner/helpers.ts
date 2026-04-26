import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { MAX_IMAGE_BYTES } from "../../media/constants.js";
import { extensionForMime } from "../../media/mime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { detectImageReferences, loadImageFromRef } from "../pi-embedded-runner/run/images.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { detectRuntimeShell } from "../shell-utils.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
import { sanitizeImageBlocks } from "../tool-images.js";
import { formatTomlConfigOverride } from "./toml-inline.js";
export { buildCliSupervisorScopeKey, resolveCliNoOutputTimeoutMs } from "./reliability.js";

const CLI_RUN_QUEUE = new KeyedAsyncQueue();

function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === "claude-cli";
}

export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  return CLI_RUN_QUEUE.enqueue(key, task);
}

export function resolveCliRunQueueKey(params: {
  backendId: string;
  serialize?: boolean;
  runId: string;
  workspaceDir: string;
  cliSessionId?: string;
}): string {
  if (params.serialize === false) {
    return `${params.backendId}:${params.runId}`;
  }
  if (isClaudeCliProvider(params.backendId)) {
    const sessionId = params.cliSessionId?.trim();
    if (sessionId) {
      return `${params.backendId}:session:${sessionId}`;
    }
    const workspaceDir = params.workspaceDir.trim();
    if (workspaceDir) {
      return `${params.backendId}:workspace:${workspaceDir}`;
    }
  }
  return params.backendId;
}

export function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  sourcePath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  modelDisplay: string;
  agentId?: string;
}) {
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "openclaw",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
    },
  });
  const ttsHint = params.config
    ? buildTtsSystemPromptHint(params.config, params.agentId)
    : undefined;
  const ownerDisplay = resolveOwnerDisplaySetting(params.config);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    sourcePath: params.sourcePath,
    acpEnabled: isAcpRuntimeSpawnAvailable({ config: params.config }),
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: buildModelAliasLines(params.config),
    skillsPrompt: params.skillsPrompt,
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: params.contextFiles,
    ttsHint,
    memoryCitationsMode: params.config?.memory?.citations,
  });
}

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

export function appendImagePathsToPrompt(prompt: string, paths: string[], prefix = ""): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.map((entry) => `${prefix}${entry}`).join("\n")}`;
}

export async function loadPromptRefImages(params: {
  prompt: string;
  workspaceDir: string;
  maxBytes?: number;
  workspaceOnly?: boolean;
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<ImageContent[]> {
  const refs = detectImageReferences(params.prompt);
  if (refs.length === 0) {
    return [];
  }

  const maxBytes = params.maxBytes ?? MAX_IMAGE_BYTES;
  const seen = new Set<string>();
  const images: ImageContent[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.resolved}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes,
      workspaceOnly: params.workspaceOnly,
      sandbox: params.sandbox,
    });
    if (image) {
      images.push(image);
    }
  }

  const { images: sanitizedImages } = await sanitizeImageBlocks(images, "prompt:images", {
    maxBytes,
  });
  return sanitizedImages;
}

export async function writeCliImages(params: {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
}): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const imageRoot = resolveCliImageRoot({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
  });
  await fs.mkdir(imageRoot, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (let i = 0; i < params.images.length; i += 1) {
    const image = params.images[i];
    const fileName = path.basename(resolveCliImagePath(image));
    const filePath = path.join(imageRoot, fileName);
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    paths.push(filePath);
  }
  // Keep content-addressed image paths stable across Claude CLI runs so prompt
  // text and argv don't churn on every turn with fresh temp-dir suffixes.
  const cleanup = async () => {};
  return { paths, cleanup };
}

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
  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-system-prompt-"),
  );
  const filePath = path.join(tempDir, "system-prompt.md");
  await fs.writeFile(filePath, stripSystemPromptCacheBoundary(params.systemPrompt), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return {
    filePath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function prepareCliPromptImagePayload(params: {
  backend: CliBackendConfig;
  prompt: string;
  workspaceDir: string;
  images?: ImageContent[];
}): Promise<{
  prompt: string;
  imagePaths?: string[];
  cleanupImages?: () => Promise<void>;
}> {
  let prompt = params.prompt;
  const resolvedImages =
    params.images && params.images.length > 0
      ? params.images
      : await loadPromptRefImages({ prompt, workspaceDir: params.workspaceDir });
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
}): string[] {
  const args: string[] = [...params.baseArgs];
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (
    !params.useResume &&
    params.systemPrompt &&
    params.systemPromptFilePath &&
    params.backend.systemPromptFileArg
  ) {
    args.push(params.backend.systemPromptFileArg, params.systemPromptFilePath);
  } else if (
    !params.useResume &&
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
  } else if (!params.useResume && params.systemPrompt && params.backend.systemPromptArg) {
    args.push(params.backend.systemPromptArg, stripSystemPromptCacheBoundary(params.systemPrompt));
  }
  if (!params.useResume && params.sessionId) {
    if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) {
      for (const entry of params.backend.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", params.sessionId));
      }
    } else if (params.backend.sessionArg) {
      args.push(params.backend.sessionArg, params.sessionId);
    }
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
