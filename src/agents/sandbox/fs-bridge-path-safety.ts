import fs from "node:fs";
import path from "node:path";
import type { PathAliasPolicy } from "../../infra/path-alias-guards.js";
import { openRootFile, type RootFileOpenResult } from "./fs-bridge-path-safety.runtime.js";
import type { SandboxResolvedFsPath, SandboxFsMount } from "./fs-paths.js";
import { isPathInsideContainerRoot, normalizeContainerPath } from "./path-utils.js";

type BoundaryAllowedType = "file" | "directory";

export type PathSafetyOptions = {
  action: string;
  aliasPolicy?: PathAliasPolicy;
  requireWritable?: boolean;
  allowedType?: BoundaryAllowedType;
};

export type PathSafetyCheck = {
  target: SandboxResolvedFsPath;
  options: PathSafetyOptions;
};

export type PinnedSandboxEntry = {
  mountRootPath: string;
  relativeParentPath: string;
  basename: string;
};

export type AnchoredSandboxEntry = {
  canonicalParentPath: string;
  basename: string;
};

export type PinnedSandboxDirectoryEntry = {
  mountRootPath: string;
  relativePath: string;
};

type RunCommand = (
  script: string,
  options?: {
    args?: string[];
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: Buffer }>;

export class SandboxFsPathGuard {
  private readonly mountsByContainer: SandboxFsMount[];
  private readonly runCommand: RunCommand;

  constructor(params: { mountsByContainer: SandboxFsMount[]; runCommand: RunCommand }) {
    this.mountsByContainer = params.mountsByContainer;
    this.runCommand = params.runCommand;
  }

  async assertPathChecks(checks: PathSafetyCheck[]): Promise<void> {
    for (const check of checks) {
      await this.assertPathSafety(check.target, check.options);
    }
  }

  async assertPathSafety(target: SandboxResolvedFsPath, options: PathSafetyOptions) {
    const guarded = await this.openBoundaryWithinRequiredMount(target, options.action, {
      aliasPolicy: options.aliasPolicy,
      allowedType: options.allowedType,
    });
    await this.assertGuardedPathSafety(target, options, guarded);
  }

  async openReadableFile(
    target: SandboxResolvedFsPath,
  ): Promise<RootFileOpenResult & { ok: true }> {
    const opened = await this.openBoundaryWithinRequiredMount(target, "read files");
    if (!opened.ok) {
      throw opened.error instanceof Error
        ? opened.error
        : new Error(`Sandbox boundary checks failed; cannot read files: ${target.containerPath}`);
    }
    return opened;
  }

  private resolveRequiredMount(containerPath: string, action: string): SandboxFsMount {
    const lexicalMount = this.resolveMountByContainerPath(containerPath);
    if (!lexicalMount) {
      throw new Error(`Sandbox path escapes allowed mounts; cannot ${action}: ${containerPath}`);
    }
    return lexicalMount;
  }

  private finalizePinnedEntry(params: {
    mount: SandboxFsMount;
    parentPath: string;
    basename: string;
    targetPath: string;
    action: string;
  }): PinnedSandboxEntry {
    const relativeParentPath = path.posix.relative(params.mount.containerRoot, params.parentPath);
    if (relativeParentPath.startsWith("..") || path.posix.isAbsolute(relativeParentPath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.targetPath}`,
      );
    }
    return {
      mountRootPath: params.mount.containerRoot,
      relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
      basename: params.basename,
    };
  }

  private async assertGuardedPathSafety(
    target: SandboxResolvedFsPath,
    options: PathSafetyOptions,
    guarded: RootFileOpenResult,
  ) {
    if (!guarded.ok) {
      if (guarded.reason !== "path") {
        const canFallbackToDirectoryStat =
          options.allowedType === "directory" && this.pathIsExistingDirectory(target.hostPath);
        if (!canFallbackToDirectoryStat) {
          throw guarded.error instanceof Error
            ? guarded.error
            : new Error(
                `Sandbox boundary checks failed; cannot ${options.action}: ${target.containerPath}`,
              );
        }
      }
    } else {
      fs.closeSync(guarded.fd);
    }

    const canonicalContainerPath = await this.resolveCanonicalContainerPath({
      containerPath: target.containerPath,
      allowFinalSymlinkForUnlink: options.aliasPolicy?.allowFinalSymlinkForUnlink === true,
    });
    const canonicalMount = this.resolveRequiredMount(canonicalContainerPath, options.action);
    if (options.requireWritable && !canonicalMount.writable) {
      throw new Error(
        `Sandbox path is read-only; cannot ${options.action}: ${target.containerPath}`,
      );
    }
  }

  private async openBoundaryWithinRequiredMount(
    target: SandboxResolvedFsPath,
    action: string,
    options?: {
      aliasPolicy?: PathAliasPolicy;
      allowedType?: BoundaryAllowedType;
    },
  ): Promise<RootFileOpenResult> {
    const lexicalMount = this.resolveRequiredMount(target.containerPath, action);
    const guarded = await openRootFile({
      absolutePath: target.hostPath,
      rootPath: lexicalMount.hostRoot,
      boundaryLabel: "sandbox mount root",
      aliasPolicy: options?.aliasPolicy,
      allowedType: options?.allowedType,
    });
    return guarded;
  }

  resolvePinnedEntry(target: SandboxResolvedFsPath, action: string): PinnedSandboxEntry {
    const basename = path.posix.basename(target.containerPath);
    if (!basename || basename === "." || basename === "/") {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
    const mount = this.resolveRequiredMount(parentPath, action);
    return this.finalizePinnedEntry({
      mount,
      parentPath,
      basename,
      targetPath: target.containerPath,
      action,
    });
  }

  async resolveAnchoredSandboxEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): Promise<AnchoredSandboxEntry> {
    const basename = path.posix.basename(target.containerPath);
    if (!basename || basename === "." || basename === "/") {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
    const canonicalParentPath = await this.resolveCanonicalContainerPath({
      containerPath: parentPath,
      allowFinalSymlinkForUnlink: false,
    });
    this.resolveRequiredMount(canonicalParentPath, action);
    return {
      canonicalParentPath,
      basename,
    };
  }

  async resolveAnchoredPinnedEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): Promise<PinnedSandboxEntry> {
    const anchoredTarget = await this.resolveAnchoredSandboxEntry(target, action);
    const mount = this.resolveRequiredMount(anchoredTarget.canonicalParentPath, action);
    return this.finalizePinnedEntry({
      mount,
      parentPath: anchoredTarget.canonicalParentPath,
      basename: anchoredTarget.basename,
      targetPath: target.containerPath,
      action,
    });
  }

  resolvePinnedDirectoryEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): PinnedSandboxDirectoryEntry {
    const mount = this.resolveRequiredMount(target.containerPath, action);
    const relativePath = path.posix.relative(mount.containerRoot, target.containerPath);
    if (relativePath.startsWith("..") || path.posix.isAbsolute(relativePath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${action}: ${target.containerPath}`,
      );
    }
    return {
      mountRootPath: mount.containerRoot,
      relativePath: relativePath === "." ? "" : relativePath,
    };
  }

  private pathIsExistingDirectory(hostPath: string): boolean {
    try {
      return fs.statSync(hostPath).isDirectory();
    } catch {
      return false;
    }
  }

  private resolveMountByContainerPath(containerPath: string): SandboxFsMount | null {
    const normalized = normalizeContainerPath(containerPath);
    for (const mount of this.mountsByContainer) {
      if (isPathInsideContainerRoot(normalizeContainerPath(mount.containerRoot), normalized)) {
        return mount;
      }
    }
    return null;
  }

  private async resolveCanonicalContainerPath(params: {
    containerPath: string;
    allowFinalSymlinkForUnlink: boolean;
  }): Promise<string> {
    const script = [
      "set -eu",
      'target="$1"',
      'allow_final="$2"',
      'suffix=""',
      'probe="$target"',
      'if [ "$allow_final" = "1" ] && [ -L "$target" ]; then probe=$(dirname -- "$target"); fi',
      'cursor="$probe"',
      'while [ ! -e "$cursor" ] && [ ! -L "$cursor" ]; do',
      '  parent=$(dirname -- "$cursor")',
      '  if [ "$parent" = "$cursor" ]; then break; fi',
      '  base=$(basename -- "$cursor")',
      '  suffix="/$base$suffix"',
      '  cursor="$parent"',
      "done",
      'canonical=$(readlink -f -- "$cursor")',
      'printf "%s%s\\n" "$canonical" "$suffix"',
    ].join("\n");
    const result = await this.runCommand(script, {
      args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"],
    });
    const canonical = result.stdout.toString("utf8").trim();
    if (!canonical.startsWith("/")) {
      throw new Error(`Failed to resolve canonical sandbox path: ${params.containerPath}`);
    }
    return normalizeContainerPath(canonical);
  }
}
