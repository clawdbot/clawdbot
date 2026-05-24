import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath, truncateUtf16Safe } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import { resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { buildBootstrapContextFiles } from "./pi-embedded-helpers.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
} from "./workspace.js";

export const REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES = [
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_SOUL_FILENAME,
] as const;

export type RealtimeBootstrapContextFileName =
  (typeof REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES)[number];

const REALTIME_BOOTSTRAP_CONTEXT_FILE_NAME_SET: ReadonlySet<string> = new Set(
  REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES,
);
const DEFAULT_REALTIME_BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000;
const REALTIME_BOOTSTRAP_CONTEXT_TITLE = "OpenClaw realtime voice profile context:";
const REALTIME_BOOTSTRAP_CONTEXT_GUIDANCE =
  "Use these profile files for identity, persona, and user grounding; do not mention them unless asked.";

function isRealtimeBootstrapContextFileName(
  value: string,
): value is RealtimeBootstrapContextFileName {
  return REALTIME_BOOTSTRAP_CONTEXT_FILE_NAME_SET.has(value);
}

function formatRealtimeBootstrapContextFileName(pathValue: string): string {
  return path.basename(pathValue.trim().replace(/\\/g, "/"));
}

function resolveRealtimeBootstrapContextContentBudget(params: {
  preamble: string;
  fileNames: readonly string[];
  totalMaxChars: number;
}): number {
  const separatorChars = "\n\n".length * params.fileNames.length;
  const headingChars = params.fileNames.reduce(
    (total, fileName) => total + `### ${fileName}\n`.length,
    0,
  );
  return params.totalMaxChars - params.preamble.length - separatorChars - headingChars;
}

function normalizeRealtimeBootstrapContextFileNames(
  files: readonly string[],
  warn?: (message: string) => void,
): RealtimeBootstrapContextFileName[] {
  const normalized: RealtimeBootstrapContextFileName[] = [];
  for (const fileName of files) {
    if (isRealtimeBootstrapContextFileName(fileName)) {
      normalized.push(fileName);
      continue;
    }
    warn?.(`skipping unsupported realtime bootstrap context file "${fileName}"`);
  }
  return normalized;
}

export async function resolveRealtimeBootstrapContextInstructions(params: {
  agentId: string;
  config: OpenClawConfig;
  files?: readonly RealtimeBootstrapContextFileName[];
  sessionKey?: string;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  const requestedFiles = normalizeRealtimeBootstrapContextFileNames(
    params.files ?? REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES,
    params.warn,
  );
  if (requestedFiles.length === 0) {
    return undefined;
  }
  const requestedOrder = new Map(requestedFiles.map((fileName, index) => [fileName, index]));
  const workspaceDir = resolveUserPath(resolveAgentWorkspaceDir(params.config, params.agentId));
  const bootstrapFiles = await resolveBootstrapFilesForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    warn: params.warn,
  });
  const selectedFiles = bootstrapFiles
    .filter(
      (file) =>
        !file.missing &&
        isRealtimeBootstrapContextFileName(file.name) &&
        requestedOrder.has(file.name),
    )
    .toSorted((left, right) => {
      const leftOrder = isRealtimeBootstrapContextFileName(left.name)
        ? (requestedOrder.get(left.name) ?? 0)
        : 0;
      const rightOrder = isRealtimeBootstrapContextFileName(right.name)
        ? (requestedOrder.get(right.name) ?? 0)
        : 0;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.path.localeCompare(right.path);
    });
  if (selectedFiles.length === 0) {
    return undefined;
  }

  const totalMaxChars = DEFAULT_REALTIME_BOOTSTRAP_CONTEXT_MAX_CHARS;
  const preamble = [REALTIME_BOOTSTRAP_CONTEXT_TITLE, REALTIME_BOOTSTRAP_CONTEXT_GUIDANCE].join(
    "\n",
  );
  const fileNames = selectedFiles.map((file) => formatRealtimeBootstrapContextFileName(file.path));
  const contentBudget = resolveRealtimeBootstrapContextContentBudget({
    preamble,
    fileNames,
    totalMaxChars,
  });
  if (contentBudget <= 0) {
    params.warn?.(
      `realtime bootstrap context budget is too small to include selected profile files (limit ${totalMaxChars})`,
    );
    return undefined;
  }
  const perFileMaxChars = Math.max(1, Math.floor(contentBudget / selectedFiles.length));
  const contextFiles = buildBootstrapContextFiles(selectedFiles, {
    maxChars: perFileMaxChars,
    totalMaxChars: contentBudget,
    warn: params.warn,
  });
  if (contextFiles.length === 0) {
    return undefined;
  }

  const instructions = [
    preamble,
    ...contextFiles.map(
      (file) =>
        `### ${formatRealtimeBootstrapContextFileName(file.path)}\n${file.content.trimEnd()}`,
    ),
  ].join("\n\n");
  return instructions.length <= totalMaxChars
    ? instructions
    : truncateUtf16Safe(instructions, totalMaxChars);
}
