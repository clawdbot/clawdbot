import os from "node:os";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveSandboxInputPath, resolveSandboxPath } from "../sandbox-paths.js";
import type { SandboxFsBridgeContext } from "./backend-handle.types.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { isPathInsideContainerRoot, normalizeContainerPath } from "./path-utils.js";

export type SandboxFsMount = {
  hostRoot: string;
  containerRoot: string;
  writable: boolean;
  source: "workspace" | "agent" | "bind";
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

export function parseSandboxBindMount(spec: string): ParsedBindMount | null {
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
  const optionParts = optionsToken
    ? optionsToken
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
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
      const rel = path.posix.relative(containerMount.containerRoot, inputPosix);
      const hostPath = rel
        ? path.resolve(containerMount.hostRoot, ...toHostSegments(rel))
        : containerMount.hostRoot;
      return {
        hostPath,
        containerPath: rel
          ? path.posix.join(containerMount.containerRoot, rel)
          : containerMount.containerRoot,
        relativePath: toDisplayRelative({
          containerPath: rel
            ? path.posix.join(containerMount.containerRoot, rel)
            : containerMount.containerRoot,
          defaultContainerRoot: params.defaultContainerRoot,
        }),
        writable: containerMount.writable,
      };
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
  // Keep resolver ordering aligned with docker mount precedence: custom binds can
  // intentionally shadow default workspace mounts at the same container path.
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
  if (!rel.startsWith("..") && !path.posix.isAbsolute(rel)) {
    return rel;
  }
  return params.containerPath;
}

function normalizePosixInput(value: string): string {
  return value.replace(/\\/g, "/").trim();
}
