/**
 * Sandbox filesystem mount and path resolution helpers.
 *
 * Builds the container-to-host mount table and maps requested sandbox paths to writable/read-only host targets.
 */
import os from "node:os";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveSandboxInputPath, resolveSandboxPath } from "../sandbox-paths.js";
import type { SandboxFsBridgeContext } from "./backend-handle.types.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import {
  isPathInsideContainerRoot,
  normalizeContainerPath,
  relativePathEscapesContainerRoot,
} from "./path-utils.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./workspace-mounts.js";

export type SandboxFsMount = {
  hostRoot: string;
  containerRoot: string;
  writable: boolean;
  source: "workspace" | "agent" | "bind" | "protectedSkill";
};

export type SandboxResolvedFsPath = {
  hostPath: string;
  relativePath: string;
  containerPath: string;
  writable: boolean;
};

type ParsedBindMount = {
  hostRoot: string;
  containerRoot: string;
  writable: boolean;
};

function parseSandboxBindMount(spec: string): ParsedBindMount | null {
  const trimmed = spec.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = splitSandboxBindSpec(trimmed);
  if (!parsed) {
    return null;
  }

  const hostToken = parsed.host.trim();
  const containerToken = parsed.container.trim();
  if (!hostToken || !containerToken || !path.posix.isAbsolute(containerToken)) {
    return null;
  }
  const optionsToken = normalizeOptionalLowercaseString(parsed.options) ?? "";
  const optionParts = optionsToken ? normalizeStringEntries(optionsToken.split(",")) : [];
  const writable = !optionParts.includes("ro");
  return {
    hostRoot: path.resolve(hostToken),
    containerRoot: normalizeContainerPath(containerToken),
    writable,
  };
}

export function buildSandboxFsMounts(sandbox: SandboxFsBridgeContext): SandboxFsMount[] {
  const mounts: SandboxFsMount[] = [
    {
      hostRoot: path.resolve(sandbox.workspaceDir),
      containerRoot: normalizeContainerPath(sandbox.containerWorkdir),
      writable: sandbox.workspaceAccess === "rw",
      source: "workspace",
    },
  ];

  if (
    sandbox.workspaceAccess !== "none" &&
    path.resolve(sandbox.agentWorkspaceDir) !== path.resolve(sandbox.workspaceDir)
  ) {
    mounts.push({
      hostRoot: path.resolve(sandbox.agentWorkspaceDir),
      containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
      writable: sandbox.workspaceAccess === "rw",
      source: "agent",
    });
  }

  for (const mount of resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: sandbox.workspaceDir,
    agentWorkspaceDir: sandbox.agentWorkspaceDir,
    skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
    workdir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
  })) {
    mounts.push({
      hostRoot: path.resolve(mount.hostPath),
      containerRoot: normalizeContainerPath(mount.containerPath),
      writable: false,
      source: "protectedSkill",
    });
  }

  for (const bind of sandbox.docker.binds ?? []) {
    const parsed = parseSandboxBindMount(bind);
    if (!parsed) {
      continue;
    }
    mounts.push({
      hostRoot: parsed.hostRoot,
      containerRoot: parsed.containerRoot,
      writable: parsed.writable,
      source: "bind",
    });
  }

  return dedupeMounts(mounts);
}

export function resolveWritableSandboxBindHostRoots(
  binds: readonly string[] | undefined,
): string[] {
  const parsedBinds = parseSandboxBindMounts(binds);
  const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const parsed of parsedBinds) {
    if (
      !parsed.writable ||
      seen.has(parsed.hostRoot) ||
      readonlyRoots.some((root) => isHostPathWithinOrEqual(parsed.hostRoot, root))
    ) {
      continue;
    }
    seen.add(parsed.hostRoot);
    roots.push(parsed.hostRoot);
  }
  return roots;
}

export function hasSandboxBindContainerPathAliases(binds: readonly string[] | undefined): boolean {
  for (const parsed of parseSandboxBindMounts(binds)) {
    if (parsed.hostRoot !== parsed.containerRoot) {
      return true;
    }
  }
  return false;
}

export function hasSandboxBindReadonlyHostShadows(binds: readonly string[] | undefined): boolean {
  const parsedBinds = parseSandboxBindMounts(binds);
  const writableRoots = parsedBinds.filter((bind) => bind.writable).map((bind) => bind.hostRoot);
  const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
  return writableRoots.some((writableRoot) =>
    readonlyRoots.some((readonlyRoot) => isHostPathWithinOrEqual(writableRoot, readonlyRoot)),
  );
}

function parseSandboxBindMounts(binds: readonly string[] | undefined): ParsedBindMount[] {
  const parsed: ParsedBindMount[] = [];
  for (const bind of binds ?? []) {
    const mount = parseSandboxBindMount(bind);
    if (mount) {
      parsed.push(mount);
    }
  }
  return parsed;
}

export function resolveSandboxFsPathWithMounts(params: {
  filePath: string;
  cwd: string;
  defaultWorkspaceRoot: string;
  defaultContainerRoot: string;
  mounts: SandboxFsMount[];
}): SandboxResolvedFsPath {
  const mountsByContainer = [...params.mounts].toSorted(compareMountsByContainerPath);
  const mountsByHost = [...params.mounts].toSorted(compareMountsByHostPath);
  const input = params.filePath;
  const inputPosix = normalizePosixInput(input);

  if (path.posix.isAbsolute(inputPosix)) {
    const containerMount = findMountByContainerPath(mountsByContainer, inputPosix);
    if (containerMount) {
      return resolveMountedContainerPath({
        mount: containerMount,
        containerPath: inputPosix,
        defaultContainerRoot: params.defaultContainerRoot,
      });
    }
  }

  if (!path.posix.isAbsolute(inputPosix)) {
    const protectedContainerCandidate = resolveRelativeContainerCandidate({
      inputPosix,
      cwd: params.cwd,
      defaultContainerRoot: params.defaultContainerRoot,
      mountsByHost,
    });
    const protectedContainerMount = findMountByContainerPath(
      mountsByContainer,
      protectedContainerCandidate,
    );
    if (protectedContainerMount?.source === "protectedSkill") {
      return resolveMountedContainerPath({
        mount: protectedContainerMount,
        containerPath: protectedContainerCandidate,
        defaultContainerRoot: params.defaultContainerRoot,
      });
    }
  }

  const hostResolved = resolveSandboxInputPath(input, params.cwd);
  const hostMount = findMountByHostPath(mountsByHost, hostResolved);
  if (hostMount) {
    const relHost = path.relative(hostMount.hostRoot, hostResolved);
    const relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
    const containerPath = relPosix
      ? path.posix.join(hostMount.containerRoot, relPosix)
      : hostMount.containerRoot;
    return {
      hostPath: hostResolved,
      containerPath,
      relativePath: toDisplayRelative({
        containerPath,
        defaultContainerRoot: params.defaultContainerRoot,
      }),
      writable: hostMount.writable,
    };
  }

  const escapeMessage = formatSandboxRootEscapeMessage({
    input,
    defaultWorkspaceRoot: params.defaultWorkspaceRoot,
    defaultContainerRoot: params.defaultContainerRoot,
  });
  try {
    resolveSandboxPath({
      filePath: input,
      cwd: params.cwd,
      root: params.defaultWorkspaceRoot,
    });
  } catch {
    throw new Error(escapeMessage);
  }
  throw new Error(escapeMessage);
}

function resolveMountedContainerPath(params: {
  mount: SandboxFsMount;
  containerPath: string;
  defaultContainerRoot: string;
}): SandboxResolvedFsPath {
  const rel = path.posix.relative(params.mount.containerRoot, params.containerPath);
  const hostPath = rel
    ? path.resolve(params.mount.hostRoot, ...toHostSegments(rel))
    : params.mount.hostRoot;
  const containerPath = rel
    ? path.posix.join(params.mount.containerRoot, rel)
    : params.mount.containerRoot;
  return {
    hostPath,
    containerPath,
    relativePath: toDisplayRelative({
      containerPath,
      defaultContainerRoot: params.defaultContainerRoot,
    }),
    writable: params.mount.writable,
  };
}

function resolveRelativeContainerCandidate(params: {
  inputPosix: string;
  cwd: string;
  defaultContainerRoot: string;
  mountsByHost: SandboxFsMount[];
}): string {
  const cwdMount = findMountByHostPath(params.mountsByHost, path.resolve(params.cwd));
  if (cwdMount) {
    const relHost = path.relative(cwdMount.hostRoot, path.resolve(params.cwd));
    const relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
    const containerCwd = relPosix
      ? path.posix.join(cwdMount.containerRoot, relPosix)
      : cwdMount.containerRoot;
    return normalizeContainerPath(path.posix.resolve(containerCwd, params.inputPosix));
  }
  const cwdPosix = normalizePosixInput(params.cwd);
  if (path.posix.isAbsolute(cwdPosix)) {
    return normalizeContainerPath(path.posix.resolve(cwdPosix, params.inputPosix));
  }
  return normalizeContainerPath(path.posix.resolve(params.defaultContainerRoot, params.inputPosix));
}

function formatSandboxRootEscapeMessage(params: {
  input: string;
  defaultWorkspaceRoot: string;
  defaultContainerRoot: string;
}): string {
  const containerRoot = normalizeContainerPath(params.defaultContainerRoot);
  const workspaceRoot = shortenHomePath(path.resolve(params.defaultWorkspaceRoot));
  return `Path escapes sandbox root (${workspaceRoot}; container root ${containerRoot}): ${params.input}. Use a path under ${containerRoot}/ instead.`;
}

function shortenHomePath(value: string): string {
  const home = os.homedir();
  if (value === home || value.startsWith(`${home}${path.sep}`)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

function compareMountsByContainerPath(a: SandboxFsMount, b: SandboxFsMount): number {
  const byLength = b.containerRoot.length - a.containerRoot.length;
  if (byLength !== 0) {
    return byLength;
  }
  // Keep resolver ordering aligned with docker mount precedence for default
  // workspace mounts, but never let bridge policy classify protected skills
  // as writable.
  return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}

function compareMountsByHostPath(a: SandboxFsMount, b: SandboxFsMount): number {
  const byLength = b.hostRoot.length - a.hostRoot.length;
  if (byLength !== 0) {
    return byLength;
  }
  return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}

function mountSourcePriority(source: SandboxFsMount["source"]): number {
  if (source === "protectedSkill") {
    return 3;
  }
  if (source === "bind") {
    return 2;
  }
  if (source === "agent") {
    return 1;
  }
  return 0;
}

function dedupeMounts(mounts: SandboxFsMount[]): SandboxFsMount[] {
  const seen = new Set<string>();
  const deduped: SandboxFsMount[] = [];
  for (const mount of mounts) {
    const key = `${mount.hostRoot}=>${mount.containerRoot}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(mount);
  }
  return deduped;
}

function findMountByContainerPath(mounts: SandboxFsMount[], target: string): SandboxFsMount | null {
  for (const mount of mounts) {
    if (isPathInsideContainerRoot(mount.containerRoot, target)) {
      return mount;
    }
  }
  return null;
}

function findMountByHostPath(mounts: SandboxFsMount[], target: string): SandboxFsMount | null {
  for (const mount of mounts) {
    if (isPathInsideHost(mount.hostRoot, target)) {
      return mount;
    }
  }
  return null;
}

function isPathInsideHost(root: string, target: string): boolean {
  const canonicalRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(root));
  const resolvedTarget = path.resolve(target);
  // Preserve the final path segment so pre-existing symlink leaves are validated
  // by the dedicated symlink guard later in the bridge flow.
  const canonicalTargetParent = resolveSandboxHostPathViaExistingAncestor(
    path.dirname(resolvedTarget),
  );
  const canonicalTarget = path.resolve(canonicalTargetParent, path.basename(resolvedTarget));
  return isPathInside(canonicalRoot, canonicalTarget);
}

function isHostPathWithinOrEqual(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toHostSegments(relativePosix: string): string[] {
  return relativePosix.split("/").filter(Boolean);
}

function toDisplayRelative(params: {
  containerPath: string;
  defaultContainerRoot: string;
}): string {
  const rel = path.posix.relative(params.defaultContainerRoot, params.containerPath);
  if (!rel) {
    return "";
  }
  if (!relativePathEscapesContainerRoot(rel)) {
    return rel;
  }
  return params.containerPath;
}

function normalizePosixInput(value: string): string {
  return value.replace(/\\/g, "/").trim();
}
