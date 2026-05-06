import fsPromises from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { createWritableRenameTargetResolver } from "openclaw/plugin-sdk/sandbox";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import type { OpenShellFsBridgeContext, OpenShellSandboxBackend } from "./backend.types.js";
import { movePathWithCopyFallback } from "./mirror.js";

type ResolvedMountPath = SandboxResolvedPath & {
  mountHostRoot: string;
  writable: boolean;
  source: "workspace" | "agent";
};

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
    await fsPromises.mkdir(hostPath, { recursive: true });
    await this.backend.runRemoteShellScript({
      script: 'mkdir -p -- "$1"',
      args: [target.containerPath],
      signal: params.signal,
    });
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
    await fsPromises.rm(hostPath, {
      recursive: params.recursive ?? false,
      force: params.force !== false,
    });
    await this.backend.runRemoteShellScript({
      script: params.recursive
        ? 'rm -rf -- "$1"'
        : 'if [ -d "$1" ] && [ ! -L "$1" ]; then rmdir -- "$1"; elif [ -e "$1" ] || [ -L "$1" ]; then rm -f -- "$1"; fi',
      args: [target.containerPath],
      signal: params.signal,
      allowFailure: params.force !== false,
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
    await fsPromises.mkdir(path.dirname(toHostPath), { recursive: true });
    await movePathWithCopyFallback({ from: fromHostPath, to: toHostPath });
    await this.backend.runRemoteShellScript({
      script: 'mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"',
      args: [from.containerPath, to.containerPath],
      signal: params.signal,
    });
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
    const input = params.filePath.trim();

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
  const candidate = await resolveCanonicalCandidate(params.target.hostPath);
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`,
    );
  }

  const relative = path.relative(params.root, params.target.hostPath);
  const segments = relative
    .split(path.sep)
    .filter(Boolean)
    .slice(0, Math.max(0, relative.split(path.sep).filter(Boolean).length));
  let cursor = params.root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
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

export function setReadOpenFlagsResolverForTest(
  _resolver: (() => { flags: number; supportsNoFollow: boolean }) | undefined,
): void {
  // Retained for older OpenShell tests; pinned reads now delegate to fs-safe.
}
