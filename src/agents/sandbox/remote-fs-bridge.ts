/**
 * Remote shell-backed sandbox filesystem bridge.
 *
 * Resolves sandbox paths against uploaded remote mounts and performs guarded operations through backend shell commands.
 */
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import type {
  SandboxBackendCommandResult,
  SandboxFsBridgeContext,
} from "./backend-handle.types.js";
import { SANDBOX_FILE_IDENTITY } from "./file-mutation-identity.js";
import { SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL } from "./fs-bridge-mutation-helper.js";
import {
  SANDBOX_CREATE_EXISTS_EXIT_CODE,
  SANDBOX_READ_NOT_FOUND_EXIT_CODE,
} from "./fs-bridge-mutation-python.js";
import { createWritableRenameTargetResolver } from "./fs-bridge-rename-targets.js";
import {
  hasMultipleHardlinks,
  parseSandboxStatMtimeMs,
  parseSandboxStatSize,
} from "./fs-bridge-stat-parse.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.types.js";
import { isPathInsideContainerRoot, relativePathEscapesContainerRoot } from "./path-utils.js";
import {
  resolveRemoteCanonicalPath,
  type RemoteCanonicalPath,
} from "./remote-fs-bridge-canonical-path.js";
import {
  buildRemoteProtectedSkillRoots,
  compareRemoteMountsByContainerPath,
  compareRemoteMountsByLocalPath,
  normalizeContainerPath,
  type RemoteMountInfo,
  toPosixRelative,
} from "./remote-fs-bridge-paths.js";
import type { ResolvedRemotePath, RemoteShellSandboxHandle } from "./remote-fs-bridge.types.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./workspace-mounts.js";

export type { RemoteShellSandboxHandle } from "./remote-fs-bridge.types.js";

/** Create the filesystem bridge for remote shell-backed sandbox runtimes. */
export function createRemoteShellSandboxFsBridge(params: {
  sandbox: SandboxFsBridgeContext;
  runtime: RemoteShellSandboxHandle;
}): SandboxFsBridge {
  return new RemoteShellSandboxFsBridge(params.sandbox, params.runtime);
}

class RemoteShellSandboxFsBridge implements SandboxFsBridge {
  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(
    private readonly sandbox: SandboxFsBridgeContext,
    private readonly runtime: RemoteShellSandboxHandle,
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  async [SANDBOX_FILE_IDENTITY](params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const target = this.resolveTarget(params);
    const { canonicalPath } = await this.resolveCanonicalPath({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "identify files",
      signal: params.signal,
    });
    return canonicalPath;
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
    maxBytes?: number;
  }): Promise<Buffer> {
    if (
      params.maxBytes !== undefined &&
      (!Number.isSafeInteger(params.maxBytes) || params.maxBytes < 0)
    ) {
      throw new RangeError("Sandbox file read limit must be a non-negative safe integer.");
    }
    const target = this.resolveTarget(params);
    const relativePath = path.posix.relative(target.mountRootPath, target.containerPath);
    if (
      relativePath === "" ||
      relativePath === "." ||
      relativePathEscapesContainerRoot(relativePath)
    ) {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const pinned = await this.resolvePinnedTarget({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "read files",
      signal: params.signal,
    });
    const result = await this.runMutation({
      args: [
        "read",
        pinned.mountRootPath,
        pinned.relativeParentPath,
        pinned.basename,
        ...(params.maxBytes === undefined ? [] : [String(params.maxBytes)]),
      ],
      signal: params.signal,
      allowFailure: true,
    });
    if (result.code === SANDBOX_READ_NOT_FOUND_EXIT_CODE) {
      throw Object.assign(new Error(`Sandbox file not found: ${target.containerPath}`), {
        code: "ENOENT",
      });
    }
    if (result.code !== 0) {
      throw new Error(
        `Sandbox read failed (${result.code}): ${result.stderr.toString("utf8").trim()}`,
      );
    }
    return result.stdout;
  }

  async copyFile(params: {
    sourcePath: string;
    destinationPath: string;
    cwd?: string;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const source = this.resolveTarget({ filePath: params.sourcePath, cwd: params.cwd });
    const destination = this.resolveTarget({
      filePath: params.destinationPath,
      cwd: params.cwd,
    });
    await this.ensureRemoteWritable(destination, "copy files", params.signal);
    await this.assertNoHardlinkedFile({
      containerPath: destination.containerPath,
      action: "copy files",
      signal: params.signal,
    });
    const sourcePinned = await this.resolvePinnedTarget({
      containerPath: source.containerPath,
      mountRootPath: source.mountRootPath,
      action: "copy files",
      signal: params.signal,
    });
    const destinationPinned = await this.resolvePinnedTarget({
      containerPath: destination.containerPath,
      mountRootPath: destination.mountRootPath,
      action: "copy files",
      requireWritable: true,
      signal: params.signal,
    });
    await this.runMutation({
      args: [
        "copy",
        sourcePinned.mountRootPath,
        sourcePinned.relativeParentPath,
        sourcePinned.basename,
        destinationPinned.mountRootPath,
        destinationPinned.relativeParentPath,
        destinationPinned.basename,
        params.mkdir !== false ? "1" : "0",
      ],
      signal: params.signal,
    });
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
    await this.ensureRemoteWritable(target, "write files", params.signal);
    const pinned = await this.resolvePinnedTarget({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "write files",
      requireWritable: true,
      signal: params.signal,
    });
    await this.assertNoHardlinkedFile({
      containerPath: target.containerPath,
      action: "write files",
      signal: params.signal,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    await this.runMutation({
      args: [
        "write",
        pinned.mountRootPath,
        pinned.relativeParentPath,
        pinned.basename,
        params.mkdir !== false ? "1" : "0",
      ],
      stdin: buffer,
      signal: params.signal,
    });
  }

  async createFileExclusive(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    const target = this.resolveTarget(params);
    await this.ensureRemoteWritable(target, "create files", params.signal);
    const pinned = await this.resolvePinnedTarget({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "create files",
      requireWritable: true,
      signal: params.signal,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const result = await this.runMutation({
      args: [
        "create",
        pinned.mountRootPath,
        pinned.relativeParentPath,
        pinned.basename,
        params.mkdir !== false ? "1" : "0",
      ],
      stdin: buffer,
      allowFailure: true,
      signal: params.signal,
    });
    if (result.code === SANDBOX_CREATE_EXISTS_EXIT_CODE) {
      return "exists";
    }
    if (result.code !== 0) {
      throw new Error(
        `Sandbox create failed for ${target.containerPath}: ${result.stderr.toString("utf8").trim()}`,
      );
    }
    return "created";
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveTarget(params);
    await this.ensureRemoteWritable(target, "create directories", params.signal);
    const relativePath = path.posix.relative(target.mountRootPath, target.containerPath);
    if (relativePathEscapesContainerRoot(relativePath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot create directories: ${target.containerPath}`,
      );
    }
    if (relativePath === "" || relativePath === ".") {
      return;
    }
    const pinned = await this.resolvePinnedTarget({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "create directories",
      requireWritable: true,
      directory: true,
      signal: params.signal,
    });
    await this.runMutation({
      args: ["mkdirp", pinned.mountRootPath, pinned.relativeParentPath],
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
    await this.ensureRemoteWritable(target, "remove files", params.signal, params.recursive);
    const exists = await this.remotePathExists(target.containerPath, params.signal);
    if (!exists) {
      if (params.force === false) {
        throw new Error(`Sandbox path not found; cannot remove files: ${target.containerPath}`);
      }
      return;
    }
    const pinned = await this.resolvePinnedTarget({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "remove files",
      requireWritable: true,
      includeDescendants: params.recursive,
      allowFinalSymlinkForUnlink: true,
      signal: params.signal,
    });
    await this.runMutation({
      args: [
        "remove",
        pinned.mountRootPath,
        pinned.relativeParentPath,
        pinned.basename,
        params.recursive ? "1" : "0",
        params.force === false ? "0" : "1",
      ],
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
    await this.ensureRemoteWritable(from, "rename files", params.signal, true);
    await this.ensureRemoteWritable(to, "rename files", params.signal, true);
    const fromPinned = await this.resolvePinnedTarget({
      containerPath: from.containerPath,
      mountRootPath: from.mountRootPath,
      action: "rename files",
      requireWritable: true,
      includeDescendants: true,
      allowFinalSymlinkForUnlink: true,
      signal: params.signal,
    });
    const toPinned = await this.resolvePinnedTarget({
      containerPath: to.containerPath,
      mountRootPath: to.mountRootPath,
      action: "rename files",
      requireWritable: true,
      includeDescendants: true,
      signal: params.signal,
    });
    await this.runMutation({
      args: [
        "rename",
        fromPinned.mountRootPath,
        fromPinned.relativeParentPath,
        fromPinned.basename,
        toPinned.mountRootPath,
        toPinned.relativeParentPath,
        toPinned.basename,
        "1",
      ],
      signal: params.signal,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const exists = await this.remotePathExists(target.containerPath, params.signal);
    if (!exists) {
      return null;
    }
    const { canonicalPath } = await this.resolveCanonicalPath({
      containerPath: target.containerPath,
      mountRootPath: target.mountRootPath,
      action: "stat files",
      signal: params.signal,
    });
    await this.assertNoHardlinkedFile({
      containerPath: canonicalPath,
      action: "stat files",
      signal: params.signal,
    });
    const result = await this.runtime.runRemoteShellScript({
      script: 'set -eu\nLC_ALL=C stat -c "%F|%s|%y" -- "$1"',
      args: [canonicalPath],
      signal: params.signal,
    });
    const output = result.stdout.toString("utf8").trim();
    const [kindRaw = "", sizeRaw = "0", mtimeRaw = "0"] = output.split("|");
    return {
      type: kindRaw === "directory" ? "directory" : kindRaw === "regular file" ? "file" : "other",
      size: parseSandboxStatSize(sizeRaw),
      mtimeMs: parseSandboxStatMtimeMs(mtimeRaw),
    };
  }

  private getMounts(): RemoteMountInfo[] {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
    const workspaceContainerRoot = normalizeContainerPath(this.runtime.remoteWorkspaceDir);
    const agentContainerRoot = normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir);
    const hasAgentMount = this.sandbox.workspaceAccess !== "none" && agentRoot !== workspaceRoot;
    const mounts: RemoteMountInfo[] = [
      {
        localRoot: workspaceRoot,
        containerRoot: workspaceContainerRoot,
        writable: this.sandbox.workspaceAccess !== "ro",
        source: "workspace",
      },
    ];
    if (hasAgentMount) {
      mounts.push({
        localRoot: agentRoot,
        containerRoot: agentContainerRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "agent",
      });
    }
    for (const workdir of [
      workspaceContainerRoot,
      ...(hasAgentMount ? [agentContainerRoot] : []),
    ]) {
      mounts.push(
        ...resolveReadOnlyWorkspaceSkillMounts({ ...this.sandbox, workdir }).map(
          (mount): RemoteMountInfo => ({
            localRoot: mount.hostPath,
            containerRoot: mount.containerPath,
            writable: false,
            source: "protectedSkill",
          }),
        ),
      );
    }
    for (const resource of this.sandbox.readOnlyResourceMounts ?? []) {
      mounts.push({
        localRoot: resource.hostPath,
        containerRoot: resource.containerPath,
        writable: false,
        source: "protectedSkill",
      });
    }
    return mounts;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedRemotePath {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const mounts = this.getMounts();
    const input = params.filePath.trim();
    const inputPosix = input.replace(/\\/g, "/");
    const maybeContainerMount = path.posix.isAbsolute(inputPosix)
      ? this.resolveMountByContainerPath(mounts, normalizeContainerPath(inputPosix))
      : null;
    if (maybeContainerMount) {
      return this.toResolvedPath({
        mount: maybeContainerMount,
        containerPath: normalizeContainerPath(inputPosix),
      });
    }

    const hostCwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
    const hostCandidate = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(hostCwd, input);
    const hostMount = this.resolveMountByLocalPath(mounts, hostCandidate);
    if (hostMount) {
      const relative = toPosixRelative(hostMount.localRoot, hostCandidate);
      return this.toResolvedPath({
        mount: hostMount,
        containerPath: relative
          ? path.posix.join(hostMount.containerRoot, relative)
          : hostMount.containerRoot,
      });
    }

    if (params.cwd) {
      const cwdPosix = params.cwd.replace(/\\/g, "/");
      if (path.posix.isAbsolute(cwdPosix)) {
        const cwdContainer = normalizeContainerPath(cwdPosix);
        const cwdMount = this.resolveMountByContainerPath(mounts, cwdContainer);
        if (cwdMount) {
          const containerPath = normalizeContainerPath(
            path.posix.resolve(cwdContainer, inputPosix),
          );
          const targetMount = this.resolveMountByContainerPath(mounts, containerPath) ?? cwdMount;
          return this.toResolvedPath({
            mount: targetMount,
            containerPath,
          });
        }
      }
    }

    throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.filePath}`);
  }

  private toResolvedPath(params: {
    mount: RemoteMountInfo;
    containerPath: string;
  }): ResolvedRemotePath {
    const relative = path.posix.relative(params.mount.containerRoot, params.containerPath);
    if (relativePathEscapesContainerRoot(relative)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot access: ${params.containerPath}`,
      );
    }
    return {
      relativePath:
        params.mount.source === "workspace" || params.mount.source === "protectedSkill"
          ? relative === "."
            ? ""
            : path.posix.relative(this.runtime.remoteWorkspaceDir, params.containerPath)
          : relative === "."
            ? params.mount.containerRoot
            : `${params.mount.containerRoot}/${relative}`,
      containerPath: params.containerPath,
      writable: params.mount.writable,
      mountRootPath: params.mount.containerRoot,
      source: params.mount.source,
    };
  }

  private resolveMountByContainerPath(
    mounts: RemoteMountInfo[],
    containerPath: string,
  ): RemoteMountInfo | null {
    const ordered = [...mounts].toSorted(compareRemoteMountsByContainerPath);
    for (const mount of ordered) {
      if (isPathInsideContainerRoot(mount.containerRoot, containerPath)) {
        return mount;
      }
    }
    return null;
  }

  private resolveMountByLocalPath(
    mounts: RemoteMountInfo[],
    localPath: string,
  ): RemoteMountInfo | null {
    const ordered = [...mounts].toSorted(compareRemoteMountsByLocalPath);
    for (const mount of ordered) {
      if (isPathInside(mount.localRoot, localPath)) {
        return mount;
      }
    }
    return null;
  }

  private ensureWritable(target: ResolvedRemotePath, action: string) {
    if (this.sandbox.workspaceAccess === "ro" || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private async ensureRemoteWritable(
    target: ResolvedRemotePath,
    action: string,
    signal?: AbortSignal,
    includeDescendants = false,
  ): Promise<void> {
    this.ensureWritable(target, action);
    await this.assertRemoteProtectedPathWritable({
      containerPath: target.containerPath,
      action,
      signal,
      includeDescendants,
    });
  }

  private async assertRemoteProtectedPathWritable(params: {
    containerPath: string;
    action: string;
    displayPath?: string;
    signal?: AbortSignal;
    includeDescendants?: boolean;
  }): Promise<void> {
    const roots = new Set([
      ...this.getMounts()
        .filter((mount) => !mount.writable)
        .map((mount) => mount.containerRoot),
      ...buildRemoteProtectedSkillRoots({
        workspaceContainerRoot: normalizeContainerPath(this.runtime.remoteWorkspaceDir),
        agentContainerRoot: normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir),
        includeAgentMount:
          this.sandbox.workspaceAccess !== "none" &&
          path.resolve(this.sandbox.agentWorkspaceDir) !== path.resolve(this.sandbox.workspaceDir),
      }),
    ]);
    for (const root of roots) {
      if (
        (isPathInsideContainerRoot(root, params.containerPath) ||
          (params.includeDescendants && isPathInsideContainerRoot(params.containerPath, root))) &&
        (await this.remotePathExists(root, params.signal))
      ) {
        throw new Error(
          `Sandbox path is read-only; cannot ${params.action}: ${params.displayPath ?? params.containerPath}`,
        );
      }
    }
  }

  private async remotePathExists(containerPath: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.runtime.runRemoteShellScript({
      script: 'if [ -e "$1" ] || [ -L "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
      args: [containerPath],
      signal,
    });
    return result.stdout.toString("utf8").trim() === "1";
  }

  private async resolveCanonicalPath(params: {
    containerPath: string;
    mountRootPath: string;
    action: string;
    allowFinalSymlinkForUnlink?: boolean;
    signal?: AbortSignal;
  }): Promise<RemoteCanonicalPath> {
    return await resolveRemoteCanonicalPath({
      ...params,
      runRemoteShellScript: async (command) => await this.runtime.runRemoteShellScript(command),
    });
  }

  private async assertNoHardlinkedFile(params: {
    containerPath: string;
    action: string;
    signal?: AbortSignal;
  }): Promise<void> {
    // Remote mutation helpers pin by parent path. Rejecting hardlinked regular
    // files avoids editing another mount-visible name through the same inode.
    const result = await this.runtime.runRemoteShellScript({
      script: [
        'if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 0; fi',
        'stats=$(LC_ALL=C stat -c "%F|%h" -- "$1")',
        'printf "%s\\n" "$stats"',
      ].join("\n"),
      args: [params.containerPath],
      signal: params.signal,
      allowFailure: true,
    });
    const output = result.stdout.toString("utf8").trim();
    if (!output) {
      return;
    }
    const [kind = "", linksRaw = "1"] = output.split("|");
    if (kind === "regular file" && hasMultipleHardlinks(linksRaw)) {
      throw new Error(
        `Hardlinked path is not allowed under sandbox mount root: ${params.containerPath}`,
      );
    }
  }

  private async resolvePinnedTarget(params: {
    containerPath: string;
    mountRootPath: string;
    action: string;
    requireWritable?: boolean;
    directory?: boolean;
    includeDescendants?: boolean;
    allowFinalSymlinkForUnlink?: boolean;
    signal?: AbortSignal;
  }): Promise<{ mountRootPath: string; relativeParentPath: string; basename: string }> {
    const basename = params.directory ? "" : path.posix.basename(params.containerPath);
    if (!params.directory && (!basename || basename === "." || basename === "/")) {
      throw new Error(`Invalid sandbox entry target: ${params.containerPath}`);
    }
    const { canonicalPath, canonicalMountRoot, logicalPath } = await this.resolveCanonicalPath({
      // mkdirp pins the directory itself; file operations pin its parent and
      // retain no-follow handling for the final filename.
      containerPath: normalizeContainerPath(
        params.directory ? params.containerPath : path.posix.dirname(params.containerPath),
      ),
      mountRootPath: params.mountRootPath,
      action: params.action,
      allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
      signal: params.signal,
    });
    const mount = this.resolveMountByContainerPath(this.getMounts(), logicalPath);
    if (!mount) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    if (params.requireWritable && !mount.writable) {
      throw new Error(
        `Sandbox path is read-only; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    if (params.requireWritable) {
      await this.assertRemoteProtectedPathWritable({
        containerPath: path.posix.join(logicalPath, basename),
        action: params.action,
        displayPath: params.containerPath,
        signal: params.signal,
        includeDescendants: params.includeDescendants,
      });
    }
    // Resolve mount policy in the logical namespace, but pin mutations to the
    // canonical root so a legitimate symlinked workspace root is not reopened.
    const relativeParentPath = path.posix.relative(canonicalMountRoot, canonicalPath);
    if (relativePathEscapesContainerRoot(relativeParentPath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    return {
      mountRootPath: canonicalMountRoot,
      relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
      basename,
    };
  }

  private async runMutation(params: {
    args: string[];
    stdin?: Buffer | string;
    signal?: AbortSignal;
    allowFailure?: boolean;
  }): Promise<SandboxBackendCommandResult> {
    return await this.runtime.runRemoteShellScript({
      script: [
        "set -eu",
        `python_script=${SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL}`,
        'python3 -c "$python_script" "$@"',
      ].join("\n"),
      args: params.args,
      stdin: params.stdin,
      signal: params.signal,
      allowFailure: params.allowFailure,
    });
  }
}
