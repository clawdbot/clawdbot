import fsp from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { exportTrajectoryBundle, resolveDefaultTrajectoryExportDir } from "./export.js";

export type TrajectoryCommandExportSummary = {
  outputDir: string;
  displayPath: string;
  sessionId: string;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  files: string[];
};

async function validateExistingExportDirectory(params: {
  dir: string;
  label: string;
  realWorkspace: string;
}): Promise<string> {
  const linkStat = await fsp.lstat(params.dir);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new Error(`${params.label} must be a real directory inside the workspace`);
  }
  const realDir = await fsp.realpath(params.dir);
  if (!isPathInside(params.realWorkspace, realDir)) {
    throw new Error("Trajectory exports directory must stay inside the workspace");
  }
  return realDir;
}

async function mkdirIfMissingThenValidate(params: {
  dir: string;
  label: string;
  realWorkspace: string;
}): Promise<string> {
  try {
    await fsp.mkdir(params.dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  return await validateExistingExportDirectory(params);
}

async function resolveTrajectoryExportBaseDir(workspaceDir: string): Promise<{
  baseDir: string;
  realBase: string;
}> {
  const workspacePath = path.resolve(workspaceDir);
  const realWorkspace = await fsp.realpath(workspacePath);
  const stateDir = path.join(workspacePath, ".openclaw");
  await mkdirIfMissingThenValidate({
    dir: stateDir,
    label: "OpenClaw state directory",
    realWorkspace,
  });
  const baseDir = path.join(stateDir, "trajectory-exports");
  const realBase = await mkdirIfMissingThenValidate({
    dir: baseDir,
    label: "Trajectory exports directory",
    realWorkspace,
  });
  return { baseDir: path.resolve(baseDir), realBase };
}

export async function resolveTrajectoryCommandOutputDir(params: {
  outputPath?: string;
  workspaceDir: string;
  sessionId: string;
}): Promise<string> {
  const { baseDir, realBase } = await resolveTrajectoryExportBaseDir(params.workspaceDir);
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
  while (!(await pathExists(existingParent))) {
    const next = path.dirname(existingParent);
    if (next === existingParent) {
      break;
    }
    existingParent = next;
  }
  const realExistingParent = await fsp.realpath(existingParent);
  if (!isPathInside(realBase, realExistingParent)) {
    throw new Error("Output path must stay inside the real trajectory exports directory");
  }
  return outputDir;
}

export async function exportTrajectoryForCommand(params: {
  outputDir?: string;
  outputPath?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
}): Promise<TrajectoryCommandExportSummary> {
  const outputDir =
    params.outputDir ??
    (await resolveTrajectoryCommandOutputDir({
      outputPath: params.outputPath,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
    }));
  const bundle = await exportTrajectoryBundle({
    outputDir,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
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
    outputDir: bundle.outputDir,
    displayPath,
    sessionId: params.sessionId,
    eventCount: bundle.manifest.eventCount,
    runtimeEventCount: bundle.manifest.runtimeEventCount,
    transcriptEventCount: bundle.manifest.transcriptEventCount,
    files,
  };
}

export function formatTrajectoryCommandExportSummary(
  summary: TrajectoryCommandExportSummary,
): string {
  return [
    "✅ Trajectory exported!",
    "",
    `📦 Bundle: ${summary.displayPath}`,
    `🧵 Session: ${summary.sessionId}`,
    `📊 Events: ${summary.eventCount}`,
    `🧪 Runtime events: ${summary.runtimeEventCount}`,
    `📝 Transcript events: ${summary.transcriptEventCount}`,
    `📁 Files: ${summary.files.join(", ")}`,
  ].join("\n");
}
