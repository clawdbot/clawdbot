import path from "node:path";
import { recordRunSkillUsage } from "../skills/runtime/run-usage.js";
import type { ExplicitSkillSelection, SkillSnapshot, SkillUsagePath } from "../skills/types.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import { canonicalizePath } from "./utils/paths.js";

function comparableSkillPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    return undefined;
  }
  const resolved = canonicalizePath(path.resolve(trimmed));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function indexUnambiguousSkillCommands(
  paths: readonly SkillUsagePath[],
): Map<string, SkillUsagePath> {
  const commandsByPath = new Map<string, SkillUsagePath>();
  const ambiguousPaths = new Set<string>();
  for (const command of paths) {
    const selectionPath = comparableSkillPath(command.readPath);
    if (!selectionPath) {
      continue;
    }
    if (commandsByPath.has(selectionPath)) {
      commandsByPath.delete(selectionPath);
      ambiguousPaths.add(selectionPath);
      continue;
    }
    if (!ambiguousPaths.has(selectionPath)) {
      commandsByPath.set(selectionPath, command);
    }
  }
  return commandsByPath;
}

/** Records core-resolved explicit skill commands against the admitted run. */
export function recordExplicitSkillSelectionsForRun(params: {
  operationalRunInstance?: OperationalRunInstanceRef;
  selections?: readonly ExplicitSkillSelection[];
  skillsSnapshot?: SkillSnapshot;
}): void {
  if (!params.operationalRunInstance || !params.selections?.length) {
    return;
  }
  const skillsByPath = indexUnambiguousSkillCommands(
    params.skillsSnapshot?.skillCommandUsagePaths ?? [],
  );
  for (const selection of params.selections) {
    const selectedPath = comparableSkillPath(selection.path);
    const command = selectedPath ? skillsByPath.get(selectedPath) : undefined;
    if (!command) {
      continue;
    }
    recordRunSkillUsage({
      operationalRunInstance: params.operationalRunInstance,
      name: command.skillName,
      source: command.skillSource,
      activation: "command",
      skillFile: command.skillFile,
    });
  }
}
