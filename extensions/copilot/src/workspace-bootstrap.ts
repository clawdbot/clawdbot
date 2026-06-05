// Copilot plugin module implements workspace bootstrap behavior.
import path from "node:path";
import type {
  AgentHarnessAttemptParams,
  EmbeddedContextFile,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveBootstrapContextForRun,
  resolveUserPath,
} from "openclaw/plugin-sdk/agent-harness-runtime";

// Filenames the Copilot SDK already loads natively from the working
// directory / instructionDirectories (per
// `@github/copilot-sdk/dist/types.d.ts:1036,1155` —
// "custom instruction files (.github/copilot-instructions.md,
// AGENTS.md, etc.) are always loaded from the working directory").
// Filtering them out of the OpenClaw bootstrap injection avoids
// duplicating their content into `SessionConfig.systemMessage`, which
// would otherwise inflate every prompt with the same text the SDK
// already includes. Mirrors codex's CODEX_NATIVE_PROJECT_DOC_BASENAMES
// (extensions/codex/src/app-server/run-attempt.ts:160).
const COPILOT_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);

// Persona/identity files get sorted to the top of the rendered block
// so they precede the freer-form context like USER.md / MEMORY.md.
// Mirrors codex's CODEX_BOOTSTRAP_CONTEXT_ORDER ordering (same files).
const COPILOT_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["heartbeat.md", 30],
  ["bootstrap.md", 40],
  ["tools.md", 50],
  ["user.md", 60],
  ["memory.md", 70],
]);

export type CopilotWorkspaceBootstrapResult = {
  bootstrapFiles: Awaited<ReturnType<typeof resolveBootstrapContextForRun>>["bootstrapFiles"];
  contextFiles: EmbeddedContextFile[];
  instructions?: string;
};

/**
 * Loads OpenClaw workspace bootstrap files (IDENTITY.md, SOUL.md,
 * HEARTBEAT.md, USER.md, TOOLS.md, BOOTSTRAP.md, MEMORY.md, ...) using
 * the shared core helper PI and codex both use, then renders them as a
 * single string suitable for `SessionConfig.systemMessage.content` on
 * the Copilot SDK.
 *
 * Returns `instructions: undefined` when there are no relevant files
 * (after filtering out SDK-native docs) so the caller can omit the
 * `systemMessage` field entirely rather than passing an empty string.
 *
 * Mirrors codex's `buildCodexWorkspaceBootstrapContext` /
 * `renderCodexWorkspaceBootstrapInstructions` pair
 * (`extensions/codex/src/app-server/run-attempt.ts:2877,3047`). The
 * shape divergence — codex returns instructions inside the same object
 * as bootstrapFiles+contextFiles for its developerInstructions field;
 * copilot exposes the rendered string for SDK `systemMessage` — is the
 * intended difference between the two runtimes' system-prompt
 * surfaces.
 */
export async function resolveCopilotWorkspaceBootstrapContext(params: {
  attempt: AgentHarnessAttemptParams;
  /**
   * Sandbox-aware working directory the SDK session will run in.
   * When this differs from the canonical `attempt.workspaceDir`
   * (sandbox `ro` / `none` runs that redirect to a copy), bootstrap
   * context file paths are remapped so the rendered `systemMessage`
   * shows the model the same workspace the SDK's native loader and
   * bridged tools operate on. Pass `undefined` only when no sandbox
   * resolution has happened (e.g. tests not exercising sandbox
   * redirection). Required so future callers cannot silently miss
   * the remap. Mirrors PI's
   * `remapInjectedContextFilesToWorkspace` call in
   * `src/agents/pi-embedded-runner/run/attempt.ts:1595`.
   */
  effectiveWorkspaceDir: string | undefined;
  warn?: (message: string) => void;
}): Promise<CopilotWorkspaceBootstrapResult> {
  const { attempt } = params;
  const workspaceDir = readResolvedWorkspacePath(attempt.workspaceDir);
  if (!workspaceDir) {
    return { bootstrapFiles: [], contextFiles: [] };
  }
  try {
    const bootstrapContext = await resolveBootstrapContextForRun({
      workspaceDir,
      config: attempt.config,
      sessionKey: readNonEmptyString((attempt as { sessionKey?: unknown }).sessionKey),
      sessionId: readNonEmptyString(attempt.sessionId),
      agentId: readNonEmptyString(attempt.agentId),
      warn: params.warn,
      contextMode: attempt.bootstrapContextMode,
      runKind: attempt.bootstrapContextRunKind,
    });
    // Remap context-file paths from the workspace we LOADED them
    // from (`workspaceDir`, the canonical host workspace where
    // SOUL.md / IDENTITY.md / .openclaw conventions live) onto the
    // workspace the SDK session will actually OPERATE in
    // (`effectiveWorkspaceDir`). When the two are identical (no
    // sandbox, or sandbox `rw`), remap is a no-op. The render below
    // and the returned `contextFiles` use the remapped array so the
    // model never sees a host path while its native loader and
    // bridged tools see only the sandbox copy.
    const contextFiles = remapCopilotBootstrapContextFiles({
      files: bootstrapContext.contextFiles,
      sourceWorkspaceDir: workspaceDir,
      targetWorkspaceDir: readResolvedWorkspacePath(params.effectiveWorkspaceDir) ?? workspaceDir,
    });
    return {
      bootstrapFiles: bootstrapContext.bootstrapFiles,
      contextFiles,
      instructions: renderCopilotWorkspaceBootstrapInstructions(contextFiles),
    };
  } catch (error) {
    params.warn?.(
      `[copilot-attempt] failed to load workspace bootstrap instructions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { bootstrapFiles: [], contextFiles: [] };
  }
}

/**
 * Rewrites context-file paths from a source workspace root to a
 * target workspace root, mirroring PI's
 * `remapInjectedContextFilesToWorkspace`
 * (`src/agents/pi-embedded-runner/run/attempt.ts:603`). Files whose
 * resolved relative path escapes the source workspace (parent
 * traversal or absolute) are left untouched so we never pretend a
 * file lives inside the sandbox when it does not. Exported for unit
 * tests; intentionally local to the Copilot extension (codex keeps
 * similar helpers extension-local rather than importing from PI).
 */
export function remapCopilotBootstrapContextFiles(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    if (!isRelativePathInsideOrEqual(relative)) {
      return file;
    }
    return {
      ...file,
      path:
        relative === ""
          ? params.targetWorkspaceDir
          : path.join(params.targetWorkspaceDir, relative),
    };
  });
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Renders bootstrap context files into a single string for
 * `SessionConfig.systemMessage.content` (append mode). Returns
 * `undefined` when no relevant files remain after filtering, so the
 * caller can skip setting `systemMessage` altogether.
 *
 * Files whose basename matches a doc the Copilot SDK already loads
 * natively (see {@link COPILOT_NATIVE_PROJECT_DOC_BASENAMES}) are
 * dropped to avoid duplication with SDK-managed sections.
 */
export function renderCopilotWorkspaceBootstrapInstructions(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  const files = contextFiles
    .filter((file) => {
      const baseName = getCopilotContextFileBasename(file.path);
      return baseName.length > 0 && !COPILOT_NATIVE_PROJECT_DOC_BASENAMES.has(baseName);
    })
    .toSorted(compareCopilotContextFiles);
  if (files.length === 0) {
    return undefined;
  }
  const hasSoulFile = files.some((file) => getCopilotContextFileBasename(file.path) === "soul.md");
  const lines: string[] = [
    "OpenClaw loaded these user-editable workspace files. Treat them as project/user context. The Copilot SDK loads AGENTS.md natively from its instruction directories, so AGENTS.md is not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  if (hasSoulFile) {
    lines.push("SOUL.md: persona/tone. Follow it unless higher-priority instructions override.");
  }
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function compareCopilotContextFiles(left: EmbeddedContextFile, right: EmbeddedContextFile): number {
  const leftBase = getCopilotContextFileBasename(left.path);
  const rightBase = getCopilotContextFileBasename(right.path);
  const leftOrder = COPILOT_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = COPILOT_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const leftPath = normalizeCopilotContextFilePath(left.path);
  const rightPath = normalizeCopilotContextFilePath(right.path);
  if (leftPath < rightPath) {
    return -1;
  }
  if (leftPath > rightPath) {
    return 1;
  }
  return 0;
}

function normalizeCopilotContextFilePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase();
}

function getCopilotContextFileBasename(filePath: string): string {
  return normalizeCopilotContextFilePath(filePath).split("/").pop() ?? "";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readResolvedWorkspacePath(value: unknown): string | undefined {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return undefined;
  }
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return raw.trim();
  }
  return resolveUserPath(raw);
}

export const TESTING_EXPORTS = {
  COPILOT_NATIVE_PROJECT_DOC_BASENAMES,
  COPILOT_BOOTSTRAP_CONTEXT_ORDER,
  compareCopilotContextFiles,
  getCopilotContextFileBasename,
};
