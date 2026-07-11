/**
 * Builds Codex app-server prompt context, workspace bootstrap injections,
 * system-prompt reports, and context-engine projection decisions.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildBootstrapContextForFiles,
  embeddedAgentLog,
  resolveBootstrapFilesForRun,
  type AgentMessage,
  type ContextEngineProjection,
  type EmbeddedContextFile,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import type { CodexDynamicToolFunctionSpec, CodexDynamicToolSpec, JsonValue } from "./protocol.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  buildContextEngineBinding,
  isContextEngineBindingCompatible,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
const CODEX_INHERITED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set(["tools.md"]);
const CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
  "identity.md",
  "soul.md",
  "user.md",
]);
const CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
  ...CODEX_INHERITED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  ...CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
]);
const CODEX_HEARTBEAT_CONTEXT_BASENAME = "heartbeat.md";
const CODEX_MEMORY_CONTEXT_BASENAME = "memory.md";
const CODEX_MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
const CODEX_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["user.md", 30],
  ["tools.md", 40],
  ["bootstrap.md", 50],
  ["memory.md", 60],
  ["heartbeat.md", 70],
]);

type CodexBootstrapFile = Awaited<ReturnType<typeof resolveBootstrapFilesForRun>>[number];
type CodexBootstrapContext = {
  bootstrapFiles: CodexBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
/** System prompt accounting report attached to Codex attempt results. */
export type CodexSystemPromptReport = NonNullable<EmbeddedRunAttemptResult["systemPromptReport"]>;
type CodexToolReportEntry = CodexSystemPromptReport["tools"]["entries"][number];
type CodexWorkspaceBootstrapContext = CodexBootstrapContext & {
  promptContextFiles?: EmbeddedContextFile[];
  developerInstructionFiles?: EmbeddedContextFile[];
  turnScopedDeveloperInstructionFiles?: EmbeddedContextFile[];
  heartbeatReferenceFiles?: EmbeddedContextFile[];
  memoryReferenceFiles?: EmbeddedContextFile[];
  memoryToolRoutedBootstrapFiles?: CodexBootstrapFile[];
  memoryToolNames?: string[];
  memoryToolRouted?: boolean;
  promptContext?: string;
  developerInstructions?: string;
  turnScopedDeveloperInstructions?: string;
  memoryCollaborationInstructions?: string;
  heartbeatCollaborationInstructions?: string;
};

/** Reads mirrored Codex session history for harness hooks. */
export async function readMirroredSessionHistoryMessages(params: {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
}): Promise<AgentMessage[] | undefined> {
  const messages = await readCodexMirroredSessionHistoryMessages(params);
  if (!messages) {
    embeddedAgentLog.warn("failed to read mirrored session history for codex harness hooks", {
      sessionFile: params.sessionFile,
    });
  }
  return messages;
}

/** Reads a valid thread-bootstrap projection request from context-engine output. */
export function readContextEngineThreadBootstrapProjection(
  projection: ContextEngineProjection | undefined,
): CodexContextEngineThreadBootstrapProjection | undefined {
  if (projection?.mode !== "thread_bootstrap") {
    return undefined;
  }
  const epoch = projection.epoch?.trim();
  if (!epoch) {
    embeddedAgentLog.warn(
      "context engine requested Codex thread-bootstrap projection without an epoch; using per-turn projection",
    );
    return undefined;
  }
  const fingerprint = projection.fingerprint?.trim();
  return {
    mode: "thread_bootstrap",
    epoch,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/**
 * Decides whether an existing Codex thread can reuse its context-engine
 * bootstrap projection or must be reprojected.
 */
export function resolveContextEngineBootstrapProjectionDecision(params: {
  startupBinding: CodexAppServerThreadBinding | undefined;
  expectedBinding: ReturnType<typeof buildContextEngineBinding>;
  projection: CodexContextEngineThreadBootstrapProjection;
  dynamicToolsFingerprint: string;
  legacyDynamicToolsFingerprint?: string;
}): { project: boolean; reason: string } {
  const bindingProjection = params.startupBinding?.contextEngine?.projection;
  if (!params.startupBinding?.threadId || !bindingProjection) {
    return {
      project: true,
      reason: !params.startupBinding?.threadId
        ? "missing-thread-binding"
        : "missing-projection-binding",
    };
  }
  if (
    !params.expectedBinding ||
    !isContextEngineBindingCompatible(params.startupBinding.contextEngine, params.expectedBinding)
  ) {
    return { project: true, reason: "context-engine-binding-mismatch" };
  }
  if (
    !areCodexDynamicToolFingerprintsCompatible({
      previous: params.startupBinding.dynamicToolsFingerprint,
      next: params.dynamicToolsFingerprint,
      nextLegacy: params.legacyDynamicToolsFingerprint,
    })
  ) {
    return { project: true, reason: "dynamic-tools-mismatch" };
  }
  const projectionChanged =
    bindingProjection.mode !== "thread_bootstrap" ||
    bindingProjection.epoch !== params.projection.epoch ||
    bindingProjection.fingerprint !== params.projection.fingerprint;
  return projectionChanged
    ? { project: true, reason: "projection-mismatch" }
    : { project: false, reason: "matching-thread-bootstrap-binding" };
}

/**
 * Loads workspace bootstrap files and partitions them into Codex-native prompt,
 * developer-instruction, heartbeat, and memory-tool contexts.
 */
export async function buildCodexWorkspaceBootstrapContext(params: {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sessionKey: string;
  sessionAgentId: string;
  memoryToolNames: readonly string[];
}): Promise<CodexWorkspaceBootstrapContext> {
  try {
    const memoryToolsAvailable =
      params.memoryToolNames.length > 0 &&
      canRouteCodexWorkspaceMemoryThroughTools({
        config: params.params.config,
        agentId: params.params.agentId ?? params.sessionAgentId,
        workspaceDir: params.effectiveWorkspace,
      });
    // Native Codex turns should read workspace MEMORY.md through tools when
    // possible; pasting it into every prompt turns durable memory into policy.
    const bootstrapFiles = await resolveBootstrapFilesForRun({
      workspaceDir: params.resolvedWorkspace,
      config: params.params.config,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      agentId: params.params.agentId ?? params.sessionAgentId,
      warn: (message) => embeddedAgentLog.warn(message),
      contextMode: params.params.bootstrapContextMode,
      runKind: params.params.bootstrapContextRunKind,
    });
    const memoryToolRoutedBootstrapFiles = memoryToolsAvailable
      ? selectCodexWorkspaceMemoryReferenceFiles({
          bootstrapFiles,
          workspaceDir: params.resolvedWorkspace,
        })
      : [];
    const memoryReferenceFiles = memoryToolRoutedBootstrapFiles.map((file) =>
      remapCodexContextFilePath({
        file: toCodexEmbeddedContextFile(file),
        sourceWorkspaceDir: params.resolvedWorkspace,
        targetWorkspaceDir: params.effectiveWorkspace,
      }),
    );
    const contextFiles = buildBootstrapContextForFiles(
      memoryToolsAvailable
        ? bootstrapFiles.filter(
            (file) =>
              !isCodexWorkspaceRootMemoryBootstrapFile({
                file,
                workspaceDir: params.resolvedWorkspace,
              }),
          )
        : bootstrapFiles,
      {
        config: params.params.config,
        agentId: params.params.agentId ?? params.sessionAgentId,
        warn: (message) => embeddedAgentLog.warn(message),
      },
    ).map((file) =>
      remapCodexContextFilePath({
        file,
        sourceWorkspaceDir: params.resolvedWorkspace,
        targetWorkspaceDir: params.effectiveWorkspace,
      }),
    );
    const promptContextFiles = selectCodexWorkspacePromptContextFiles(contextFiles, {
      excludeMemory: memoryToolsAvailable,
      memoryWorkspaceDir: params.effectiveWorkspace,
    });
    const developerInstructionFiles = shouldInjectCodexOpenClawPromptContext(params.params)
      ? selectCodexWorkspaceInheritedDeveloperInstructionFiles(contextFiles)
      : [];
    const turnScopedDeveloperInstructionFiles = shouldInjectCodexOpenClawPromptContext(
      params.params,
    )
      ? selectCodexWorkspaceTurnScopedDeveloperInstructionFiles(contextFiles)
      : [];
    const heartbeatReferenceFiles = selectCodexWorkspaceHeartbeatReferenceFiles(contextFiles);
    return {
      bootstrapFiles,
      contextFiles,
      promptContextFiles,
      developerInstructionFiles,
      turnScopedDeveloperInstructionFiles,
      heartbeatReferenceFiles,
      memoryReferenceFiles,
      memoryToolRoutedBootstrapFiles,
      memoryToolNames: [...params.memoryToolNames],
      memoryToolRouted: memoryToolsAvailable,
      promptContext: renderCodexWorkspaceBootstrapPromptContext(promptContextFiles),
      developerInstructions:
        renderCodexWorkspaceThreadDeveloperInstructions(developerInstructionFiles),
      turnScopedDeveloperInstructions: renderCodexWorkspaceCollaborationDeveloperInstructions(
        turnScopedDeveloperInstructionFiles,
      ),
      memoryCollaborationInstructions: shouldInjectCodexOpenClawPromptContext(params.params)
        ? renderCodexWorkspaceMemoryCollaborationInstructions({
            files: memoryReferenceFiles,
            toolNames: params.memoryToolNames,
            memoryToolRouted: memoryToolsAvailable,
            citationsMode: params.params.config?.memory?.citations,
            agentId: params.params.agentId ?? params.sessionAgentId,
            agentSessionKey: params.sessionKey,
          })
        : undefined,
      heartbeatCollaborationInstructions:
        renderCodexWorkspaceHeartbeatReference(heartbeatReferenceFiles),
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to load codex workspace bootstrap instructions", { error });
    return { bootstrapFiles: [], contextFiles: [] };
  }
}

/**
 * Builds the prompt-size, bootstrap-file, skill, and tool-schema accounting
 * report for a Codex run.
 */
export function buildCodexSystemPromptReport(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionKey: string;
  workspaceDir: string;
  developerInstructions: string;
  workspaceBootstrapContext: CodexWorkspaceBootstrapContext;
  skillsPrompt: string;
  tools: CodexDynamicToolSpec[];
}): CodexSystemPromptReport {
  const toolEntries = flattenCodexDynamicToolFunctions(params.tools).map(buildCodexToolReportEntry);
  const schemaChars = toolEntries.reduce((sum, tool) => sum + tool.schemaChars, 0);
  const skillsPrompt = params.skillsPrompt.trim();
  const bootstrapMaxChars = readPositiveNumber(
    params.attempt.config?.agents?.defaults?.bootstrapMaxChars,
  );
  const bootstrapTotalMaxChars = readPositiveNumber(
    params.attempt.config?.agents?.defaults?.bootstrapTotalMaxChars,
  );
  return {
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.attempt.sessionId,
    sessionKey: params.sessionKey,
    provider: params.attempt.provider,
    model: params.attempt.modelId,
    workspaceDir: params.workspaceDir,
    ...(bootstrapMaxChars ? { bootstrapMaxChars } : {}),
    ...(bootstrapTotalMaxChars ? { bootstrapTotalMaxChars } : {}),
    systemPrompt: {
      chars: params.developerInstructions.length,
      projectContextChars: 0,
      nonProjectContextChars: params.developerInstructions.length,
      hash: sha256Text(params.developerInstructions),
    },
    injectedWorkspaceFiles: buildCodexBootstrapInjectionStats({
      bootstrapFiles: params.workspaceBootstrapContext.bootstrapFiles,
      injectedFiles: params.workspaceBootstrapContext.promptContextFiles ?? [],
      developerInstructionFiles: [
        ...(params.workspaceBootstrapContext.developerInstructionFiles ?? []),
        ...(params.workspaceBootstrapContext.turnScopedDeveloperInstructionFiles ?? []),
      ],
      memoryToolRoutedBootstrapFiles:
        params.workspaceBootstrapContext.memoryToolRoutedBootstrapFiles ?? [],
      memoryToolRouted: params.workspaceBootstrapContext.memoryToolRouted === true,
    }),
    skills: {
      promptChars: skillsPrompt.length,
      hash: sha256Text(skillsPrompt),
      entries: buildCodexSkillReportEntries(skillsPrompt),
    },
    tools: {
      listChars: 0,
      schemaChars,
      entries: toolEntries,
    },
  };
}

function buildCodexSkillReportEntries(
  skillsPrompt: string,
): CodexSystemPromptReport["skills"]["entries"] {
  if (!skillsPrompt) {
    return [];
  }
  return Array.from(skillsPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi))
    .map((match) => match[0] ?? "")
    .map((block) => ({
      name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)",
      blockChars: block.length,
    }))
    .filter((entry) => entry.blockChars > 0);
}

function buildCodexToolReportEntry(tool: CodexDynamicToolFunctionSpec): CodexToolReportEntry {
  const summary = tool.description.trim();
  if (tool.deferLoading === true) {
    return {
      name: tool.name,
      summaryChars: summary.length,
      summaryHash: sha256Text(summary),
      schemaChars: 0,
      schemaHash: stableJsonHash(null),
      propertiesCount: null,
    };
  }
  return {
    name: tool.name,
    summaryChars: summary.length,
    summaryHash: sha256Text(summary),
    ...buildCodexToolSchemaStats(tool.inputSchema),
  };
}

function buildCodexToolSchemaStats(
  schema: JsonValue,
): Pick<CodexToolReportEntry, "schemaChars" | "schemaHash" | "propertiesCount"> {
  const schemaChars = (() => {
    try {
      return JSON.stringify(schema).length;
    } catch {
      return 0;
    }
  })();
  const properties =
    isJsonObject(schema) && isJsonObject(schema.properties) ? schema.properties : null;
  return {
    schemaChars,
    schemaHash: stableJsonHash(schema),
    propertiesCount: properties ? Object.keys(properties).length : null,
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

function stableJsonHash(value: JsonValue): string {
  return sha256Text(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

function buildCodexBootstrapInjectionStats(params: {
  bootstrapFiles: CodexBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  developerInstructionFiles?: EmbeddedContextFile[];
  memoryToolRoutedBootstrapFiles?: CodexBootstrapFile[];
  memoryToolRouted?: boolean;
}): CodexSystemPromptReport["injectedWorkspaceFiles"] {
  const injectedIndex = indexCodexContextFileContent(params.injectedFiles);
  const developerInstructionIndex = indexCodexContextFileContent(
    params.developerInstructionFiles ?? [],
  );
  const memoryToolRoutedPaths = new Set(
    (params.memoryToolRoutedBootstrapFiles ?? [])
      .map((file) => readNonEmptyString(file.path))
      .filter(isNonEmptyString)
      .map(normalizeCodexContextFilePath),
  );
  return params.bootstrapFiles.map((file) => {
    const fileName = readNonEmptyString(file.name);
    const pathValue = readNonEmptyString(file.path) ?? fileName ?? "";
    const displayName = (fileName ?? getCodexContextFileDisplayBasename(pathValue)) || pathValue;
    const baseName = getCodexContextFileBasename(pathValue || fileName || "");
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const memoryToolRoutedFile =
      baseName === CODEX_MEMORY_CONTEXT_BASENAME &&
      params.memoryToolRouted === true &&
      memoryToolRoutedPaths.has(normalizeCodexContextFilePath(pathValue));
    const injected = memoryToolRoutedFile
      ? undefined
      : (readCodexIndexedContextFileContent(injectedIndex, pathValue, fileName) ??
        readCodexIndexedContextFileContent(developerInstructionIndex, pathValue, fileName));
    let injectedChars = memoryToolRoutedFile ? 0 : (injected?.length ?? 0);
    let truncated = memoryToolRoutedFile ? false : !file.missing && injectedChars < rawChars;
    if (injected === undefined) {
      if (CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName)) {
        injectedChars = rawChars;
        truncated = false;
      } else if (baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME) {
        injectedChars = 0;
        truncated = false;
      }
    }
    return {
      name: displayName,
      path: pathValue,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

function indexCodexContextFileContent(files: EmbeddedContextFile[]): {
  byPath: Map<string, string>;
  byBaseName: Map<string, string>;
} {
  const byPath = new Map<string, string>();
  const byBaseName = new Map<string, string>();
  for (const file of files) {
    const pathValue = readNonEmptyString(file.path);
    if (!pathValue) {
      continue;
    }
    if (!byPath.has(pathValue)) {
      byPath.set(pathValue, file.content);
    }
    const baseName = getCodexContextFileBasename(pathValue);
    if (baseName && !byBaseName.has(baseName)) {
      byBaseName.set(baseName, file.content);
    }
  }
  return { byPath, byBaseName };
}

function readCodexIndexedContextFileContent(
  index: { byPath: Map<string, string>; byBaseName: Map<string, string> },
  pathValue: string,
  fileName: string | undefined,
): string | undefined {
  const pathContent = index.byPath.get(pathValue);
  if (pathContent !== undefined) {
    return pathContent;
  }
  if (fileName) {
    const nameContent = index.byPath.get(fileName);
    if (nameContent !== undefined) {
      return nameContent;
    }
  }
  const baseName = getCodexContextFileBasename(fileName ?? pathValue);
  return baseName ? index.byBaseName.get(baseName) : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Builds OpenClaw-provided workspace prompt context for the current Codex turn.
 */
export function buildCodexOpenClawPromptContext(params: {
  params: EmbeddedRunAttemptParams;
  workspacePromptContext?: string;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.params)) {
    return undefined;
  }
  const sections = [
    params.workspacePromptContext?.trim()
      ? ["## OpenClaw Workspace Context", "", params.workspacePromptContext.trim()].join("\n")
      : undefined,
  ].filter(isNonEmptyString);
  if (sections.length === 0) {
    return undefined;
  }
  return [
    "OpenClaw runtime context for this turn:",
    "Treat this OpenClaw-provided context as supporting project/user reference for the current request.",
    "",
    ...sections,
  ].join("\n");
}

function shouldInjectCodexOpenClawPromptContext(params: EmbeddedRunAttemptParams): boolean {
  // Lightweight cron runs are commonly exact commands. Keep the user input byte-for-byte
  // to avoid changing command intent while Codex keeps its native project-doc loader.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

/** Renders loaded OpenClaw skill prompts as Codex collaboration instructions. */
export function renderCodexSkillsCollaborationInstructions(params: {
  attempt: EmbeddedRunAttemptParams;
  skillsPrompt?: string;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.attempt)) {
    return undefined;
  }
  return params.skillsPrompt?.trim()
    ? ["## OpenClaw Skills", "", params.skillsPrompt.trim()].join("\n")
    : undefined;
}

/**
 * Prepends OpenClaw context while preserving leading delivery metadata as
 * routing guidance instead of user request text.
 */
export function prependCodexOpenClawPromptContext(
  prompt: string,
  context: string | undefined,
  options: { preservePromptWithoutContext?: boolean } = {},
): string {
  const { deliveryHint, prompt: promptWithoutDeliveryHint } = splitLeadingCodexDeliveryHint(prompt);
  if (!context?.trim() && (!deliveryHint || options.preservePromptWithoutContext)) {
    return prompt;
  }
  const promptSection = promptWithoutDeliveryHint.startsWith(
    "OpenClaw assembled context for this turn:",
  )
    ? promptWithoutDeliveryHint
    : ["Current user request:", promptWithoutDeliveryHint].join("\n");
  const deliverySection = deliveryHint
    ? [
        "OpenClaw delivery metadata:",
        "This delivery metadata is runtime routing guidance, not the user's request.",
        deliveryHint,
      ].join("\n")
    : undefined;
  return [context?.trim(), deliverySection, promptSection].filter(Boolean).join("\n\n");
}

/**
 * Maps the surviving user-request portion of an input range after delivery
 * metadata has been relocated before the request.
 */
export function resolveCodexDeliveryHintPreservedInputRange(params: {
  prompt: string;
  promptInputRange: { start: number; end: number } | undefined;
  decoratedPrompt: string;
}): { start: number; end: number } | undefined {
  const { prompt, promptInputRange, decoratedPrompt } = params;
  const { deliveryHint, prompt: promptWithoutDeliveryHint } = splitLeadingCodexDeliveryHint(prompt);
  if (
    !deliveryHint ||
    !promptInputRange ||
    promptInputRange.start < 0 ||
    promptInputRange.end < promptInputRange.start ||
    promptInputRange.end > prompt.length ||
    !decoratedPrompt.endsWith(promptWithoutDeliveryHint)
  ) {
    return undefined;
  }
  const promptWithoutDeliveryHintStart = prompt.length - promptWithoutDeliveryHint.length;
  const inputStart = Math.max(promptInputRange.start, promptWithoutDeliveryHintStart);
  const inputEnd = Math.max(
    inputStart,
    Math.min(
      promptInputRange.end,
      promptWithoutDeliveryHint.length + promptWithoutDeliveryHintStart,
    ),
  );
  const decoratedPromptSuffixStart = decoratedPrompt.length - promptWithoutDeliveryHint.length;
  const requestHeader = "Current user request:\n";
  const requestHeaderStart = decoratedPromptSuffixStart - requestHeader.length;
  // Delivery metadata moves outside the request, so retain the remaining input
  // span rather than treating the original, now non-contiguous range as valid.
  return {
    start:
      inputStart === promptWithoutDeliveryHintStart &&
      decoratedPrompt.slice(requestHeaderStart, decoratedPromptSuffixStart) === requestHeader
        ? requestHeaderStart
        : decoratedPromptSuffixStart + inputStart - promptWithoutDeliveryHintStart,
    end: decoratedPromptSuffixStart + inputEnd - promptWithoutDeliveryHintStart,
  };
}

function splitLeadingCodexDeliveryHint(prompt: string): {
  deliveryHint?: string;
  prompt: string;
} {
  const trimmedStart = prompt.trimStart();
  const matchedHint = MESSAGE_TOOL_DELIVERY_HINTS.find((hint) => trimmedStart.startsWith(hint));
  if (!matchedHint) {
    return { prompt };
  }
  // Delivery hints are runtime routing metadata; split them before wrapping the
  // user prompt so Codex does not treat delivery policy as the request itself.
  const remainder = trimmedStart
    .slice(matchedHint.length)
    .replace(/^\s*\n/, "")
    .trimStart();
  return { deliveryHint: matchedHint, prompt: remainder };
}

function renderCodexWorkspaceBootstrapPromptContext(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  const files = contextFiles;
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "OpenClaw loaded these user-editable workspace files for the current turn. Codex loads AGENTS.md natively. TOOLS.md is provided as inherited Codex developer instructions. SOUL.md, IDENTITY.md, and USER.md are provided as turn-scoped collaboration instructions so native Codex subagents do not inherit them. HEARTBEAT.md is handled by heartbeat collaboration-mode guidance. Those files are not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspacePromptContextFiles(
  contextFiles: EmbeddedContextFile[],
  options: { excludeMemory?: boolean; memoryWorkspaceDir?: string } = {},
): EmbeddedContextFile[] {
  const excludeMemory = options.excludeMemory ?? true;
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName) &&
        !CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) &&
        baseName !== CODEX_HEARTBEAT_CONTEXT_BASENAME &&
        (!excludeMemory ||
          !isCodexWorkspaceRootMemoryContextFile({
            file,
            workspaceDir: options.memoryWorkspaceDir,
          })) &&
        !isMissingCodexBootstrapContextFile(file)
      );
    })
    .toSorted(compareCodexContextFiles);
}

function selectCodexWorkspaceInheritedDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return selectCodexWorkspaceDeveloperInstructionFiles(
    contextFiles,
    CODEX_INHERITED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  );
}

function selectCodexWorkspaceTurnScopedDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return selectCodexWorkspaceDeveloperInstructionFiles(
    contextFiles,
    CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  );
}

function selectCodexWorkspaceDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
  basenames: ReadonlySet<string>,
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        basenames.has(baseName) &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceThreadDeveloperInstructions(
  files: EmbeddedContextFile[],
): string | undefined {
  return renderCodexWorkspaceDeveloperInstructions({
    files,
    header: "## OpenClaw Workspace Instructions",
    preamble:
      "OpenClaw loaded these workspace instruction files from the active agent workspace. Internalize and follow them accordingly.",
  });
}

function renderCodexWorkspaceCollaborationDeveloperInstructions(
  files: EmbeddedContextFile[],
): string | undefined {
  return renderCodexWorkspaceDeveloperInstructions({
    files,
    header: "## OpenClaw Agent Soul",
    preamble:
      "OpenClaw loaded these workspace instruction files from the active agent workspace. They are the canonical definitions of who you are, how you think and work, and the human you work alongside. Internalize and follow them accordingly.",
    wrapperTag: "AGENT_SOUL",
  });
}

function renderCodexWorkspaceDeveloperInstructions(params: {
  files: EmbeddedContextFile[];
  header: string;
  preamble: string;
  wrapperTag?: string;
}): string | undefined {
  const { files, header, preamble, wrapperTag } = params;
  if (files.length === 0) {
    return undefined;
  }
  const lines = [header, "", preamble, ""];
  if (wrapperTag) {
    lines.push(`<${wrapperTag}>`, "");
  }
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  if (wrapperTag) {
    lines.push(`</${wrapperTag}>`);
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspaceHeartbeatReferenceFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceHeartbeatReference(files: EmbeddedContextFile[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "## OpenClaw Heartbeat Workspace",
    "",
    "HEARTBEAT.md exists in the active agent workspace. Read it before proceeding with this heartbeat, then decide what action is appropriate.",
    "",
  ];
  for (const file of files) {
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspaceMemoryReferenceFiles(params: {
  bootstrapFiles: CodexBootstrapFile[];
  workspaceDir: string;
}): CodexBootstrapFile[] {
  return params.bootstrapFiles
    .filter((file) => {
      return (
        isCodexWorkspaceRootMemoryBootstrapFile({
          file,
          workspaceDir: params.workspaceDir,
        }) &&
        !file.missing &&
        (file.content ?? "").trim().length > 0
      );
    })
    .toSorted(compareCodexBootstrapFiles);
}

/**
 * Renders a memory-file reference that points Codex at memory tools instead of
 * embedding MEMORY.md contents.
 */
export function renderCodexWorkspaceMemoryReference(params: {
  files: EmbeddedContextFile[];
  toolNames?: readonly string[];
}): string | undefined {
  if (params.files.length === 0) {
    return undefined;
  }
  const toolNames = params.toolNames?.length
    ? params.toolNames
    : Array.from(CODEX_MEMORY_TOOL_NAMES);
  const lines = [
    "## OpenClaw Workspace Memory",
    "",
    `MEMORY.md exists in the active agent workspace as a memory file, not an instruction file. OpenClaw does not paste its contents into native Codex turns; use ${toolNames.join(" or ")} when durable memory is relevant and the tools are available.`,
    "",
  ];
  for (const file of params.files) {
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n").trim();
}

function renderCodexWorkspaceMemoryCollaborationInstructions(params: {
  files: EmbeddedContextFile[];
  toolNames: readonly string[];
  memoryToolRouted: boolean;
  citationsMode?: Parameters<typeof buildMemorySystemPromptAddition>[0]["citationsMode"];
  agentId?: string;
  agentSessionKey?: string;
}): string | undefined {
  const memoryRecallInstructions = params.memoryToolRouted
    ? renderCodexMemoryRecallInstructions({
        toolNames: params.toolNames,
        citationsMode: params.citationsMode,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
      })
    : undefined;
  const memoryReferenceInstructions = renderCodexWorkspaceMemoryReference({
    files: params.files,
    toolNames: params.toolNames,
  });
  const sections = [memoryRecallInstructions, memoryReferenceInstructions].filter(isNonEmptyString);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function renderCodexMemoryRecallInstructions(params: {
  toolNames: readonly string[];
  citationsMode?: Parameters<typeof buildMemorySystemPromptAddition>[0]["citationsMode"];
  agentId?: string;
  agentSessionKey?: string;
}): string | undefined {
  const availableTools = new Set(params.toolNames);
  const memoryPrompt = buildMemorySystemPromptAddition({
    availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
  });
  if (!memoryPrompt) {
    // Memory recall policy belongs to the active memory plugin.
    // Codex-side fallback text can mask plugin lifecycle bugs or misdescribe third-party memory tools.
    return undefined;
  }
  const toolSearchBridge = renderCodexMemoryToolSearchBridge(params.toolNames);
  return [memoryPrompt, toolSearchBridge].filter(isNonEmptyString).join("\n").trim();
}

function renderCodexMemoryToolSearchBridge(toolNames: readonly string[]): string | undefined {
  const memoryToolNames = toolNames
    .map((name) => normalizeCodexDynamicToolName(name))
    .filter((name) => CODEX_MEMORY_TOOL_NAMES.has(name))
    .toSorted();
  if (memoryToolNames.length === 0) {
    return undefined;
  }
  return `Codex may expose ${memoryToolNames.join(" and ")} as deferred tools. When the memory guidance above calls for memory recall, use an already-loaded memory tool directly. If the needed memory tool is deferred and not currently callable, use \`tool_search\` to load it, then call that memory tool.`;
}

/** Lists available memory tool names understood by Codex workspace memory routing. */
export function getCodexWorkspaceMemoryToolNames(tools: readonly CodexDynamicToolSpec[]): string[] {
  const availableToolNames = new Set(
    flattenCodexDynamicToolFunctions(tools).map((tool) => normalizeCodexDynamicToolName(tool.name)),
  );
  return Array.from(CODEX_MEMORY_TOOL_NAMES).filter((name) => availableToolNames.has(name));
}

function canRouteCodexWorkspaceMemoryThroughTools(params: {
  config: EmbeddedRunAttemptParams["config"] | undefined;
  agentId: string;
  workspaceDir: string;
}): boolean {
  if (!params.config) {
    return false;
  }
  return isSameCodexWorkspacePath(
    resolveAgentWorkspaceDir(params.config, params.agentId),
    params.workspaceDir,
  );
}

function isMissingCodexBootstrapContextFile(file: EmbeddedContextFile): boolean {
  return file.content.trimStart().startsWith("[MISSING] Expected at:");
}

function toCodexEmbeddedContextFile(file: CodexBootstrapFile): EmbeddedContextFile {
  return {
    path: readNonEmptyString(file.path) ?? readNonEmptyString(file.name) ?? "",
    content: file.content ?? "",
  };
}

function isCodexWorkspaceRootMemoryBootstrapFile(params: {
  file: CodexBootstrapFile;
  workspaceDir: string;
}): boolean {
  return isCodexWorkspaceRootMemoryPath({
    filePath: readNonEmptyString(params.file.path) ?? readNonEmptyString(params.file.name) ?? "",
    workspaceDir: params.workspaceDir,
  });
}

function isCodexWorkspaceRootMemoryContextFile(params: {
  file: EmbeddedContextFile;
  workspaceDir?: string;
}): boolean {
  if (!params.workspaceDir) {
    return false;
  }
  return isCodexWorkspaceRootMemoryPath({
    filePath: params.file.path,
    workspaceDir: params.workspaceDir,
  });
}

function isCodexWorkspaceRootMemoryPath(params: {
  filePath: string;
  workspaceDir: string;
}): boolean {
  const filePath = params.filePath.trim();
  if (!filePath) {
    return false;
  }
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(params.workspaceDir, filePath);
  return absolutePath === path.join(path.resolve(params.workspaceDir), "MEMORY.md");
}

function isSameCodexWorkspacePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Remaps bootstrap file paths from the resolved workspace to the effective Codex
 * workspace while preserving platform path separators.
 */
export function remapCodexContextFilePath(params: {
  file: EmbeddedContextFile;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile {
  const relativePath = path.relative(params.sourceWorkspaceDir, params.file.path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    params.sourceWorkspaceDir === params.targetWorkspaceDir
  ) {
    return params.file;
  }
  const targetUsesPosixSeparators =
    params.targetWorkspaceDir.includes("/") && !params.targetWorkspaceDir.includes("\\");
  const normalizedRelativePath = targetUsesPosixSeparators
    ? relativePath.replaceAll("\\", "/")
    : relativePath.replaceAll("/", "\\");
  return {
    ...params.file,
    path: targetUsesPosixSeparators
      ? path.posix.join(params.targetWorkspaceDir, normalizedRelativePath)
      : path.win32.join(params.targetWorkspaceDir, normalizedRelativePath),
  };
}

function compareCodexContextFiles(left: EmbeddedContextFile, right: EmbeddedContextFile): number {
  const leftPath = normalizeCodexContextFilePath(left.path);
  const rightPath = normalizeCodexContextFilePath(right.path);
  const leftBase = getCodexContextFileBasename(left.path);
  const rightBase = getCodexContextFileBasename(right.path);
  const leftOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftBase !== rightBase) {
    return leftBase.localeCompare(rightBase);
  }
  return leftPath.localeCompare(rightPath);
}

function compareCodexBootstrapFiles(left: CodexBootstrapFile, right: CodexBootstrapFile): number {
  return compareCodexContextFiles(
    toCodexEmbeddedContextFile(left),
    toCodexEmbeddedContextFile(right),
  );
}

function normalizeCodexContextFilePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase();
}

function getCodexContextFileDisplayBasename(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
}

function getCodexContextFileBasename(filePath: string): string {
  return normalizeCodexContextFilePath(filePath).split("/").pop() ?? "";
}

function normalizeCodexDynamicToolName(name: string): string {
  return name.trim().toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
