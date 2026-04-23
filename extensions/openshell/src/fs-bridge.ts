import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "openclaw/plugin-sdk/infra-runtime";
import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { createWritableRenameTargetResolver } from "openclaw/plugin-sdk/sandbox";
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
    const handle = await openPinnedReadableFile({
      absolutePath: hostPath,
      rootPath: target.mountHostRoot,
      containerPath: target.containerPath,
    });
    try {
      return (await handle.readFile()) as Buffer;
    } finally {
      await handle.close();
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
    await writeFileWithinRoot({
      rootDir: target.mountHostRoot,
      relativePath: path.relative(target.mountHostRoot, hostPath),
      data: buffer,
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

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

async function openPinnedReadableFile(params: {
  absolutePath: string;
  rootPath: string;
  containerPath: string;
}): Promise<FileHandle> {
  // The literal root is what `resolveTarget` joins caller-provided relative
  // paths against, so pre-open containment must be checked in literal form.
  // The canonical root is derived separately and used for the post-open
  // path checks (fd-path readlink and realpath cross-check), so a workspace
  // that is itself configured as a symlink still works.
  const literalRoot = path.resolve(params.rootPath);
  const canonicalRoot = await fsPromises.realpath(literalRoot).catch(() => literalRoot);
  const literalPath = path.resolve(params.absolutePath);
  // Cheap string-prefix check on the caller-provided absolute path; no
  // filesystem state is read here, so there is no TOCTOU window. Deeper
  // checks run after the fd is pinned.
  if (!isPathInside(literalRoot, literalPath)) {
    throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.containerPath}`);
  }
  const { flags: openReadFlags, supportsNoFollow } = resolveOpenReadFlags();
  // Open first so every later check runs against an fd that is already pinned
  // to one specific inode. `O_NOFOLLOW` prevents the final path component from
  // being a symlink; the ancestor walk below handles parent-directory symlink
  // swaps on platforms where fd-path readlink is not available.
  const handle = await fsPromises.open(literalPath, openReadFlags);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
    }
    if (openedStat.nlink > 1) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
    }
    const resolvedPath = await resolveOpenedReadablePath(handle.fd);
    if (resolvedPath !== null) {
      // Primary guarantee on Linux: the fd's resolved path is derived from the
      // kernel, so a parent-directory swap cannot make this return a stale path.
      if (!isPathInside(canonicalRoot, resolvedPath)) {
        throw new Error(
          `Sandbox boundary checks failed; cannot read files: ${params.containerPath}`,
        );
      }
      return handle;
    }
    // Fallback for platforms where fd-path readlink is unavailable. On macOS,
    // `/dev/fd/N` is a character device so readlink returns EINVAL; on Windows
    // there is no `/proc` equivalent. With no kernel-backed path readback we
    // must prove the pinned fd is in-root without trusting a separate
    // `realpath` + `lstat` pair that would race between the two awaits. Walk
    // every ancestor between `literalRoot` and `literalPath` — the actual
    // on-disk chain — and reject if any ancestor is a symlink, then use a
    // single `stat` call to confirm that the path still resolves to the
    // same file the fd has pinned. `fs.promises.stat` resolves the path and
    // returns the final file's identity in one syscall, so there is no
    // between-await window for an attacker to race.
    await assertAncestorChainHasNoSymlinks(literalRoot, literalPath, params.containerPath, {
      // On platforms where `O_NOFOLLOW` is unavailable (Windows), the open
      // call would have transparently followed a final-component symlink, so
      // the ancestor walk has to lstat the leaf as well.
      includeLeaf: !supportsNoFollow,
    });
    const currentResolvedStat = await fsPromises.stat(literalPath);
    if (!sameFileIdentity(currentResolvedStat, openedStat)) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
    }
    // Belt-and-suspenders: re-fstat the pinned fd after the identity check and
    // confirm the file type and link count are still trustworthy. A hardlink
    // that appeared between the initial fstat and here is not exploitable for
    // the read (the fd is already pinned to the original inode), but failing
    // closed here keeps the guarantee simple: the bytes we return always come
    // from a file that was a single-linked regular file at verification time.
    const postCheckStat = await handle.stat();
    if (!postCheckStat.isFile() || postCheckStat.nlink > 1) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Walks each directory between canonicalRoot (exclusive) and
// targetAbsolutePath, `lstat`'ing each segment. Rejects if any intermediate
// segment is a symlink or a non-directory. By default the final component is
// not walked because `O_NOFOLLOW` already protects it on the open call. Pass
// `includeLeaf: true` on platforms where `O_NOFOLLOW` is unavailable
// (Windows) so a symlinked leaf cannot be followed silently by `open`.
async function assertAncestorChainHasNoSymlinks(
  canonicalRoot: string,
  targetAbsolutePath: string,
  containerPath: string,
  options: { includeLeaf?: boolean } = {},
): Promise<void> {
  const relative = path.relative(canonicalRoot, targetAbsolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  const lastIndex = options.includeLeaf ? segments.length : segments.length - 1;
  let cursor = canonicalRoot;
  for (let i = 0; i < lastIndex; i += 1) {
    cursor = path.join(cursor, segments[i]);
    const stat = await fsPromises.lstat(cursor).catch(() => null);
    if (!stat) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${containerPath}`);
    }
    const isLeaf = i === segments.length - 1;
    if (stat.isSymbolicLink()) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${containerPath}`);
    }
    if (!isLeaf && !stat.isDirectory()) {
      throw new Error(`Sandbox boundary checks failed; cannot read files: ${containerPath}`);
    }
  }
}

type ReadOpenFlagsResolution = { flags: number; supportsNoFollow: boolean };

let readOpenFlagsResolverForTest: (() => ReadOpenFlagsResolution) | undefined;

function resolveOpenReadFlags(): ReadOpenFlagsResolution {
  if (readOpenFlagsResolverForTest) {
    return readOpenFlagsResolverForTest();
  }
  const closeOnExec = (fs.constants as Record<string, number>).O_CLOEXEC ?? 0;
  const supportsNoFollow = typeof fs.constants.O_NOFOLLOW === "number";
  const noFollow = supportsNoFollow ? fs.constants.O_NOFOLLOW : 0;
  return {
    flags: fs.constants.O_RDONLY | noFollow | closeOnExec,
    supportsNoFollow,
  };
}

/**
 * Test-only seam for forcing the open-flag/`O_NOFOLLOW` resolution. Used to
 * exercise the Windows-style fallback (no `O_NOFOLLOW`, ancestor walk
 * includes the leaf) on platforms where `fs.constants.O_NOFOLLOW` is a
 * non-configurable native data property and cannot be patched directly.
 *
 * @internal
 */
export function setReadOpenFlagsResolverForTest(
  resolver: (() => ReadOpenFlagsResolution) | undefined,
): void {
  readOpenFlagsResolverForTest = resolver;
}

// Resolves the absolute path associated with an open fd via the kernel-backed
// `/proc/self/fd/<fd>` (Linux) or `/dev/fd/<fd>` (some BSDs). Returns null
// when no fd-path endpoint is available. Note: on macOS `/dev/fd/N` is a
// character device rather than a symlink, so `readlink` fails with EINVAL
// there and the caller must use the ancestor-walk fallback instead.
async function resolveOpenedReadablePath(fd: number): Promise<string | null> {
  for (const fdPath of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
    try {
      const openedPath = await fsPromises.readlink(fdPath);
      return normalizeOpenedReadablePath(openedPath);
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeOpenedReadablePath(openedPath: string): string {
  const deletedSuffix = " (deleted)";
  const withoutDeletedSuffix = openedPath.endsWith(deletedSuffix)
    ? openedPath.slice(0, -deletedSuffix.length)
    : openedPath;
  return path.resolve(withoutDeletedSuffix);
}

// File identity comparison with win32-aware `dev=0` handling, matching the
// shared `src/infra/file-identity.ts` contract. Kept local because extension
// production code is not allowed to reach into core `src/**` by relative
// import, and this helper is not yet part of the `openclaw/plugin-sdk/*`
// public surface. Stats here come from `FileHandle.stat()` / `fs.promises.stat()`
// with no `{ bigint: true }` option, so all fields are numbers.
function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (left.ino !== right.ino) {
    return false;
  }
  if (left.dev === right.dev) {
    return true;
  }
  // On Windows, path-based stat can report `dev=0` while fd-based stat reports
  // a real volume serial. Treat either side `dev=0` as "unknown device"
  // rather than a mismatch so legitimate Windows fallback reads are not
  // rejected.
  return platform === "win32" && (left.dev === 0 || right.dev === 0);
}
