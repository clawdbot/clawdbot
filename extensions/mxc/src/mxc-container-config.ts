import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { ContainerConfig } from "@microsoft/mxc-sdk";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import type { MxcConfig } from "./config.js";
import { resolveBaselineReadonlyPaths, type BaselineHostEnv } from "./sandbox-baseline.js";
import type {
  LoadedSandboxBaselinePolicy,
  SandboxConfiguredPathEntry,
} from "./sandbox-policy-loader.js";
import { buildCommandLine } from "./windows-command.js";
import { normalizeWindowsProcessEnvRecord } from "./windows-env.js";
import {
  resolveMxcReadOnlySkillMounts,
  type MxcReadOnlySkillMount,
  type MxcWorkspaceAccess,
} from "./workspace-skill-mounts.js";

const MXC_SCHEMA_VERSION = "0.7.0-alpha";
const PROCESS_CONTAINER_NAME_MAX_LEN = 64;

type MxcFilesystemConfig = NonNullable<ContainerConfig["filesystem"]>;

type FilesystemPathSpec = {
  path: string;
  required: boolean;
  sources?: readonly string[];
};

type BaselineApplicationContext = {
  projectDir: string;
  hostEnv: BaselineHostEnv;
};

type MxcWorkspaceContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  activeWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: MxcWorkspaceAccess;
};

export function resolveCurrentBaselineContext(projectDir: string): BaselineApplicationContext {
  return {
    projectDir: path.resolve(projectDir),
    hostEnv: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ProgramFiles: process.env.ProgramFiles,
      ProgramW6432: process.env.ProgramW6432,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  };
}

export function resolveMxcWorkspaceContext(params: {
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: MxcWorkspaceAccess;
}): MxcWorkspaceContext {
  const workspaceAccess = params.workspaceAccess ?? "rw";
  const workspaceDir = path.resolve(params.workdir);
  const agentWorkspaceDir = path.resolve(params.agentWorkspaceDir ?? params.workdir);
  return {
    workspaceDir,
    agentWorkspaceDir,
    activeWorkspaceDir: workspaceAccess === "rw" ? agentWorkspaceDir : workspaceDir,
    ...(params.skillsWorkspaceDir
      ? { skillsWorkspaceDir: path.resolve(params.skillsWorkspaceDir) }
      : {}),
    workdir: workspaceDir,
    workspaceAccess,
  };
}

export function resolveMxcRuntimeWorkdir(
  workspace: MxcWorkspaceContext,
  requestedWorkdir: string,
): string {
  if (workspace.workspaceAccess !== "rw") {
    return path.resolve(requestedWorkdir);
  }

  const relativePath = path.relative(workspace.workspaceDir, requestedWorkdir);
  return relativePath === ""
    ? workspace.activeWorkspaceDir
    : path.join(workspace.activeWorkspaceDir, relativePath);
}

export function buildMxcContainerConfig(params: {
  config: MxcConfig;
  baseline: LoadedSandboxBaselinePolicy;
  baselineContext: BaselineApplicationContext;
  runtimeId: string;
  containerId: string;
  command: string;
  args?: readonly string[];
  sandboxTempDir: string;
  workdir: string;
  workspace: MxcWorkspaceContext;
  env: Record<string, string>;
}): ContainerConfig {
  const networkAllowed = params.config.network === "default";
  const filesystem = buildFilesystemConfig({
    baseline: params.baseline,
    context: params.baselineContext,
    sandboxTempDir: params.sandboxTempDir,
    workspace: params.workspace,
  });

  const processEnv = normalizeWindowsProcessEnvRecord({
    ...params.env,
    TEMP: params.sandboxTempDir,
    TMP: params.sandboxTempDir,
  });

  return {
    version: MXC_SCHEMA_VERSION,
    containerId: params.containerId,
    containment: params.config.containment,
    lifecycle: { destroyOnExit: true },
    process: {
      commandLine: buildCommandLine(params.command, params.args ?? []),
      cwd: resolveProcessCwd(params.workdir),
      env: processEnv,
      timeout: resolveProcessTimeoutSeconds(params.config, params.baseline) * 1000,
    },
    filesystem,
    ui: {
      disable: true,
      clipboard: "none",
      injection: false,
    },
    network: {
      defaultPolicy: networkAllowed ? "allow" : "block",
      enforcementMode: "capabilities",
    },
    processContainer: {
      name: processContainerName(params.runtimeId),
      leastPrivilege: true,
      capabilities: networkAllowed ? ["internetClient"] : [],
      ui: {
        isolation: "container",
        desktopSystemControl: false,
        systemSettings: "none",
        ime: false,
      },
    },
  };
}

function buildFilesystemConfig(params: {
  baseline: LoadedSandboxBaselinePolicy;
  context: BaselineApplicationContext;
  sandboxTempDir: string;
  workspace: MxcWorkspaceContext;
}): MxcFilesystemConfig {
  const readwritePathSpecs = resolveWorkspaceReadwritePathSpecs(params.workspace);
  const readonlyPathSpecs = [
    ...resolveWorkspaceReadonlyPathSpecs(params.workspace),
    ...resolveBaselineReadonlyPathSpecs(params.baseline, params.context),
    ...resolveProtectedSkillPolicyPathSpecs(params.workspace),
  ];

  if (params.baseline.filesystem.restrictToProjectDir) {
    const projectDirPath = params.context.projectDir;
    if (params.workspace.workspaceAccess === "rw") {
      readwritePathSpecs.push(requiredFilesystemPath(projectDirPath));
    } else {
      readonlyPathSpecs.push(requiredFilesystemPath(projectDirPath));
    }
    readwritePathSpecs.push(requiredFilesystemPath(path.resolve(params.sandboxTempDir)));
    readwritePathSpecs.push(
      ...params.baseline.configuredPaths.readwritePaths.map(createConfiguredFilesystemPath),
    );
  }

  const protectedSkillPolicyPaths = resolveMxcProtectedSkillPolicyPaths(params.workspace);
  // ProcessContainer writable-parent grants override nested read-only grants.
  // Fail closed instead of claiming protected skill overlays are enforceable.
  assertNoMxcReadwriteReadonlyOverlap({
    readwritePaths: resolveExistingFilesystemPaths(readwritePathSpecs, "readwrite"),
    readonlyPaths: protectedSkillPolicyPaths,
  });

  const readonlyPaths = resolveExistingFilesystemPaths(readonlyPathSpecs, "read-only");
  const readwritePaths = resolveExistingFilesystemPaths(readwritePathSpecs, "readwrite");
  assertNoMxcReadwriteReadonlyOverlap({ readwritePaths, readonlyPaths });

  return {
    readonlyPaths,
    deniedPaths: undefined,
    readwritePaths,
    clearPolicyOnExit: true,
  };
}

function resolveWorkspaceReadwritePathSpecs(workspace: MxcWorkspaceContext): FilesystemPathSpec[] {
  if (workspace.workspaceAccess !== "rw") {
    return [];
  }
  return [requiredFilesystemPath(workspace.activeWorkspaceDir)];
}

function resolveWorkspaceReadonlyPathSpecs(workspace: MxcWorkspaceContext): FilesystemPathSpec[] {
  if (workspace.workspaceAccess === "rw") {
    return [];
  }

  const readonlyPathSpecs = [requiredFilesystemPath(workspace.workspaceDir)];
  if (
    workspace.workspaceAccess === "ro" &&
    normalizePathForComparison(workspace.agentWorkspaceDir) !==
      normalizePathForComparison(workspace.workspaceDir)
  ) {
    readonlyPathSpecs.push(requiredFilesystemPath(workspace.agentWorkspaceDir));
  }
  return readonlyPathSpecs;
}

function resolveBaselineReadonlyPathSpecs(
  baseline: LoadedSandboxBaselinePolicy,
  context: BaselineApplicationContext,
): FilesystemPathSpec[] {
  return [
    ...resolveBaselineReadonlyPaths(context.hostEnv).map((candidatePath) =>
      optionalFilesystemPath(path.resolve(candidatePath)),
    ),
    ...baseline.configuredPaths.readonlyPaths.map(createConfiguredFilesystemPath),
  ];
}

function resolveMxcProtectedSkillPolicyPaths(context: MxcWorkspaceContext): string[] {
  const deduped = new Map<string, string>();
  for (const mount of resolveMxcProtectedSkillMounts(context)) {
    const hostPath = path.resolve(mount.hostPath);
    deduped.set(normalizePathForComparison(hostPath), hostPath);
    const containerPath = path.resolve(mount.containerPath);
    deduped.set(normalizePathForComparison(containerPath), containerPath);
  }
  return [...deduped.values()];
}

function resolveProtectedSkillPolicyPathSpecs(context: MxcWorkspaceContext): FilesystemPathSpec[] {
  return resolveMxcProtectedSkillPolicyPaths(context).map((candidatePath) =>
    optionalFilesystemPath(candidatePath),
  );
}

function resolveMxcProtectedSkillMounts(
  context: MxcWorkspaceContext,
): readonly MxcReadOnlySkillMount[] {
  return resolveMxcReadOnlySkillMounts({
    agentWorkspaceDir: context.agentWorkspaceDir,
    skillsWorkspaceDir: context.skillsWorkspaceDir,
    workdir: context.workdir,
    workspaceAccess: context.workspaceAccess,
  });
}

function resolveExistingFilesystemPaths(
  pathSpecs: readonly FilesystemPathSpec[],
  accessLabel: "read-only" | "readwrite",
): string[] {
  const deduped = new Map<
    string,
    {
      path: string;
      required: boolean;
      sources: Set<string>;
    }
  >();

  for (const pathSpec of pathSpecs) {
    const key = normalizePathForComparison(pathSpec.path);
    const existing = deduped.get(key);
    if (existing) {
      existing.required ||= pathSpec.required;
      for (const source of pathSpec.sources ?? []) {
        existing.sources.add(source);
      }
      continue;
    }

    deduped.set(key, {
      path: pathSpec.path,
      required: pathSpec.required,
      sources: new Set(pathSpec.sources ?? []),
    });
  }

  const resolvedPaths: string[] = [];
  for (const pathSpec of deduped.values()) {
    if (hostPathExists(pathSpec.path)) {
      resolvedPaths.push(pathSpec.path);
      continue;
    }
    if (!pathSpec.required) {
      continue;
    }
    throw new Error(
      buildMissingFilesystemPathMessage(pathSpec.path, accessLabel, pathSpec.sources),
    );
  }
  return resolvedPaths;
}

function requiredFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: true,
  };
}

function optionalFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: false,
  };
}

function createConfiguredFilesystemPath(pathEntry: SandboxConfiguredPathEntry): FilesystemPathSpec {
  return {
    path: path.resolve(pathEntry.path),
    required: true,
    sources: pathEntry.sources,
  };
}

function buildMissingFilesystemPathMessage(
  pathValue: string,
  accessLabel: "read-only" | "readwrite",
  sources: ReadonlySet<string>,
): string {
  const sourceLabel = [...sources].join(", ");
  if (sourceLabel) {
    return (
      `MXC sandbox ${accessLabel} path ${pathValue} configured by ${sourceLabel} ` +
      `is missing on the host. Recreate the path or update the policy file before launching the sandbox.`
    );
  }
  return `MXC sandbox ${accessLabel} path ${pathValue} does not exist on the host.`;
}

function processContainerName(runtimeId: string): string {
  if (runtimeId.length <= PROCESS_CONTAINER_NAME_MAX_LEN) {
    return runtimeId;
  }
  const hash = createHash("sha256").update(runtimeId).digest("hex").slice(0, 8);
  return `${runtimeId.slice(0, PROCESS_CONTAINER_NAME_MAX_LEN - hash.length - 1)}-${hash}`;
}

function resolveProcessCwd(workdir: string): string {
  return workdir;
}

function resolveProcessTimeoutSeconds(
  config: MxcConfig,
  baseline: LoadedSandboxBaselinePolicy,
): number {
  if (config.timeoutSecondsConfigured === true) {
    return Math.min(config.timeoutSeconds, baseline.process.timeoutSeconds);
  }
  return baseline.process.timeoutSeconds;
}

function assertNoMxcReadwriteReadonlyOverlap(params: {
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
}): void {
  for (const readwritePath of params.readwritePaths) {
    for (const readonlyPath of params.readonlyPaths) {
      if (pathsOverlap(readwritePath, readonlyPath)) {
        throw new Error(
          `MXC readwrite path ${readwritePath} overlaps read-only path ${readonlyPath}. Windows MXC cannot safely enforce nested read-only overlays under writable paths.`,
        );
      }
    }
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const left = normalizePathForComparison(first);
  const right = normalizePathForComparison(second);
  return isPathInside(left, right) || isPathInside(right, left);
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hostPathExists(candidatePath: string): boolean {
  try {
    statSync(candidatePath);
    return true;
  } catch (err) {
    if (isNodeError(err)) {
      return false;
    }
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
