import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function collectTranscriptWrites(params: {
  message: unknown;
  observedAt: number;
  workspaceDir: string;
  writes: Map<string, { relativePath: string; observedAt: number }>;
}): void {
  const message = asNullableRecord(params.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return;
  }
  for (const item of message.content) {
    const call = asNullableRecord(item);
    if (
      !call ||
      (call.type !== "toolCall" && call.type !== "tool_call" && call.type !== "tool_use") ||
      (call.name !== "apply_patch" && call.name !== "write" && call.name !== "edit")
    ) {
      continue;
    }
    let rawArguments = call.arguments ?? call.input;
    if (typeof rawArguments === "string") {
      try {
        rawArguments = JSON.parse(rawArguments) as unknown;
      } catch {
        rawArguments = call.name === "apply_patch" ? { input: rawArguments } : undefined;
      }
    }
    const args = asNullableRecord(rawArguments);
    if (!args) {
      continue;
    }
    const candidates = [args.path, args.file_path, args.filePath];
    if (call.name === "apply_patch") {
      const input = typeof args.input === "string" ? args.input : args.patch;
      if (typeof input === "string") {
        for (const match of input.matchAll(
          /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu,
        )) {
          candidates.push(match[1]);
        }
      }
      if (Array.isArray(args.changes)) {
        for (const change of args.changes) {
          const entry = asNullableRecord(change);
          if (entry) {
            candidates.push(entry.path, asNullableRecord(entry.kind)?.move_path);
          }
        }
      } else {
        candidates.push(...Object.keys(asNullableRecord(args.changes) ?? {}));
      }
    }
    const cwd = typeof args.cwd === "string" ? args.cwd : params.workspaceDir;
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) {
        continue;
      }
      const absolutePath = path.resolve(params.workspaceDir, cwd, candidate);
      if (!isPathInside(params.workspaceDir, absolutePath)) {
        continue;
      }
      const relativePath = path.relative(params.workspaceDir, absolutePath).replaceAll("\\", "/");
      if (
        (relativePath === "MEMORY.md" ||
          relativePath === "USER.md" ||
          relativePath.startsWith("memory/")) &&
        !params.writes.has(relativePath)
      ) {
        params.writes.set(relativePath, { relativePath, observedAt: params.observedAt });
      }
    }
  }
}
