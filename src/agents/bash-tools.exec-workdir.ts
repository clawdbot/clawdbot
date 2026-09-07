/**
 * Internal exec workdir resolver.
 * Owns cwd selection and validation before exec approval, hooks, preflight, or
 * process launch can observe an invalid selected working directory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { safeRealpathSync } from "../infra/boundary-path.js";
import type { ExecHost } from "../infra/exec-approvals.js";
import { isPathInside, safeStatSync } from "../infra/path-guards.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { assertSandboxPath } from "./sandbox-paths.js";

export type ExecWorkdirResolution =
  | { kind: "local"; hostCwd: string }
  | { kind: "sandbox"; hostCwd: string; containerCwd: string; scriptPreflightCwd: string | null }
  | { kind: "node"; remoteCwd?: string }
  | { kind: "unavailable"; requestedCwd: string };

type NormalizedWorkdirInput =
  | { kind: "omitted" }
  | { kind: "blank"; raw: string }
  | { kind: "specified"; value: string };

type SandboxWorkdir = {
  hostCwd: string;
  containerCwd: string;
  scriptPreflightCwd: string | null;
};

type BackendHostWorkdirCandidate = {
  hostPath: string;
  hostRoot: string;
  containerRoot: string;
  failIfInvalid: boolean;
};

type ContainerHostWorkdirMapping = {
  hostPath: string;
  hostRoot: string;
  containerRoot: string;
};

type ExistingHostPathResult =
  | { kind: "available"; workdir: SandboxWorkdir }
  | { kind: "missing"; relative: string }
  | { kind: "invalid" };

function normalizeExplicitWorkdirInput(workdir: string | undefined): NormalizedWorkdirInput {
  if (workdir === undefined || workdir === "") {
    return { kind: "omitted" };
  }
  const value = normalizeOptionalString(workdir);
  return value ? { kind: "specified", value } : { kind: "blank", raw: workdir };
}

function unavailable(requestedCwd: string): ExecWorkdirResolution {
  return { kind: "unavailable", requestedCwd };
}

function resolveExistingHostWorkdir(workdir: string): string | null {
  const stats = safeStatSync(workdir);
  return stats?.isDirectory() ? (safeRealpathSync(workdir) ?? path.resolve(workdir)) : null;
}

function safeCurrentCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function mapContainerWorkdirToHost(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
  includeReadOnlySkillMounts?: boolean;
  includePrimaryWorkspace?: boolean;
}): ContainerHostWorkdirMapping | undefined {
  const workdir = normalizeContainerPath(params.workdir);
  const mappings = [
    ...(params.includeReadOnlySkillMounts
      ? (params.sandbox.readOnlyWorkspaceSkillMounts ?? []).map((mount) => ({
          hostRoot: path.resolve(mount.hostPath),
          containerRoot: normalizeContainerPath(mount.containerPath),
        }))
      : []),
    ...(params.includePrimaryWorkspace === false
      ? []
      : [
          {
            hostRoot: path.resolve(params.sandbox.workspaceDir),
            containerRoot: normalizeContainerPath(params.sandbox.containerWorkdir),
          },
        ]),
  ]
    .filter((mapping) => mapping.containerRoot !== ".")
    .toSorted((left, right) => right.containerRoot.length - left.containerRoot.length);

  for (const mapping of mappings) {
    const relative = mapContainerWorkdirRelativeToRoot({
      workdir,
      root: mapping.containerRoot,
    });
    if (relative === null) {
      continue;
    }
    return {
      hostPath: path.resolve(mapping.hostRoot, ...relative),
      hostRoot: mapping.hostRoot,
      containerRoot: mapping.containerRoot,
    };
  }
  return undefined;
}

function normalizeContainerPath(input: string): string {
  const normalized = input.trim().replace(/\\/g, "/");
  if (!normalized) {
    return ".";
  }
  const posixPath = path.posix.normalize(normalized);
  return posixPath === "/" ? posixPath : posixPath.replace(/\/+$/g, "");
}

function mapContainerWorkdirRelativeToRoot(params: {
  workdir: string;
  root: string;
}): string[] | null {
  if (params.workdir === params.root) {
    return [];
  }
  if (params.root === "/") {
    return path.posix.isAbsolute(params.workdir) ? params.workdir.split("/").filter(Boolean) : null;
  }
  if (!params.workdir.startsWith(`${params.root}/`)) {
    return null;
  }
  return params.workdir
    .slice(params.root.length + 1)
    .split("/")
    .filter(Boolean);
}

function joinContainerWorkdir(containerWorkdir: string, relative: string): string {
  return relative ? path.posix.join(containerWorkdir, relative) : containerWorkdir;
}

function hasParentPathSegment(input: string): boolean {
  return input
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

function isContainerWorkdirInsideRoot(params: { root: string; workdir: string }): boolean {
  const root = normalizeContainerPath(params.root);
  const workdir = normalizeContainerPath(params.workdir);
  if (root === "/") {
    return path.posix.isAbsolute(workdir);
  }
  return workdir === root || workdir.startsWith(`${root}/`);
}

function resolveBackendWorkdirRoots(sandbox: BashSandboxConfig): string[] {
  const roots: string[] = [];
  const addRoot = (root: string | undefined) => {
    const normalized = normalizeContainerPath(root ?? "");
    if (normalized === "." || !path.posix.isAbsolute(normalized) || roots.includes(normalized)) {
      return;
    }
    roots.push(normalized);
  };
  addRoot(sandbox.containerWorkdir);
  for (const root of sandbox.workdirRoots ?? []) {
    addRoot(root);
  }
  return roots;
}

function resolveBackendContainerWorkdir(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
}): string | null {
  const containerRoot = normalizeContainerPath(params.sandbox.containerWorkdir);
  const backendRoots = resolveBackendWorkdirRoots(params.sandbox);
  const requested = normalizeContainerPath(params.workdir);
  if (path.posix.isAbsolute(requested)) {
    return backendRoots.some((root) => isContainerWorkdirInsideRoot({ root, workdir: requested }))
      ? requested
      : null;
  }
  if (requested === ".." || requested.startsWith("../")) {
    return null;
  }
  return joinContainerWorkdir(containerRoot, requested === "." ? "" : requested);
}

async function mapExistingHostPath(params: {
  hostPath: string;
  hostRoot: string;
  containerRoot: string;
}): Promise<ExistingHostPathResult> {
  let resolved: Awaited<ReturnType<typeof assertSandboxPath>>;
  try {
    resolved = await assertSandboxPath({
      filePath: params.hostPath,
      cwd: params.hostRoot,
      root: params.hostRoot,
    });
  } catch {
    return { kind: "invalid" };
  }
  const stats = safeStatSync(resolved.resolved);
  if (!stats) {
    return {
      kind: "missing",
      relative: resolved.relative ? resolved.relative.split(path.sep).join(path.posix.sep) : "",
    };
  }
  if (!stats.isDirectory()) {
    return { kind: "invalid" };
  }
  const relative = resolved.relative ? resolved.relative.split(path.sep).join(path.posix.sep) : "";
  return {
    kind: "available",
    workdir: {
      hostCwd: resolved.resolved,
      containerCwd: joinContainerWorkdir(params.containerRoot, relative),
      scriptPreflightCwd: resolved.resolved,
    },
  };
}

async function validateBackendWorkdir(params: {
  workdir: SandboxWorkdir;
  sandbox: BashSandboxConfig;
}): Promise<SandboxWorkdir | null> {
  const containerCwd = await params.sandbox.validateWorkdir?.(params.workdir.containerCwd);
  return containerCwd
    ? {
        hostCwd: params.workdir.hostCwd,
        containerCwd,
        scriptPreflightCwd: params.workdir.scriptPreflightCwd,
      }
    : null;
}

function resolveBackendHostWorkdirCandidate(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
}): BackendHostWorkdirCandidate | null {
  if (!path.isAbsolute(params.workdir)) {
    return {
      hostPath: path.resolve(params.sandbox.workspaceDir, params.workdir),
      hostRoot: path.resolve(params.sandbox.workspaceDir),
      containerRoot: normalizeContainerPath(params.sandbox.containerWorkdir),
      failIfInvalid: false,
    };
  }
  const hostPath = path.resolve(params.workdir);
  const readOnlySkillMapping = mapContainerWorkdirToHost({
    workdir: params.workdir,
    sandbox: params.sandbox,
    includeReadOnlySkillMounts: true,
    includePrimaryWorkspace: false,
  });
  if (readOnlySkillMapping) {
    return { ...readOnlySkillMapping, failIfInvalid: false };
  }
  if (isPathInside(path.resolve(params.sandbox.workspaceDir), hostPath)) {
    return {
      hostPath,
      hostRoot: path.resolve(params.sandbox.workspaceDir),
      containerRoot: normalizeContainerPath(params.sandbox.containerWorkdir),
      failIfInvalid: true,
    };
  }
  const containerMappedWorkdir = mapContainerWorkdirToHost({
    workdir: params.workdir,
    sandbox: params.sandbox,
  });
  return containerMappedWorkdir ? { ...containerMappedWorkdir, failIfInvalid: false } : null;
}

async function resolveBackendValidatedSandboxWorkdir(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
}): Promise<SandboxWorkdir | null> {
  const workspaceHostCwd = resolveExistingHostWorkdir(params.sandbox.workspaceDir);
  if (!workspaceHostCwd) {
    return null;
  }
  const hostCandidate = resolveBackendHostWorkdirCandidate(params);
  if (hostCandidate) {
    const mappedWorkdir = await mapExistingHostPath({
      hostPath: hostCandidate.hostPath,
      hostRoot: hostCandidate.hostRoot,
      containerRoot: hostCandidate.containerRoot,
    });
    if (mappedWorkdir.kind === "available") {
      return await validateBackendWorkdir({
        workdir: mappedWorkdir.workdir,
        sandbox: params.sandbox,
      });
    }
    if (mappedWorkdir.kind === "missing") {
      return await validateBackendWorkdir({
        workdir: {
          hostCwd: workspaceHostCwd,
          containerCwd: joinContainerWorkdir(hostCandidate.containerRoot, mappedWorkdir.relative),
          scriptPreflightCwd: null,
        },
        sandbox: params.sandbox,
      });
    }
    if (hostCandidate.failIfInvalid && mappedWorkdir.kind === "invalid") {
      return null;
    }
  }
  const containerCwd = resolveBackendContainerWorkdir(params);
  if (containerCwd) {
    return await validateBackendWorkdir({
      workdir: {
        hostCwd: workspaceHostCwd,
        containerCwd,
        scriptPreflightCwd: null,
      },
      sandbox: params.sandbox,
    });
  }
  return null;
}

async function resolveHostValidatedSandboxWorkdir(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
}): Promise<SandboxWorkdir | null> {
  const mappedHostWorkdir = mapContainerWorkdirToHost({
    workdir: params.workdir,
    sandbox: params.sandbox,
    includeReadOnlySkillMounts: true,
  });
  const candidateWorkdir = mappedHostWorkdir?.hostPath ?? params.workdir;
  const candidateRoot = mappedHostWorkdir?.hostRoot ?? params.sandbox.workspaceDir;
  const containerRoot = mappedHostWorkdir?.containerRoot ?? params.sandbox.containerWorkdir;
  try {
    const resolved = await assertSandboxPath({
      filePath: candidateWorkdir,
      cwd: candidateRoot,
      root: candidateRoot,
    });
    const stats = await fs.stat(resolved.resolved);
    if (!stats.isDirectory()) {
      return null;
    }
    const relative = resolved.relative
      ? resolved.relative.split(path.sep).join(path.posix.sep)
      : "";
    const containerCwd = joinContainerWorkdir(containerRoot, relative);
    return { hostCwd: resolved.resolved, containerCwd, scriptPreflightCwd: resolved.resolved };
  } catch {
    return null;
  }
}

async function resolveSandboxWorkdir(params: {
  workdir: string;
  sandbox: BashSandboxConfig;
}): Promise<SandboxWorkdir | null> {
  if (hasParentPathSegment(params.workdir)) {
    return null;
  }
  if (params.sandbox.workdirValidation === "backend") {
    return await resolveBackendValidatedSandboxWorkdir(params);
  }
  return await resolveHostValidatedSandboxWorkdir(params);
}

export function formatUnavailableWorkdirFailure(workdir: string): string {
  return [
    `workdir "${workdir}" is unavailable or not a directory: command was not executed.`,
    'workdir is treated as a literal path; shell expansions such as "~" are not applied.',
    "Use an existing directory, omit an explicit workdir to use the default cwd, or update the configured default cwd.",
  ].join(" ");
}

export async function resolveExecWorkdir(params: {
  host: ExecHost;
  workdir?: string;
  defaultCwd?: string;
  nodeCwd?: string;
  sandbox?: BashSandboxConfig;
}): Promise<ExecWorkdirResolution> {
  const explicitWorkdir = normalizeExplicitWorkdirInput(params.workdir);
  if (explicitWorkdir.kind === "blank") {
    return unavailable(explicitWorkdir.raw);
  }

  if (params.host === "node") {
    const remoteCwd =
      explicitWorkdir.kind === "specified"
        ? explicitWorkdir.value
        : normalizeOptionalString(params.nodeCwd);
    return remoteCwd ? { kind: "node", remoteCwd } : { kind: "node" };
  }

  const defaultCwd = normalizeOptionalString(params.defaultCwd);
  if (params.host === "sandbox") {
    const sandbox = params.sandbox;
    if (!sandbox) {
      throw new Error("exec internal error: sandbox workdir resolution requires sandbox config");
    }
    const requestedCwd =
      explicitWorkdir.kind === "specified"
        ? explicitWorkdir.value
        : (defaultCwd ?? sandbox.containerWorkdir);
    const resolved = await resolveSandboxWorkdir({ workdir: requestedCwd, sandbox });
    return resolved
      ? {
          kind: "sandbox",
          hostCwd: resolved.hostCwd,
          containerCwd: resolved.containerCwd,
          scriptPreflightCwd: resolved.scriptPreflightCwd,
        }
      : unavailable(requestedCwd);
  }

  const requestedCwd =
    explicitWorkdir.kind === "specified" ? explicitWorkdir.value : (defaultCwd ?? safeCurrentCwd());
  if (!requestedCwd) {
    return unavailable("current working directory");
  }
  const resolved = resolveExistingHostWorkdir(requestedCwd);
  return resolved ? { kind: "local", hostCwd: resolved } : unavailable(requestedCwd);
}
