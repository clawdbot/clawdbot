// Openshell plugin module implements fs bridge behavior.
import fsPromises from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { createWritableRenameTargetResolver } from "openclaw/plugin-sdk/sandbox";
import { FsSafeError, isPathInside } from "openclaw/plugin-sdk/security-runtime";
import type { OpenShellFsBridgeContext, OpenShellSandboxBackend } from "./backend.types.js";

type ResolvedMountPath = SandboxResolvedPath & {
  mountHostRoot: string;
  writable: boolean;
  source: "workspace" | "agent" | "protectedSkill";
};

type FsSafeRoot = Awaited<ReturnType<typeof fsRoot>>;
type FsSafeStat = Awaited<ReturnType<FsSafeRoot["stat"]>>;

const MATERIALIZED_SKILLS_CONTAINER_PARTS = [".openclaw", "sandbox-skills", "skills"] as const;

export function createOpenShellFsBridge(params: {
  sandbox: OpenShellFsBridgeContext;
  backend: OpenShellSandboxBackend;
}): SandboxFsBridge {
  return new OpenShellFsBridge(params.sandbox, params.backend);
}

class OpenShellFsBridge implements SandboxFsBridge {
  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(
    private readonly sandbox: OpenShellFsBridgeContext,
    private readonly backend: OpenShellSandboxBackend,
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      hostPath: target.hostPath,
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    let opened: Awaited<ReturnType<Awaited<ReturnType<typeof fsRoot>>["open"]>>;
    try {
      await assertLocalPathSafety({
        target,
        root: target.mountHostRoot,
        allowMissingLeaf: false,
        allowFinalSymlinkForUnlink: false,
      });
      const root = await fsRoot(target.mountHostRoot);
      opened = await root.open(path.relative(target.mountHostRoot, hostPath), {
        hardlinks: "reject",
      });
      try {
        return (await opened.handle.readFile()) as Buffer;
      } finally {
        await opened.handle.close();
      }
    } catch (err) {
      throw new Error(
        `Sandbox boundary checks failed; cannot read files: ${target.containerPath}`,
        { cause: err },
      );
    }
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "write files");
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const root = await fsRoot(target.mountHostRoot);
    await root.write(path.relative(target.mountHostRoot, hostPath), buffer, {
      mkdir: params.mkdir,
    });
    await this.backend.syncLocalPathToRemote(hostPath, target.containerPath);
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "create directories");
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    await this.backend.mkdirpRemotePath(target.containerPath, params.signal);
    await mkdirLocalRootPath({ hostPath, target });
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "remove files");
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: params.force !== false,
      allowFinalSymlinkForUnlink: true,
    });
    await this.backend.removeRemotePath(target.containerPath, {
      recursive: params.recursive ?? false,
      signal: params.signal,
      ignoreMissing: params.force !== false,
    });
    await removeLocalRootPath({
      force: params.force,
      hostPath,
      recursive: params.recursive,
      target,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { from, to } = this.resolveRenameTargets(params);
    const fromHostPath = this.requireHostPath(from);
    const toHostPath = this.requireHostPath(to);
    await assertLocalPathSafety({
      target: from,
      root: from.mountHostRoot,
      allowMissingLeaf: false,
      allowFinalSymlinkForUnlink: true,
    });
    await assertLocalPathSafety({
      target: to,
      root: to.mountHostRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    await assertRenameSourceSupported(fromHostPath);
    if (from.mountHostRoot !== to.mountHostRoot) {
      throw new Error("OpenShell cross-root mirror renames require pinned fs-safe support");
    }
    await assertSameDeviceRenameSupported({
      fromHostPath,
      root: from.mountHostRoot,
      toHostPath,
    });
    await this.backend.renameRemotePath(from.containerPath, to.containerPath, params.signal);
    await moveLocalRootPath({ from, fromHostPath, to, toHostPath });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    const stats = await fsPromises.lstat(hostPath).catch(() => null);
    if (!stats) {
      return null;
    }
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: false,
      allowFinalSymlinkForUnlink: false,
    });
    return {
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  private ensureWritable(target: ResolvedMountPath, action: string) {
    if (this.sandbox.workspaceAccess !== "rw" || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private requireHostPath(target: ResolvedMountPath): string {
    if (!target.hostPath) {
      throw new Error(
        `OpenShell mirror bridge requires a local host path: ${target.containerPath}`,
      );
    }
    return target.hostPath;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedMountPath {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
    const hasAgentMount = this.sandbox.workspaceAccess !== "none" && workspaceRoot !== agentRoot;
    const agentContainerRoot = (this.backend.remoteAgentWorkspaceDir || "/agent").replace(
      /\\/g,
      "/",
    );
    const workspaceContainerRoot = this.sandbox.containerWorkdir.replace(/\\/g, "/");
    const skillsRoot = this.sandbox.skillsWorkspaceDir
      ? path.resolve(this.sandbox.skillsWorkspaceDir, "skills")
      : undefined;
    const skillsContainerRoot = path.posix.join(
      workspaceContainerRoot,
      ...MATERIALIZED_SKILLS_CONTAINER_PARTS,
    );
    const workspaceSkillsShadowRoot = path.resolve(
      workspaceRoot,
      ...MATERIALIZED_SKILLS_CONTAINER_PARTS,
    );
    const input = params.filePath.trim();

    if (skillsRoot && this.sandbox.workspaceAccess === "rw") {
      const protectedSkillTarget = resolveProtectedSkillTarget({
        input,
        skillsRoot,
        skillsContainerRoot,
      });
      if (protectedSkillTarget) {
        return protectedSkillTarget;
      }
    }

    if (input.startsWith(`${workspaceContainerRoot}/`) || input === workspaceContainerRoot) {
      const relative = path.posix.relative(workspaceContainerRoot, input) || "";
      const hostPath = relative
        ? path.resolve(workspaceRoot, ...relative.split("/"))
        : workspaceRoot;
      return {
        hostPath,
        relativePath: relative,
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        mountHostRoot: workspaceRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "workspace",
      };
    }

    if (
      hasAgentMount &&
      (input.startsWith(`${agentContainerRoot}/`) || input === agentContainerRoot)
    ) {
      const relative = path.posix.relative(agentContainerRoot, input) || "";
      const hostPath = relative ? path.resolve(agentRoot, ...relative.split("/")) : agentRoot;
      return {
        hostPath,
        relativePath: relative ? agentContainerRoot + "/" + relative : agentContainerRoot,
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        mountHostRoot: agentRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "agent",
      };
    }

    const cwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
    const hostPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);

    if (skillsRoot && this.sandbox.workspaceAccess === "rw") {
      const protectedSkillShadowTarget = resolveProtectedSkillShadowTarget({
        hostPath,
        workspaceSkillsShadowRoot,
        skillsRoot,
        skillsContainerRoot,
      });
      if (protectedSkillShadowTarget) {
        return protectedSkillShadowTarget;
      }
    }

    if (isPathInside(workspaceRoot, hostPath)) {
      const relative = path.relative(workspaceRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        hostPath,
        relativePath: relative,
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        mountHostRoot: workspaceRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "workspace",
      };
    }

    if (skillsRoot && this.sandbox.workspaceAccess === "rw" && isPathInside(skillsRoot, hostPath)) {
      const relative = path.relative(skillsRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        hostPath,
        relativePath: relative
          ? path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS, relative)
          : path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS),
        containerPath: relative
          ? path.posix.join(skillsContainerRoot, relative)
          : skillsContainerRoot,
        mountHostRoot: skillsRoot,
        writable: false,
        source: "protectedSkill",
      };
    }

    if (hasAgentMount && isPathInside(agentRoot, hostPath)) {
      const relative = path.relative(agentRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        hostPath,
        relativePath: relative ? `${agentContainerRoot}/${relative}` : agentContainerRoot,
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        mountHostRoot: agentRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "agent",
      };
    }

    throw new Error(`Path escapes sandbox root (${workspaceRoot}): ${params.filePath}`);
  }
}

async function mkdirLocalRootPath(params: {
  target: ResolvedMountPath;
  hostPath: string;
}): Promise<void> {
  const relativePath = relativeToRoot(params.target, params.hostPath);
  if (!relativePath) {
    return;
  }
  const root = await fsRoot(params.target.mountHostRoot);
  await root.mkdir(relativePath);
}

async function removeLocalRootPath(params: {
  target: ResolvedMountPath;
  hostPath: string;
  recursive?: boolean;
  force?: boolean;
}): Promise<void> {
  const root = await fsRoot(params.target.mountHostRoot);
  const relativePath = relativeToRoot(params.target, params.hostPath);
  try {
    if (params.force === false) {
      await fsPromises.lstat(params.hostPath);
    }
    if (params.recursive) {
      const stats = await fsPromises.lstat(params.hostPath).catch((err: unknown) => {
        if (isNotFoundError(err)) {
          return null;
        }
        throw err;
      });
      if (stats?.isSymbolicLink()) {
        await root.remove(relativePath);
        return;
      }
      await removeRootTree(root, relativePath);
      return;
    }
    await root.remove(relativePath);
  } catch (err) {
    if (params.force !== false && isNotFoundError(err)) {
      return;
    }
    throw err;
  }
}

async function removeRootTree(
  root: FsSafeRoot,
  relativePath: string,
  knownStats?: FsSafeStat,
): Promise<void> {
  const stats = knownStats ?? (await root.stat(relativePath));
  if (stats.isDirectory && !stats.isSymbolicLink) {
    const entries = await root.list(relativePath, { withFileTypes: true });
    for (const entry of entries) {
      await removeRootTree(root, path.join(relativePath, entry.name), entry);
    }
    if (!relativePath) {
      return;
    }
  }
  await root.remove(relativePath);
}

async function moveLocalRootPath(params: {
  from: ResolvedMountPath;
  fromHostPath: string;
  to: ResolvedMountPath;
  toHostPath: string;
}): Promise<void> {
  const root = await fsRoot(params.from.mountHostRoot);
  const fromRelativePath = relativeToRoot(params.from, params.fromHostPath);
  const toRelativePath = relativeToRoot(params.to, params.toHostPath);
  await mkdirParentPath(root, toRelativePath);
  await root.move(fromRelativePath, toRelativePath, { overwrite: true });
}

async function mkdirParentPath(root: FsSafeRoot, relativePath: string): Promise<void> {
  const parentPath = path.dirname(relativePath);
  if (parentPath === "." || parentPath === "") {
    return;
  }
  await root.mkdir(parentPath);
}

function relativeToRoot(target: ResolvedMountPath, hostPath: string): string {
  const relativePath = path.relative(target.mountHostRoot, hostPath);
  return relativePath === "." ? "" : relativePath;
}

async function assertRenameSourceSupported(fromHostPath: string): Promise<void> {
  const stats = await fsPromises.lstat(fromHostPath);
  if (stats.isSymbolicLink()) {
    throw new Error("Sandbox symlink rename sources are not supported by the local mirror bridge");
  }
  if (stats.isFile() && stats.nlink > 1) {
    throw new Error(
      "Sandbox hardlinked rename sources are not supported by the local mirror bridge",
    );
  }
}

async function assertSameDeviceRenameSupported(params: {
  fromHostPath: string;
  root: string;
  toHostPath: string;
}): Promise<void> {
  const sourceStats = await fsPromises.lstat(params.fromHostPath);
  const destinationParentStats = await nearestExistingDirectoryStats({
    root: params.root,
    targetPath: path.dirname(params.toHostPath),
  });
  if (sourceStats.dev !== destinationParentStats.dev) {
    throw new Error("OpenShell cross-device mirror renames require pinned fs-safe support");
  }
}

async function nearestExistingDirectoryStats(params: {
  root: string;
  targetPath: string;
}): Promise<Awaited<ReturnType<typeof fsPromises.lstat>>> {
  const rootPath = path.resolve(params.root);
  let cursor = path.resolve(params.targetPath);
  while (isPathInside(rootPath, cursor)) {
    const stats = await fsPromises.lstat(cursor).catch((err: unknown) => {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    });
    if (stats) {
      if (!stats.isDirectory()) {
        throw new Error(`Sandbox rename destination parent is not a directory: ${cursor}`);
      }
      return stats;
    }
    const next = path.dirname(cursor);
    if (next === cursor) {
      break;
    }
    cursor = next;
  }
  return await fsPromises.lstat(rootPath);
}

function isNotFoundError(err: unknown): boolean {
  return (
    (err instanceof FsSafeError && err.code === "not-found") ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT")
  );
}

function resolveProtectedSkillTarget(params: {
  input: string;
  skillsRoot: string;
  skillsContainerRoot: string;
}): ResolvedMountPath | null {
  const relativeRoot = path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS);
  const normalizedInput = path.posix.normalize(params.input.replace(/\\/g, "/"));
  const isAbsoluteContainer =
    normalizedInput === params.skillsContainerRoot ||
    normalizedInput.startsWith(`${params.skillsContainerRoot}/`);
  const isRelativeContainer =
    normalizedInput === relativeRoot || normalizedInput.startsWith(`${relativeRoot}/`);
  if (!isAbsoluteContainer && !isRelativeContainer) {
    return null;
  }

  const relative = isAbsoluteContainer
    ? path.posix.relative(params.skillsContainerRoot, normalizedInput)
    : path.posix.relative(relativeRoot, normalizedInput);
  const safeRelative = relative === "." ? "" : relative;
  const hostPath = safeRelative
    ? path.resolve(params.skillsRoot, ...safeRelative.split("/"))
    : params.skillsRoot;
  return {
    hostPath,
    relativePath: safeRelative ? path.posix.join(relativeRoot, safeRelative) : relativeRoot,
    containerPath: safeRelative
      ? path.posix.join(params.skillsContainerRoot, safeRelative)
      : params.skillsContainerRoot,
    mountHostRoot: params.skillsRoot,
    writable: false,
    source: "protectedSkill",
  };
}

function resolveProtectedSkillShadowTarget(params: {
  hostPath: string;
  workspaceSkillsShadowRoot: string;
  skillsRoot: string;
  skillsContainerRoot: string;
}): ResolvedMountPath | null {
  if (!isPathInside(params.workspaceSkillsShadowRoot, params.hostPath)) {
    return null;
  }

  const relative = path
    .relative(params.workspaceSkillsShadowRoot, params.hostPath)
    .split(path.sep)
    .join(path.posix.sep);
  const safeRelative = relative === "." ? "" : relative;
  const hostPath = safeRelative
    ? path.resolve(params.skillsRoot, ...safeRelative.split("/"))
    : params.skillsRoot;
  const relativeRoot = path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS);
  return {
    hostPath,
    relativePath: safeRelative ? path.posix.join(relativeRoot, safeRelative) : relativeRoot,
    containerPath: safeRelative
      ? path.posix.join(params.skillsContainerRoot, safeRelative)
      : params.skillsContainerRoot,
    mountHostRoot: params.skillsRoot,
    writable: false,
    source: "protectedSkill",
  };
}

async function assertLocalPathSafety(params: {
  target: ResolvedMountPath;
  root: string;
  allowMissingLeaf: boolean;
  allowFinalSymlinkForUnlink: boolean;
}): Promise<void> {
  if (!params.target.hostPath) {
    throw new Error(`Missing local host path for ${params.target.containerPath}`);
  }
  const canonicalRoot = await fsPromises
    .realpath(params.root)
    .catch(() => path.resolve(params.root));
  const targetStats = await fsPromises.lstat(params.target.hostPath).catch(() => null);
  const candidate =
    params.allowFinalSymlinkForUnlink && targetStats?.isSymbolicLink()
      ? path.resolve(canonicalRoot, path.relative(params.root, params.target.hostPath))
      : await resolveCanonicalCandidate(params.target.hostPath);
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`,
    );
  }

  const relative = path.relative(params.root, params.target.hostPath);
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = params.root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stats = await fsPromises.lstat(cursor).catch(() => null);
    if (!stats) {
      if (index === segments.length - 1 && params.allowMissingLeaf) {
        return;
      }
      continue;
    }
    const isFinal = index === segments.length - 1;
    if (stats.isSymbolicLink() && (!isFinal || !params.allowFinalSymlinkForUnlink)) {
      throw new Error(`Sandbox boundary checks failed: ${params.target.containerPath}`);
    }
  }
}

async function resolveCanonicalCandidate(targetPath: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    const exists = await fsPromises
      .lstat(cursor)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const canonical = await fsPromises.realpath(cursor).catch(() => cursor);
      return path.resolve(canonical, ...missing);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return path.resolve(cursor, ...missing);
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}
