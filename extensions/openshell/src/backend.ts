// Openshell plugin module implements backend behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendManager,
  SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import {
  createRemoteShellSandboxFsBridge,
  disposeSshSandboxSession,
  prepareSshSandboxExec,
  resolvePreferredOpenClawTmpDir,
  runSshSandboxCommand,
  sanitizeEnvVars,
  shellEscape,
  withTempWorkspace,
} from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import {
  buildValidatedExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildRemoteCommand,
  createOpenShellSshSession,
  runOpenShellCli,
  type OpenShellExecContext,
} from "./cli.js";
import { resolveOpenShellPluginConfig, type ResolvedOpenShellPluginConfig } from "./config.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";
import {
  DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
  movePathWithCopyFallback,
  replaceDirectoryContents,
  stageDirectoryContents,
} from "./mirror.js";

type CreateOpenShellSandboxBackendFactoryParams = {
  pluginConfig: ResolvedOpenShellPluginConfig;
};

type PendingExec = {
  sshSession: SshSandboxSession;
  cleanup: () => Promise<void>;
};

const MATERIALIZED_SKILLS_REMOTE_PARTS = [".openclaw", "sandbox-skills"] as const;
function buildOpenShellDirectoryUploadArgs(params: {
  sandboxName: string;
  localPath: string;
  remotePath: string;
}): string[] {
  return [
    "sandbox",
    "upload",
    "--no-git-ignore",
    params.sandboxName,
    params.localPath,
    `${normalizeRemotePath(params.remotePath)}/`,
  ];
}

// Prints "0" when every managed root is missing or empty, "1" otherwise. Any
// content in a managed root means the remote workspace was already seeded (or
// holds operator data) and re-seeding would destroy remote-canonical state.
const REMOTE_MANAGED_ROOTS_EMPTY_SCRIPT =
  'for root in "$@"; do if [ -d "$root" ] && [ -n "$(ls -A "$root")" ]; then printf "1\\n"; exit 0; fi; done; printf "0\\n"';
const PINNED_REMOTE_PATH_MUTATION_SCRIPT = [
  "set -eu",
  'die() { echo "$1" >&2; exit 1; }',
  "validate_basename() {",
  '  case "$1" in ""|"."|".."|*/*) die "unsafe remote basename: $1" ;; esac',
  "}",
  "pin_dir() {",
  '  root="$1"',
  '  relative="$2"',
  '  create="$3"',
  '  case "$root" in /*) ;; *) die "remote root must be absolute: $root" ;; esac',
  '  root="${root%/}"',
  '  [ -n "$root" ] || root="/"',
  '  if [ -L "$root" ]; then die "unsafe remote root symlink: $root"; fi',
  '  mkdir -p -- "$root"',
  '  canonical_root="$(cd "$root" && pwd -P)"',
  '  current="$canonical_root"',
  '  relative="${relative#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") die "unsafe remote directory component: $part" ;; esac',
  '    if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '    if [ -L "$next" ]; then die "unsafe remote directory symlink: $next"; fi',
  '    if [ -e "$next" ]; then',
  '      if [ ! -d "$next" ]; then die "unsafe remote directory component: $next"; fi',
  "    else",
  '      if [ "$create" != "1" ]; then die "remote directory not found: $next"; fi',
  '      mkdir -- "$next"',
  "    fi",
  '    current="$next"',
  "  done",
  '  printf "%s\\n" "$current"',
  "}",
  "pin_dir_or_missing() {",
  '  root="$1"',
  '  relative="$2"',
  '  missing_ok="$3"',
  '  case "$root" in /*) ;; *) die "remote root must be absolute: $root" ;; esac',
  '  root="${root%/}"',
  '  [ -n "$root" ] || root="/"',
  '  if [ -L "$root" ]; then die "unsafe remote root symlink: $root"; fi',
  '  if [ ! -d "$root" ]; then',
  '    if [ -e "$root" ]; then die "unsafe remote root component: $root"; fi',
  '    if [ "$missing_ok" = "1" ]; then printf "\\n"; return 0; fi',
  '    die "remote directory not found: $root"',
  "  fi",
  '  canonical_root="$(cd "$root" && pwd -P)"',
  '  current="$canonical_root"',
  '  relative="${relative#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") die "unsafe remote directory component: $part" ;; esac',
  '    if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '    if [ -L "$next" ]; then die "unsafe remote directory symlink: $next"; fi',
  '    if [ -e "$next" ]; then',
  '      if [ ! -d "$next" ]; then die "unsafe remote directory component: $next"; fi',
  "    else",
  '      if [ "$missing_ok" = "1" ]; then printf "\\n"; return 0; fi',
  '      die "remote directory not found: $next"',
  "    fi",
  '    current="$next"',
  "  done",
  '  printf "%s\\n" "$current"',
  "}",
  'operation="$1"',
  'case "$operation" in',
  "  mkdirp)",
  '    pin_dir "$2" "$3" 1 >/dev/null',
  "    ;;",
  "  remove)",
  '    validate_basename "$4"',
  '    parent="$(pin_dir_or_missing "$2" "$3" "${5:-0}")"',
  '    [ -n "$parent" ] || exit 0',
  '    target="$parent/$4"',
  '    if [ -d "$target" ] && [ ! -L "$target" ]; then rm -rf -- "$target"; elif [ -e "$target" ] || [ -L "$target" ]; then rm -f -- "$target"; fi',
  "    ;;",
  "  removefile)",
  '    validate_basename "$4"',
  '    parent="$(pin_dir_or_missing "$2" "$3" "${5:-0}")"',
  '    [ -n "$parent" ] || exit 0',
  '    target="$parent/$4"',
  '    if [ -d "$target" ] && [ ! -L "$target" ]; then rmdir -- "$target"; elif [ -e "$target" ] || [ -L "$target" ]; then rm -f -- "$target"; fi',
  "    ;;",
  "  rename)",
  '    src_parent="$(pin_dir "$2" "$3" 0)"',
  '    validate_basename "$4"',
  '    dst_parent="$(pin_dir "$5" "$6" 1)"',
  '    validate_basename "$7"',
  '    if [ -L "$dst_parent/$7" ]; then die "unsafe remote rename target symlink: $dst_parent/$7"; fi',
  '    if [ -d "$dst_parent/$7" ]; then die "unsafe remote rename target directory: $dst_parent/$7"; fi',
  '    mv -- "$src_parent/$4" "$dst_parent/$7"',
  "    ;;",
  "  *)",
  '    die "unknown remote path mutation: $operation"',
  "    ;;",
  "esac",
].join("\n");
const ENSURE_OPEN_SHELL_REMOTE_REAL_DIRECTORY_SCRIPT = [
  "set -e",
  'target="$1"',
  'root="${2:-$1}"',
  'case "$target" in /*) ;; *) echo "remote directory must be absolute: $target" >&2; exit 1 ;; esac',
  'case "$root" in /*) ;; *) echo "remote root must be absolute: $root" >&2; exit 1 ;; esac',
  'target="${target%/}"',
  'root="${root%/}"',
  '[ -n "$target" ] || target="/"',
  '[ -n "$root" ] || root="/"',
  'case "$target/" in "$root"/*|"$root/") ;; *) echo "remote directory must stay under root: $target" >&2; exit 1 ;; esac',
  'for path_to_check in "$target" "$root"; do',
  '  relative="${path_to_check#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") echo "unsafe remote directory component: $part" >&2; exit 1 ;; esac',
  "  done",
  "done",
  'if [ -L "$root" ]; then echo "unsafe remote root symlink: $root" >&2; exit 1; fi',
  'mkdir -p -- "$root"',
  'canonical_root="$(cd "$root" && pwd -P)"',
  'relative="${target#"$root"}"',
  'relative="${relative#/}"',
  'current="$canonical_root"',
  'while [ -n "$relative" ]; do',
  '  part="${relative%%/*}"',
  '  if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '  [ -n "$part" ] || continue',
  '  if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '  if [ -L "$next" ]; then echo "unsafe remote directory symlink: $next" >&2; exit 1; fi',
  '  if [ -e "$next" ]; then',
  '    if [ ! -d "$next" ]; then echo "unsafe remote directory component: $next" >&2; exit 1; fi',
  "  else",
  '    mkdir -- "$next"',
  "  fi",
  '  current="$next"',
  "done",
].join("\n");

function buildOpenShellSshExecEnv(): NodeJS.ProcessEnv {
  return sanitizeEnvVars(process.env).allowed;
}

export function createOpenShellSandboxBackendFactory(
  params: CreateOpenShellSandboxBackendFactoryParams,
): SandboxBackendFactory {
  return async (createParams) =>
    await createOpenShellSandboxBackend({
      ...params,
      createParams,
    });
}

export function createOpenShellSandboxBackendManager(params: {
  pluginConfig: ResolvedOpenShellPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config }) {
      const execContext: OpenShellExecContext = {
        config: resolveOpenShellPluginConfigFromConfig(config, params.pluginConfig),
        sandboxName: entry.containerName,
      };
      const result = await runOpenShellCli({
        context: execContext,
        args: ["sandbox", "get", entry.containerName, "--output", "json"],
      });
      const configuredSource = execContext.config.from;
      return {
        running: result.code === 0 && parseOpenShellSandboxPhase(result.stdout) === "Ready",
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === configuredSource,
      };
    },
    async removeRuntime({ entry, config }) {
      const execContext: OpenShellExecContext = {
        config: resolveOpenShellPluginConfigFromConfig(config, params.pluginConfig),
        sandboxName: entry.containerName,
      };
      const result = await runOpenShellCli({
        context: execContext,
        args: ["sandbox", "delete", entry.containerName],
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "openshell sandbox delete failed");
      }
    },
  };
}

async function createOpenShellSandboxBackend(params: {
  pluginConfig: ResolvedOpenShellPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<OpenShellSandboxBackend> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("OpenShell sandbox backend does not support sandbox.docker.binds.");
  }

  const resolvedSandboxName = resolveOpenShellSandboxName({
    scopeKey: params.createParams.scopeKey,
    registeredRuntimeIds: params.createParams.registeredRuntimeIds,
  });
  const sandboxName = resolvedSandboxName.sandboxName;
  const execContext: OpenShellExecContext = {
    config: params.pluginConfig,
    sandboxName,
  };
  const impl = new OpenShellSandboxBackendImpl({
    createParams: params.createParams,
    execContext,
    legacyRuntimeAdopted: resolvedSandboxName.legacyRuntimeAdopted,
    remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir,
  });
  return impl.asHandle();
}

class OpenShellSandboxBackendImpl {
  // Filesystem bridges must retain the same lifecycle owner returned by the factory.
  private handle: OpenShellSandboxBackend | null = null;
  private ensurePromise: Promise<void> | null = null;
  private preparedRemoteWorkspaceForNextExec: {
    workdir: string;
    promise: Promise<void>;
  } | null = null;
  private remoteSeedPending = false;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      execContext: OpenShellExecContext;
      legacyRuntimeAdopted: boolean;
      remoteWorkspaceDir: string;
      remoteAgentWorkspaceDir: string;
    },
  ) {}

  asHandle(): OpenShellSandboxBackend {
    if (this.handle) {
      return this.handle;
    }
    const handle: OpenShellSandboxBackend = {
      id: "openshell",
      runtimeId: this.params.execContext.sandboxName,
      runtimeLabel: this.params.execContext.sandboxName,
      workdir: this.params.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      mode: this.params.execContext.config.mode,
      configLabel: this.params.execContext.config.from,
      configLabelKind: "Source",
      workdirValidation: "backend",
      validateWorkdir: async (workdir) => await this.validateWorkdir(workdir),
      discardPreparedWorkdir: (workdir) => this.discardPreparedWorkdir(workdir),
      workdirRoots: [this.params.remoteWorkspaceDir, this.params.remoteAgentWorkspaceDir],
      remoteWorkspaceDir: this.params.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        const pending = await this.prepareExec({ command, workdir, env, usePty });
        return {
          argv: pending.argv,
          env: buildOpenShellSshExecEnv(),
          stdinMode: "pipe-open",
          finalizeToken: pending.token,
        };
      },
      finalizeExec: async ({ token }) => {
        await this.finalizeExec(token as PendingExec | undefined);
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        this.params.execContext.config.mode === "remote"
          ? createRemoteShellSandboxFsBridge({
              sandbox,
              runtime: handle,
            })
          : createOpenShellFsBridge({
              sandbox,
              backend: handle,
            }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
      mkdirpRemotePath: async (remotePath, signal) =>
        await this.mkdirpRemotePath(remotePath, signal),
      removeRemotePath: async (remotePath, removeParams) =>
        await this.removeRemotePath(remotePath, removeParams),
      renameRemotePath: async (fromRemotePath, toRemotePath, signal) =>
        await this.renameRemotePath(fromRemotePath, toRemotePath, signal),
      syncLocalPathToRemote: async (localPath, remotePath) =>
        await this.syncLocalPathToRemote(localPath, remotePath),
    };
    this.handle = handle;
    return handle;
  }

  async prepareExec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<{ argv: string[]; token: PendingExec }> {
    const remoteWorkdir = params.workdir ?? this.params.remoteWorkspaceDir;
    const preparedWorkspace = this.consumePreparedRemoteWorkspaceForNextExec(remoteWorkdir);
    const remoteCommand = buildValidatedExecRemoteCommand({
      command: params.command,
      workdir: remoteWorkdir,
      env: {},
    });
    await (preparedWorkspace ?? this.prepareRemoteWorkspaceForExec());
    const sshSession = await createOpenShellSshSession({
      context: this.params.execContext,
    });
    try {
      const prepared = await prepareSshSandboxExec({
        session: sshSession,
        remoteCommand,
        env: params.env,
        tty: params.usePty,
      });
      return {
        argv: prepared.argv,
        token: { sshSession, cleanup: prepared.cleanup },
      };
    } catch (error) {
      await disposeSshSandboxSession(sshSession);
      throw error;
    }
  }

  async validateWorkdir(workdir: string): Promise<string | null> {
    const preparedWorkspace = this.prepareRemoteWorkspaceForExec();
    const reusablePreparation = { workdir, promise: preparedWorkspace };
    this.preparedRemoteWorkspaceForNextExec = reusablePreparation;
    try {
      await preparedWorkspace;
      const sshSession = await createOpenShellSshSession({
        context: this.params.execContext,
      });
      try {
        const result = await runSshSandboxCommand({
          session: sshSession,
          remoteCommand: buildRemoteWorkdirValidationCommand({
            workdir,
            root: this.resolveWorkdirValidationRoot(workdir),
          }),
          allowFailure: true,
        });
        const resolvedWorkdir = result.code === 0 ? result.stdout.toString("utf8").trim() : "";
        if (this.preparedRemoteWorkspaceForNextExec === reusablePreparation) {
          this.preparedRemoteWorkspaceForNextExec = resolvedWorkdir
            ? { workdir: resolvedWorkdir, promise: preparedWorkspace }
            : null;
        }
        return resolvedWorkdir || null;
      } finally {
        await disposeSshSandboxSession(sshSession);
      }
    } catch (error) {
      if (this.preparedRemoteWorkspaceForNextExec === reusablePreparation) {
        this.preparedRemoteWorkspaceForNextExec = null;
      }
      throw error;
    }
  }

  private resolveWorkdirValidationRoot(workdir: string): string {
    try {
      const normalized = normalizeRemotePath(workdir);
      const roots = [
        normalizeRemotePath(this.params.remoteAgentWorkspaceDir),
        normalizeRemotePath(this.params.remoteWorkspaceDir),
      ].toSorted((a, b) => b.length - a.length);
      return (
        roots.find((root) => isRemotePathInside(root, normalized)) ?? this.params.remoteWorkspaceDir
      );
    } catch {
      return this.params.remoteWorkspaceDir;
    }
  }

  private consumePreparedRemoteWorkspaceForNextExec(workdir: string): Promise<void> | null {
    const preparedWorkspace = this.preparedRemoteWorkspaceForNextExec;
    if (!preparedWorkspace || preparedWorkspace.workdir !== workdir) {
      this.preparedRemoteWorkspaceForNextExec = null;
      return null;
    }
    this.preparedRemoteWorkspaceForNextExec = null;
    return preparedWorkspace.promise;
  }

  discardPreparedWorkdir(workdir: string): void {
    if (this.preparedRemoteWorkspaceForNextExec?.workdir === workdir) {
      this.preparedRemoteWorkspaceForNextExec = null;
    }
  }

  private async prepareRemoteWorkspaceForExec(): Promise<void> {
    await this.ensureSandboxExists();
    if (this.params.execContext.config.mode === "mirror") {
      await this.syncWorkspaceToRemote();
      return;
    }
    const seeded = await this.maybeSeedRemoteWorkspace();
    if (!seeded) {
      await this.syncSkillsWorkspaceToRemote();
    }
  }

  async finalizeExec(token: PendingExec | undefined): Promise<void> {
    try {
      if (this.params.execContext.config.mode === "mirror") {
        await this.syncWorkspaceFromRemote();
      }
    } finally {
      if (token?.sshSession) {
        try {
          await token.cleanup();
        } finally {
          await disposeSshSandboxSession(token.sshSession);
        }
      }
    }
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureSandboxExists();
    const seeded = await this.maybeSeedRemoteWorkspace();
    if (!seeded) {
      await this.syncSkillsWorkspaceToRemote();
    }
    return await this.runRemoteShellScriptInternal(params);
  }

  async mkdirpRemotePath(remotePath: string, signal?: AbortSignal): Promise<void> {
    const target = this.resolveRemoteTarget(remotePath);
    await this.runPinnedRemotePathMutation({
      args: ["mkdirp", target.root, target.relativePath],
      signal,
    });
  }

  async removeRemotePath(
    remotePath: string,
    params?: {
      recursive?: boolean;
      signal?: AbortSignal;
      ignoreMissing?: boolean;
    },
  ): Promise<void> {
    const target = this.resolveRemoteTarget(remotePath);
    await this.runPinnedRemotePathMutation({
      args: [
        params?.recursive ? "remove" : "removefile",
        target.root,
        path.posix.dirname(target.relativePath) === "."
          ? ""
          : path.posix.dirname(target.relativePath),
        path.posix.basename(target.relativePath),
        params?.ignoreMissing ? "1" : "0",
      ],
      signal: params?.signal,
    });
  }

  async renameRemotePath(
    fromRemotePath: string,
    toRemotePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const from = this.resolveRemoteTarget(fromRemotePath);
    const to = this.resolveRemoteTarget(toRemotePath);
    await this.runPinnedRemotePathMutation({
      args: [
        "rename",
        from.root,
        path.posix.dirname(from.relativePath) === "." ? "" : path.posix.dirname(from.relativePath),
        path.posix.basename(from.relativePath),
        to.root,
        path.posix.dirname(to.relativePath) === "." ? "" : path.posix.dirname(to.relativePath),
        path.posix.basename(to.relativePath),
      ],
      signal,
    });
  }

  private async runRemoteShellScriptInternal(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    const session = await createOpenShellSshSession({
      context: this.params.execContext,
    });
    try {
      return await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-openshell-fs",
          ...(params.args ?? []),
        ]),
        stdin: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      });
    } finally {
      await disposeSshSandboxSession(session);
    }
  }

  async syncLocalPathToRemote(localPath: string, remotePath: string): Promise<void> {
    await this.ensureSandboxExists();
    await this.maybeSeedRemoteWorkspace();
    const target = this.resolveRemoteTarget(remotePath);
    const stats = await fs.lstat(localPath).catch(() => null);
    if (!stats) {
      await this.runPinnedRemotePathMutation({
        args: [
          "remove",
          target.root,
          path.posix.dirname(target.relativePath) === "."
            ? ""
            : path.posix.dirname(target.relativePath),
          path.posix.basename(target.relativePath),
          "1",
        ],
      });
      return;
    }
    if (stats.isSymbolicLink()) {
      await this.runPinnedRemotePathMutation({
        args: [
          "remove",
          target.root,
          path.posix.dirname(target.relativePath) === "."
            ? ""
            : path.posix.dirname(target.relativePath),
          path.posix.basename(target.relativePath),
          "1",
        ],
      });
      return;
    }
    if (stats.isDirectory()) {
      await this.mkdirpRemotePath(remotePath);
      return;
    }
    await this.runPinnedRemotePathMutation({
      args: [
        "mkdirp",
        target.root,
        path.posix.dirname(target.relativePath) === "."
          ? ""
          : path.posix.dirname(target.relativePath),
      ],
    });
    const result = await runOpenShellCli({
      context: this.params.execContext,
      args: [
        "sandbox",
        "upload",
        "--no-git-ignore",
        this.params.execContext.sandboxName,
        localPath,
        remotePath,
      ],
      cwd: this.params.createParams.workspaceDir,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
    }
  }

  private async runPinnedRemotePathMutation(params: {
    args: string[];
    signal?: AbortSignal;
  }): Promise<SandboxBackendCommandResult> {
    return await this.runRemoteShellScript({
      script: PINNED_REMOTE_PATH_MUTATION_SCRIPT,
      args: params.args,
      signal: params.signal,
    });
  }

  private resolveRemoteTarget(remotePath: string): { root: string; relativePath: string } {
    const normalized = normalizeRemotePath(remotePath);
    const roots = [
      normalizeRemotePath(this.params.remoteWorkspaceDir),
      normalizeRemotePath(this.params.remoteAgentWorkspaceDir),
    ].toSorted((a, b) => b.length - a.length);
    for (const root of roots) {
      if (isRemotePathInside(root, normalized)) {
        const relativePath = path.posix.relative(root, normalized);
        return { root, relativePath: relativePath === "." ? "" : relativePath };
      }
    }
    throw new Error(`Remote path escapes OpenShell managed roots: ${remotePath}`);
  }

  private async ensureSandboxExists(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureSandboxExistsInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureSandboxExistsInner(): Promise<void> {
    const getResult = await runOpenShellCli({
      context: this.params.execContext,
      args: ["sandbox", "get", this.params.execContext.sandboxName],
      cwd: this.params.createParams.workspaceDir,
    });
    if (getResult.code === 0) {
      if (this.params.legacyRuntimeAdopted) {
        const phase = await this.resolveLegacyRuntimePhase();
        if (!phase) {
          throw this.buildLegacyRuntimeUnavailableError(
            "OpenShell did not report a lifecycle phase for this sandbox.",
          );
        }
        if (phase !== "Ready") {
          throw this.buildLegacyRuntimeUnavailableError(`OpenShell reports phase "${phase}".`);
        }
      }
      // The seed obligation must survive a gateway restart between `sandbox
      // create` and the first exec: process memory is gone, so adopted remote
      // sandboxes probe the managed roots instead. Only completely empty roots
      // arm the seed — the wipe step is then a no-op, so recovery can never
      // destroy operator content in a remote-canonical workspace.
      if (
        this.params.execContext.config.mode === "remote" &&
        (await this.remoteManagedRootsEmpty())
      ) {
        this.remoteSeedPending = true;
      }
      return;
    }
    if (this.params.legacyRuntimeAdopted) {
      throw this.buildLegacyRuntimeUnavailableError(getResult.stderr.trim());
    }
    if (!/\bsandbox not found\b/iu.test(getResult.stderr)) {
      throw new Error(getResult.stderr.trim() || "openshell sandbox get failed");
    }
    const createArgs = [
      "sandbox",
      "create",
      "--name",
      this.params.execContext.sandboxName,
      "--from",
      this.params.execContext.config.from,
      ...(this.params.execContext.config.policy
        ? ["--policy", this.params.execContext.config.policy]
        : []),
      ...(this.params.execContext.config.gpu ? ["--gpu"] : []),
      ...(this.params.execContext.config.autoProviders
        ? ["--auto-providers"]
        : ["--no-auto-providers"]),
      ...this.params.execContext.config.providers.flatMap((provider) => ["--provider", provider]),
      "--",
      "true",
    ];
    const createResult = await runOpenShellCli({
      context: this.params.execContext,
      args: createArgs,
      cwd: this.params.createParams.workspaceDir,
      timeoutMs: Math.max(this.params.execContext.config.timeoutMs, 300_000),
    });
    if (createResult.code !== 0) {
      throw new Error(createResult.stderr.trim() || "openshell sandbox create failed");
    }
    this.remoteSeedPending = true;
  }

  private async resolveLegacyRuntimePhase(): Promise<string | undefined> {
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const listResult = await runOpenShellCli({
        context: this.params.execContext,
        args: [
          "sandbox",
          "list",
          "--limit",
          String(pageSize),
          "--offset",
          String(offset),
          "--output",
          "json",
        ],
        cwd: this.params.createParams.workspaceDir,
      });
      if (listResult.code !== 0) {
        throw this.buildLegacyRuntimeUnavailableError(listResult.stderr.trim());
      }
      const page = parseOpenShellSandboxPhasePage(
        listResult.stdout,
        this.params.execContext.sandboxName,
      );
      if (!page) {
        throw this.buildLegacyRuntimeUnavailableError(
          "OpenShell returned malformed sandbox lifecycle data.",
        );
      }
      if (page.phase) {
        return page.phase;
      }
      if (page.count < pageSize) {
        return undefined;
      }
    }
  }

  private buildLegacyRuntimeUnavailableError(detail: string): Error {
    const recreateCommand = `openclaw sandbox recreate --session ${shellEscape(this.params.createParams.scopeKey)}`;
    return new Error(
      [
        `Registered legacy OpenShell sandbox "${this.params.execContext.sandboxName}" is not usable.`,
        detail,
        `OpenClaw will not recreate this retired runtime name. Run \`${recreateCommand}\` to migrate this scope to the current naming format.`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private async syncWorkspaceToRemote(): Promise<void> {
    await this.runRemoteShellScriptInternal({
      script: 'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
      args: [this.params.remoteWorkspaceDir],
    });
    await this.uploadPathToRemote(
      this.params.createParams.workspaceDir,
      this.params.remoteWorkspaceDir,
    );

    if (
      this.params.createParams.cfg.workspaceAccess !== "none" &&
      path.resolve(this.params.createParams.agentWorkspaceDir) !==
        path.resolve(this.params.createParams.workspaceDir)
    ) {
      await this.runRemoteShellScriptInternal({
        script: 'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        args: [this.params.remoteAgentWorkspaceDir],
      });
      await this.uploadPathToRemote(
        this.params.createParams.agentWorkspaceDir,
        this.params.remoteAgentWorkspaceDir,
      );
    }
    await this.syncSkillsWorkspaceToRemote();
  }

  private async syncSkillsWorkspaceToRemote(): Promise<void> {
    if (
      this.params.createParams.cfg.workspaceAccess !== "rw" ||
      !this.params.createParams.skillsWorkspaceDir
    ) {
      return;
    }
    const remoteSkillsWorkspaceDir = resolveRemoteMaterializedSkillsWorkspaceDir(
      this.params.remoteWorkspaceDir,
    );
    await this.runRemoteShellScriptInternal({
      script: `${ENSURE_OPEN_SHELL_REMOTE_REAL_DIRECTORY_SCRIPT}\nfind "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      args: [remoteSkillsWorkspaceDir, this.params.remoteWorkspaceDir],
    });
    const stats = await fs.lstat(this.params.createParams.skillsWorkspaceDir).catch(() => null);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      return;
    }
    await this.uploadPathToRemote(
      this.params.createParams.skillsWorkspaceDir,
      remoteSkillsWorkspaceDir,
    );
  }

  private async syncWorkspaceFromRemote(): Promise<void> {
    await withTempWorkspace(
      { rootDir: resolveOpenShellTmpRoot(), prefix: "openclaw-openshell-sync-" },
      async ({ dir: tmpDir }) => {
        const result = await runOpenShellCli({
          context: this.params.execContext,
          args: [
            "sandbox",
            "download",
            this.params.execContext.sandboxName,
            this.params.remoteWorkspaceDir,
            tmpDir,
          ],
          cwd: this.params.createParams.workspaceDir,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || "openshell sandbox download failed");
        }
        await removeMaterializedSkillsFromDownloadedWorkspace(tmpDir);
        const preservedSandboxSkills = await moveMaterializedSkillsShadowAside({
          workspaceDir: this.params.createParams.workspaceDir,
          tmpDir,
        });
        try {
          await replaceDirectoryContents({
            sourceDir: tmpDir,
            targetDir: this.params.createParams.workspaceDir,
            // Never sync trusted host hook directories or repository metadata from
            // the remote sandbox.
            excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
          });
        } finally {
          await restoreMaterializedSkillsShadow({
            workspaceDir: this.params.createParams.workspaceDir,
            preserved: preservedSandboxSkills,
          });
        }
      },
    );
  }

  private async uploadPathToRemote(localPath: string, remotePath: string): Promise<void> {
    await withTempWorkspace(
      { rootDir: resolveOpenShellTmpRoot(), prefix: "openclaw-openshell-upload-" },
      async ({ dir: tmpDir }) => {
        // Stage a symlink-free snapshot so upload never dereferences host paths
        // outside the mirrored workspace tree.
        const remoteRootName = path.posix.basename(normalizeRemotePath(remotePath));
        const stagedRoot = path.join(tmpDir, remoteRootName);
        await stageDirectoryContents({
          sourceDir: localPath,
          targetDir: stagedRoot,
          excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
        });
        const stagedEntries = (await fs.readdir(stagedRoot)).toSorted();
        for (const entry of stagedEntries) {
          const result = await runOpenShellCli({
            context: this.params.execContext,
            args: buildOpenShellDirectoryUploadArgs({
              sandboxName: this.params.execContext.sandboxName,
              localPath: path.join(stagedRoot, entry),
              remotePath,
            }),
            cwd: this.params.createParams.workspaceDir,
          });
          if (result.code !== 0) {
            throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
          }
        }
      },
    );
  }

  private async remoteManagedRootsEmpty(): Promise<boolean> {
    const result = await this.runRemoteShellScriptInternal({
      script: REMOTE_MANAGED_ROOTS_EMPTY_SCRIPT,
      args: [this.params.remoteWorkspaceDir, this.params.remoteAgentWorkspaceDir],
    });
    // Anything other than an exact "0" reads as non-empty so the seed never
    // fires on ambiguous probe output.
    return result.stdout.toString("utf8").trim() === "0";
  }

  private async maybeSeedRemoteWorkspace(): Promise<boolean> {
    if (!this.remoteSeedPending) {
      return false;
    }
    this.remoteSeedPending = false;
    try {
      await this.syncWorkspaceToRemote();
      return true;
    } catch (error) {
      this.remoteSeedPending = true;
      throw error;
    }
  }
}

function resolveOpenShellPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedOpenShellPluginConfig,
): ResolvedOpenShellPluginConfig {
  const pluginConfig = config.plugins?.entries?.openshell?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveOpenShellPluginConfig(pluginConfig);
}

function buildOpenShellSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  if (/:workspace:[a-f0-9]{32}$/i.test(trimmed)) {
    // OpenShell's 19-character DNS-label cap leaves 16 payload characters.
    // Base36 retains 80 hash bits within that cap.
    const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 20);
    const encoded = BigInt(`0x${hash}`).toString(36).padStart(16, "0");
    return `oc-${encoded}`;
  }
  // OpenShell reserves 19 characters so workspace--sandbox--service remains
  // a valid DNS label. Keep 64 hash bits to make opaque scope names collision-resistant.
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `oc-${hash}`;
}

function buildLegacyOpenShellSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  // Keep this byte-for-byte compatible with the naming contract shipped before
  // the 19-character OpenShell limit; registered remote workspaces depend on it.
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}

function resolveOpenShellSandboxName(params: {
  scopeKey: string;
  registeredRuntimeIds?: readonly string[];
}): { sandboxName: string; legacyRuntimeAdopted: boolean } {
  const sandboxName = buildOpenShellSandboxName(params.scopeKey);
  if (params.registeredRuntimeIds?.includes(sandboxName)) {
    return { sandboxName, legacyRuntimeAdopted: false };
  }
  const legacySandboxName = buildLegacyOpenShellSandboxName(params.scopeKey);
  if (params.registeredRuntimeIds?.includes(legacySandboxName)) {
    return { sandboxName: legacySandboxName, legacyRuntimeAdopted: true };
  }
  return { sandboxName, legacyRuntimeAdopted: false };
}

function parseOpenShellSandboxPhasePage(
  stdout: string,
  sandboxName: string,
): { count: number; phase?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (record.name === sandboxName && typeof record.phase === "string") {
        return { count: parsed.length, phase: record.phase };
      }
    }
    return { count: parsed.length };
  } catch {
    return undefined;
  }
}

function parseOpenShellSandboxPhase(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || !("phase" in parsed)) {
      return undefined;
    }
    return typeof parsed.phase === "string" ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

function resolveRemoteMaterializedSkillsWorkspaceDir(remoteWorkspaceDir: string): string {
  const root = remoteWorkspaceDir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return path.posix.join(root, ...MATERIALIZED_SKILLS_REMOTE_PARTS);
}

async function removeMaterializedSkillsFromDownloadedWorkspace(tmpDir: string): Promise<void> {
  let cursor = tmpDir;
  for (const [index, part] of MATERIALIZED_SKILLS_REMOTE_PARTS.entries()) {
    const next = path.join(cursor, part);
    const stats = await fs.lstat(next).catch(() => null);
    if (!stats) {
      return;
    }
    if (index === MATERIALIZED_SKILLS_REMOTE_PARTS.length - 1) {
      await fs.rm(next, { recursive: true, force: true });
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      await fs.rm(next, { recursive: true, force: true });
      return;
    }
    cursor = next;
  }
}

async function moveMaterializedSkillsShadowAside(params: {
  workspaceDir: string;
  tmpDir: string;
}): Promise<{ preservedPath: string; preserveRoot: string } | undefined> {
  const shadowPath = path.join(params.workspaceDir, ...MATERIALIZED_SKILLS_REMOTE_PARTS);
  const parentStats = await fs.lstat(path.dirname(shadowPath)).catch(() => null);
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
    return undefined;
  }
  const shadowStats = await fs.lstat(shadowPath).catch(() => null);
  if (!shadowStats || shadowStats.isSymbolicLink()) {
    return undefined;
  }
  const preserveRoot = await fs.mkdtemp(
    path.join(path.dirname(params.tmpDir), "openclaw-openshell-preserve-"),
  );
  const preservedPath = path.join(preserveRoot, "sandbox-skills");
  await movePathWithCopyFallback({ from: shadowPath, to: preservedPath });
  return { preservedPath, preserveRoot };
}

async function restoreMaterializedSkillsShadow(params: {
  workspaceDir: string;
  preserved?: { preservedPath: string; preserveRoot: string };
}): Promise<void> {
  if (!params.preserved) {
    return;
  }
  let restored = false;
  try {
    const shadowPath = path.join(params.workspaceDir, ...MATERIALIZED_SKILLS_REMOTE_PARTS);
    const parentPath = path.dirname(shadowPath);
    const parentStats = await fs.lstat(parentPath).catch(() => null);
    if (parentStats?.isSymbolicLink()) {
      throw new Error(`Refusing to restore sandbox skills through symlink parent: ${parentPath}`);
    }
    if (parentStats && !parentStats.isDirectory()) {
      await fs.rm(parentPath, { recursive: true, force: true });
    }
    await fs.mkdir(parentPath, { recursive: true });
    await fs.rm(shadowPath, { recursive: true, force: true });
    await movePathWithCopyFallback({
      from: params.preserved.preservedPath,
      to: shadowPath,
    });
    restored = true;
  } finally {
    if (restored) {
      await fs.rm(params.preserved.preserveRoot, { recursive: true, force: true });
    }
  }
}

function resolveOpenShellTmpRoot(): string {
  return path.resolve(resolvePreferredOpenClawTmpDir());
}

function normalizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(remotePath.replace(/\\/g, "/"));
  if (!path.posix.isAbsolute(normalized)) {
    throw new Error(`OpenShell remote path must be absolute: ${remotePath}`);
  }
  return normalized;
}

function isRemotePathInside(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
