import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  exportTrajectoryBundle,
  resolveDefaultTrajectoryExportDir,
} from "../../trajectory/export.js";
import type { ReplyPayload } from "../types.js";
import {
  isReplyPayload,
  parseExportCommandOutputPath,
  resolveExportCommandSessionTarget,
} from "./commands-export-common.js";
import type { HandleCommandsParams } from "./commands-types.js";

function isPathInsideOrEqual(baseDir: string, candidate: string): boolean {
  const relative = path.relative(baseDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateExistingExportDirectory(params: {
  dir: string;
  label: string;
  realWorkspace: string;
}): string {
  const linkStat = fs.lstatSync(params.dir);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new Error(`${params.label} must be a real directory inside the workspace`);
  }
  const realDir = fs.realpathSync(params.dir);
  if (!isPathInsideOrEqual(params.realWorkspace, realDir)) {
    throw new Error("Trajectory exports directory must stay inside the workspace");
  }
  return realDir;
}

function mkdirIfMissingThenValidate(params: {
  dir: string;
  label: string;
  realWorkspace: string;
}): string {
  if (!fs.existsSync(params.dir)) {
    try {
      fs.mkdirSync(params.dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  return validateExistingExportDirectory(params);
}

function resolveTrajectoryExportBaseDir(workspaceDir: string): {
  baseDir: string;
  realBase: string;
} {
  const workspacePath = path.resolve(workspaceDir);
  const realWorkspace = fs.realpathSync(workspacePath);
  const stateDir = path.join(workspacePath, ".openclaw");
  mkdirIfMissingThenValidate({
    dir: stateDir,
    label: "OpenClaw state directory",
    realWorkspace,
  });
  const baseDir = path.join(stateDir, "trajectory-exports");
  const realBase = mkdirIfMissingThenValidate({
    dir: baseDir,
    label: "Trajectory exports directory",
    realWorkspace,
  });
  return { baseDir: path.resolve(baseDir), realBase };
}

function resolveTrajectoryCommandOutputDir(params: {
  outputPath?: string;
  workspaceDir: string;
  sessionId: string;
}): string {
  const { baseDir, realBase } = resolveTrajectoryExportBaseDir(params.workspaceDir);
  const raw = params.outputPath?.trim();
  if (!raw) {
    const defaultDir = resolveDefaultTrajectoryExportDir({
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
    });
    return path.join(baseDir, path.basename(defaultDir));
  }
  if (path.isAbsolute(raw) || raw.startsWith("~")) {
    throw new Error("Output path must be relative to the workspace trajectory exports directory");
  }
  const resolvedBase = path.resolve(baseDir);
  const outputDir = path.resolve(resolvedBase, raw);
  const relative = path.relative(resolvedBase, outputDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Output path must stay inside the workspace trajectory exports directory");
  }
  let existingParent = outputDir;
  while (!fs.existsSync(existingParent)) {
    const next = path.dirname(existingParent);
    if (next === existingParent) {
      break;
    }
    existingParent = next;
  }
  const realExistingParent = fs.realpathSync(existingParent);
  if (!isPathInsideOrEqual(realBase, realExistingParent)) {
    throw new Error("Output path must stay inside the real trajectory exports directory");
  }
  return outputDir;
}

export async function buildExportTrajectoryReply(
  params: HandleCommandsParams,
): Promise<ReplyPayload> {
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-trajectory",
    "trajectory",
  ]);
  const sessionTarget = resolveExportCommandSessionTarget(params);
  if (isReplyPayload(sessionTarget)) {
    return sessionTarget;
  }
  const { entry, sessionFile } = sessionTarget;

  if (!fs.existsSync(sessionFile)) {
    return { text: "❌ Session file not found." };
  }

  let outputDir: string;
  try {
    outputDir = resolveTrajectoryCommandOutputDir({
      outputPath: args.outputPath,
      workspaceDir: params.workspaceDir,
      sessionId: entry.sessionId,
    });
  } catch (err) {
    return {
      text: `❌ Failed to resolve output path: ${formatErrorMessage(err)}`,
    };
  }

  let bundle: ReturnType<typeof exportTrajectoryBundle>;
  try {
    bundle = exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
  } catch (err) {
    return {
      text: `❌ Failed to export trajectory: ${formatErrorMessage(err)}`,
    };
  }

  const relativePath = path.relative(params.workspaceDir, bundle.outputDir);
  const displayPath =
    relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
      ? relativePath
      : path.basename(bundle.outputDir);
  const files = ["manifest.json", "events.jsonl", "session-branch.json"];
  if (bundle.events.some((event) => event.type === "context.compiled")) {
    files.push("system-prompt.txt", "tools.json");
  }
  files.push(...bundle.supplementalFiles);

  return {
    text: [
      "✅ Trajectory exported!",
      "",
      `📦 Bundle: ${displayPath}`,
      `🧵 Session: ${entry.sessionId}`,
      `📊 Events: ${bundle.manifest.eventCount}`,
      `🧪 Runtime events: ${bundle.manifest.runtimeEventCount}`,
      `📝 Transcript events: ${bundle.manifest.transcriptEventCount}`,
      `📁 Files: ${files.join(", ")}`,
    ].join("\n"),
  };
}
