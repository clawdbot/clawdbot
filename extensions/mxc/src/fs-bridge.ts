import path from "node:path";
import { removePathWithinRoot, root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import {
  createWritableRenameTargetResolver,
  type SandboxBackendHandle,
  type SandboxFsBridge,
  type SandboxFsStat,
  type SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import {
  resolveMxcReadOnlySkillMounts,
  type MxcReadOnlySkillMount,
} from "./workspace-skill-mounts.js";

type MxcFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type MxcFsMount = {
  hostRoot: string;
  containerRoot: string;
  writable: boolean;
};

type ResolvedMxcPath = SandboxResolvedPath & {
  hostPath: string;
  mount: MxcFsMount;
  mountRelativePath: string;
  writable: boolean;
};

export function createMxcFsBridge(params: { sandbox: MxcFsBridgeContext }): SandboxFsBridge {
  return new MxcFsBridge(params.sandbox);
}

class MxcFsBridge implements SandboxFsBridge {
  private readonly defaultContainerRoot = path.resolve(this.sandbox.containerWorkdir);

  private readonly protectedSkillMounts = resolveMxcProtectedSkillMounts(this.sandbox);

  private readonly workspaceMounts = resolveWorkspaceMounts(this.sandbox);

  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(private readonly sandbox: MxcFsBridgeContext) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      hostPath: target.hostPath,
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  async readFile(params: { filePath: string; cwd?: string }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    return (await (
      await fsRoot(target.mount.hostRoot)
    ).readBytes(target.mountRelativePath, {
      hardlinks: "reject",
    })) as Buffer;
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "write files");
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    await (
      await fsRoot(target.mount.hostRoot)
    ).write(target.mountRelativePath, buffer, {
      mkdir: params.mkdir !== false,
    });
  }

  async mkdirp(params: { filePath: string; cwd?: string }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "create directories");
    if (target.mountRelativePath.length === 0) {
      return;
    }
    await (await fsRoot(target.mount.hostRoot)).mkdir(target.mountRelativePath);
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "remove files");
    await removePathWithinRoot({
      rootDir: target.mount.hostRoot,
      relativePath: target.mountRelativePath,
      recursive: params.recursive,
      force: params.force ?? false,
    });
  }

  async rename(params: { from: string; to: string; cwd?: string }): Promise<void> {
    const { from: source, to: target } = this.resolveRenameTargets(params);
    if (!isSameMountRoot(source.mount.hostRoot, target.mount.hostRoot)) {
      throw new Error(
        `Sandbox rename must stay within the same mounted root: ${source.containerPath} -> ${target.containerPath}`,
      );
    }

    const root = await fsRoot(source.mount.hostRoot);
    const targetParent = resolveRelativeParentPath(target.mountRelativePath);
    if (targetParent) {
      await root.mkdir(targetParent);
    }
    await root.move(source.mountRelativePath, target.mountRelativePath, { overwrite: true });
  }

  async stat(params: { filePath: string; cwd?: string }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const root = await fsRoot(target.mount.hostRoot);
    if (!(await root.exists(target.mountRelativePath))) {
      return null;
    }

    const stats = await root.stat(target.mountRelativePath);
    return {
      type: stats.isDirectory ? "directory" : stats.isFile ? "file" : "other",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedMxcPath {
    const input = params.filePath.trim();
    const cwd = params.cwd?.trim() ? path.resolve(params.cwd) : this.defaultContainerRoot;
    const containerPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);

    return (
      this.resolveMountedTarget(containerPath, this.protectedSkillMounts) ??
      this.resolveMountedTarget(containerPath, this.workspaceMounts) ??
      this.throwSandboxRootEscape(params.filePath)
    );
  }

  private resolveMountedTarget(
    containerPath: string,
    mounts: readonly MxcFsMount[],
  ): ResolvedMxcPath | null {
    for (const mount of mounts) {
      if (!isPathInside(mount.containerRoot, containerPath)) {
        continue;
      }

      const mountRelativePath = path.relative(mount.containerRoot, containerPath);
      return {
        hostPath: path.join(mount.hostRoot, mountRelativePath),
        relativePath: mountRelativePath,
        containerPath,
        mount,
        mountRelativePath,
        writable: mount.writable,
      };
    }
    return null;
  }

  private throwSandboxRootEscape(filePath: string): never {
    const allowedRoots = [
      ...new Set(this.workspaceMounts.map((mount) => mount.containerRoot)),
    ].join(", ");
    throw new Error(
      `Path escapes sandbox root (${allowedRoots}; container root ${this.sandbox.containerWorkdir}): ${filePath}. Use a path under ${this.sandbox.containerWorkdir}\\ instead.`,
    );
  }

  private ensureWritable(target: ResolvedMxcPath, action: string): void {
    if (!target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }
}

function resolveWorkspaceMounts(sandbox: MxcFsBridgeContext): readonly MxcFsMount[] {
  const containerRoot = path.resolve(sandbox.containerWorkdir);
  const workspaceDir = path.resolve(sandbox.workspaceDir);
  const agentWorkspaceDir = path.resolve(sandbox.agentWorkspaceDir);
  const mounts: MxcFsMount[] =
    sandbox.workspaceAccess === "rw"
      ? [
          {
            hostRoot: agentWorkspaceDir,
            containerRoot,
            writable: true,
          },
        ]
      : [
          {
            hostRoot: workspaceDir,
            containerRoot,
            writable: false,
          },
        ];

  if (
    sandbox.workspaceAccess === "ro" &&
    normalizePathForComparison(agentWorkspaceDir) !== normalizePathForComparison(workspaceDir)
  ) {
    mounts.push({
      hostRoot: agentWorkspaceDir,
      containerRoot: agentWorkspaceDir,
      writable: false,
    });
  }

  return dedupeAndSortMounts(mounts);
}

function resolveMxcProtectedSkillMounts(sandbox: MxcFsBridgeContext): readonly MxcFsMount[] {
  return dedupeAndSortMounts(
    resolveMxcReadOnlySkillMounts({
      agentWorkspaceDir: sandbox.agentWorkspaceDir,
      skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
      workdir: sandbox.containerWorkdir,
      workspaceAccess: sandbox.workspaceAccess,
    }).map(normalizeMxcProtectedSkillMount),
  );
}

function normalizeMxcProtectedSkillMount(mount: MxcReadOnlySkillMount): MxcFsMount {
  return {
    hostRoot: path.resolve(mount.hostPath),
    containerRoot: path.resolve(mount.containerPath),
    writable: false,
  };
}

function dedupeAndSortMounts(mounts: readonly MxcFsMount[]): readonly MxcFsMount[] {
  const deduped = new Map<string, MxcFsMount>();
  for (const mount of mounts) {
    const key = `${normalizePathForComparison(mount.hostRoot)}::${normalizePathForComparison(
      mount.containerRoot,
    )}`;
    if (!deduped.has(key)) {
      deduped.set(key, mount);
    }
  }
  return [...deduped.values()].toSorted((left, right) => {
    const lengthDiff = right.containerRoot.length - left.containerRoot.length;
    if (lengthDiff !== 0) {
      return lengthDiff;
    }
    return right.hostRoot.length - left.hostRoot.length;
  });
}

function resolveRelativeParentPath(relativePath: string): string | null {
  const parent = path.dirname(relativePath);
  return parent === "." || parent === "" ? null : parent;
}

function isSameMountRoot(first: string, second: string): boolean {
  return normalizePathForComparison(first) === normalizePathForComparison(second);
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
