import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type FileMutationToolName = "write" | "edit" | "apply_patch";

const FILE_MUTATION_TOOL_NAMES = new Set<FileMutationToolName>(["write", "edit", "apply_patch"]);

export function resolveFileMutationToolName(toolName: string): FileMutationToolName | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  return FILE_MUTATION_TOOL_NAMES.has(normalized as FileMutationToolName)
    ? (normalized as FileMutationToolName)
    : undefined;
}
