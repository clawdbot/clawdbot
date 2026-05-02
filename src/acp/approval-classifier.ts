import { homedir } from "node:os";
import path from "node:path";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { isMutatingToolCall } from "../agents/tool-mutation.js";
import { resolveOwnerOnlyToolApprovalClass } from "../agents/tool-policy.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { asRecord } from "./record-shared.js";

const SAFE_SEARCH_TOOL_IDS = new Set(["search", "web_search", "memory_search"]);
const TRUSTED_SAFE_TOOL_ALIASES = new Set(["search"]);
const EXEC_CAPABLE_TOOL_IDS = new Set([
  "exec",
  "spawn",
  "shell",
  "bash",
  "process",
  "code_execution",
]);
const CONTROL_PLANE_TOOL_IDS = new Set(["sessions_spawn", "sessions_send", "session_status"]);

export type AcpApprovalClass =
  | "readonly_scoped"
  | "readonly_search"
  | "mutating"
  | "exec_capable"
  | "control_plane"
  | "interactive"
  | "other"
  | "unknown";

type AcpApprovalClassification = {
  toolName?: string;
  approvalClass: AcpApprovalClass;
  autoApprove: boolean;
};

function readFirstStringValue(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = normalizeOptionalString(source[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeToolName(value: string): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized || normalized.length > 128) {
    return undefined;
  }
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : undefined;
}

function parseToolNameFromTitle(title: string | undefined | null): string | undefined {
  if (!title) {
    return undefined;
  }
  const head = normalizeOptionalString(title.split(":", 1)[0]);
  return head ? normalizeToolName(head) : undefined;
}

function resolveToolNameForPermission(params: {
  toolCall?: {
    title?: string | null;
    _meta?: unknown;
    rawInput?: unknown;
  };
}): string | undefined {
  const toolCall = params.toolCall;
  const toolMeta = asRecord(toolCall?._meta);
  const rawInput = asRecord(toolCall?.rawInput);

  const fromMeta = readFirstStringValue(toolMeta, ["toolName", "tool_name", "name"]);
  const fromRawInput = readFirstStringValue(rawInput, ["tool", "toolName", "tool_name", "name"]);
  const fromTitle = parseToolNameFromTitle(toolCall?.title);
  const metaName = fromMeta ? normalizeToolName(fromMeta) : undefined;
  const rawInputName = fromRawInput ? normalizeToolName(fromRawInput) : undefined;
  const titleName = fromTitle;
  if ((fromMeta && !metaName) || (fromRawInput && !rawInputName)) {
    return undefined;
  }
  if (metaName && titleName && metaName !== titleName) {
    return undefined;
  }
  if (rawInputName && metaName && rawInputName !== metaName) {
    return undefined;
  }
  if (rawInputName && titleName && rawInputName !== titleName) {
    return undefined;
  }
  return metaName ?? titleName ?? rawInputName;
}

function extractPathFromToolTitle(
  toolTitle: string | undefined,
  toolName: string | undefined,
): string | undefined {
  if (!toolTitle) {
    return undefined;
  }
  const separator = toolTitle.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  const tail = toolTitle.slice(separator + 1).trim();
  if (!tail) {
    return undefined;
  }
  const keyedMatch = tail.match(/(?:^|,\s*)(?:path|file_path|filePath)\s*:\s*([^,]+)/);
  if (keyedMatch?.[1]) {
    return keyedMatch[1].trim();
  }
  return toolName === "read" ? tail : undefined;
}

function resolveToolPathCandidate(
  params: {
    toolCall?: { rawInput?: unknown };
  },
  toolName: string | undefined,
  toolTitle: string | undefined,
): string | undefined {
  const rawInput = asRecord(params.toolCall?.rawInput);
  return (
    readFirstStringValue(rawInput, ["path", "file_path", "filePath"]) ??
    extractPathFromToolTitle(toolTitle, toolName)
  );
}

function resolveAbsoluteScopedPath(value: string, cwd: string): string | undefined {
  let candidate = value.trim();
  if (!candidate) {
    return undefined;
  }
  if (candidate.startsWith("file://")) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname || "");
    } catch {
      return undefined;
    }
  }
  if (candidate === "~") {
    candidate = homedir();
  } else if (candidate.startsWith("~/")) {
    candidate = path.join(homedir(), candidate.slice(2));
  }
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
}

function isReadToolCallScopedToCwd(
  params: { toolCall?: { rawInput?: unknown } },
  toolName: string | undefined,
  toolTitle: string | undefined,
  cwd: string,
): boolean {
  if (toolName !== "read") {
    return false;
  }
  const rawPath = resolveToolPathCandidate(params, toolName, toolTitle);
  if (!rawPath) {
    return false;
  }
  const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
  if (!absolutePath) {
    return false;
  }
  const root = path.resolve(cwd);
  const relative = path.relative(root, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function classifyAcpToolApproval(params: {
  toolCall?: {
    title?: string | null;
    _meta?: unknown;
    rawInput?: unknown;
  };
  cwd: string;
}): AcpApprovalClassification {
  const toolName = resolveToolNameForPermission(params);
  if (!toolName) {
    return { toolName: undefined, approvalClass: "unknown", autoApprove: false };
  }

  const isTrustedToolId = isKnownCoreToolId(toolName) || TRUSTED_SAFE_TOOL_ALIASES.has(toolName);
  if (toolName === "read" && isTrustedToolId) {
    const autoApprove = isReadToolCallScopedToCwd(
      params,
      toolName,
      params.toolCall?.title ?? undefined,
      params.cwd,
    );
    return {
      toolName,
      approvalClass: autoApprove ? "readonly_scoped" : "other",
      autoApprove,
    };
  }
  if (SAFE_SEARCH_TOOL_IDS.has(toolName) && isTrustedToolId) {
    return { toolName, approvalClass: "readonly_search", autoApprove: true };
  }
  const ownerOnlyApprovalClass = resolveOwnerOnlyToolApprovalClass(toolName);
  if (ownerOnlyApprovalClass) {
    return { toolName, approvalClass: ownerOnlyApprovalClass, autoApprove: false };
  }
  if (EXEC_CAPABLE_TOOL_IDS.has(toolName)) {
    return { toolName, approvalClass: "exec_capable", autoApprove: false };
  }
  if (CONTROL_PLANE_TOOL_IDS.has(toolName)) {
    return { toolName, approvalClass: "control_plane", autoApprove: false };
  }
  if (isMutatingToolCall(toolName, params.toolCall?.rawInput)) {
    return { toolName, approvalClass: "mutating", autoApprove: false };
  }
  return { toolName, approvalClass: "other", autoApprove: false };
}
