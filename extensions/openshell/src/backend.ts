// Openshell plugin module implements backend behavior.
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
  resolvePreferredOpenClawTmpDir,
  runSshSandboxCommand,
  sanitizeEnvVars,
  withTempWorkspace,
} from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import {
  buildValidatedExecRemoteCommand,
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
};

const MATERIALIZED_SKILLS_REMOTE_PARTS = [".openclaw", "sandbox-skills"] as const;
const ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT = [
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
  'old_ifs="$IFS"',
  'IFS="/"',
  "set -- ${target#/} ${root#/}",
  'IFS="$old_ifs"',
  "for part do",
  '  [ -n "$part" ] || continue',
  '  case "$part" in "."|"..") echo "unsafe remote directory component: $part" >&2; exit 1 ;; esac',
  "done",
  'if [ -L "$root" ]; then echo "unsafe remote root symlink: $root" >&2; exit 1; fi',
  'mkdir -p -- "$root"',
  'canonical_root="$(cd "$root" && pwd -P)"',
  'relative="${target#"$root"}"',
  'relative="${relative#/}"',
  'current="$canonical_root"',
  'IFS="/"',
  "set -- $relative",
  'IFS="$old_ifs"',
  "for part do",
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

export function buildOpenShellSshExecEnv(): NodeJS.ProcessEnv {
  return sanitizeEnvVars(process.env).allowed;
}

export type { OpenShellFsBridgeContext, OpenShellSandboxBackend } from "./backend.types.js";

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
        args: ["sandbox", "get", entry.containerName],
      });
      const configuredSource = execContext.config.from;
      return {
        running: result.code === 0,
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === configuredSource,
      };
    },
    async removeRuntime({ entry }) {
      const execContext: OpenShellExecContext = {
        config: params.pluginConfig,
        sandboxName: entry.containerName,
      };
      await runOpenShellCli({
        context: execContext,
        args: ["sandbox", "delete", entry.containerName],
      });
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

  const sandboxName = buildOpenShellSandboxName(params.createParams.scopeKey);
  const execContext: OpenShellExecContext = {
    config: params.pluginConfig,
    sandboxName,
  };
  const impl = new OpenShellSandboxBackendImpl({
    createParams: params.createParams,
    execContext,
    remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir,
  });

  return {
    id: "openshell",
    runtimeId: sandboxName,
    runtimeLabel: sandboxName,
    workdir: params.pluginConfig.remoteWorkspaceDir,
    env: params.createParams.cfg.docker.env,
    mode: params.pluginConfig.mode,
    configLabel: params.pluginConfig.from,
    configLabelKind: "Source",
    buildExecSpec: async ({ command, workdir, env, usePty }) => {
      const pending = await impl.prepareExec({ command, workdir, env, usePty });
      return {
        argv: pending.argv,
        env: buildOpenShellSshExecEnv(),
        stdinMode: "pipe-open",
        finalizeToken: pending.token,
      };
    },
    finalizeExec: async ({ token }) => {
      await impl.finalizeExec(token as PendingExec | undefined);
    },
    runShellCommand: async (command) => await impl.runRemoteShellScript(command),
    createFsBridge: ({ sandbox }) =>
      params.pluginConfig.mode === "remote"
        ? createRemoteShellSandboxFsBridge({
            sandbox,
            runtime: impl.asHandle(),
          })
        : createOpenShellFsBridge({
            sandbox,
            backend: impl.asHandle(),
          }),
    remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir,
    runRemoteShellScript: async (command) => await impl.runRemoteShellScript(command),
    syncLocalPathToRemote: async (localPath, remotePath) =>
      await impl.syncLocalPathToRemote(localPath, remotePath),
  };
}

class OpenShellSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;
  private remoteSeedPending = false;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      execContext: OpenShellExecContext;
      remoteWorkspaceDir: string;
      remoteAgentWorkspaceDir: string;
    },
  ) {}

  asHandle(): OpenShellSandboxBackend {
    return {
      id: "openshell",
      runtimeId: this.params.execContext.sandboxName,
      runtimeLabel: this.params.execContext.sandboxName,
      workdir: this.params.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      mode: this.params.execContext.config.mode,
      configLabel: this.params.execContext.config.from,
      configLabelKind: "Source",
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
              runtime: this.asHandle(),
            })
          : createOpenShellFsBridge({
              sandbox,
              backend: this.asHandle(),
            }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
      syncLocalPathToRemote: async (localPath, remotePath) =>
        await this.syncLocalPathToRemote(localPath, remotePath),
    };
  }

  async prepareExec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<{ argv: string[]; token: PendingExec }> {
    const remoteCommand = buildValidatedExecRemoteCommand({
      command: params.command,
      workdir: params.workdir ?? this.params.remoteWorkspaceDir,
      env: params.env,
    });
    await this.ensureSandboxExists();
    if (this.params.execContext.config.mode === "mirror") {
      await this.syncWorkspaceToRemote();
    } else {
      const seeded = await this.maybeSeedRemoteWorkspace();
      if (!seeded) {
        await this.syncSkillsWorkspaceToRemote();
      }
    }
    const sshSession = await createOpenShellSshSession({
      context: this.params.execContext,
    });
    return {
      argv: [
        "ssh",
        "-F",
        sshSession.configPath,
        ...(params.usePty
          ? ["-tt", "-o", "RequestTTY=force", "-o", "SetEnv=TERM=xterm-256color"]
          : ["-T", "-o", "RequestTTY=no"]),
        sshSession.host,
        remoteCommand,
      ],
      token: { sshSession },
    };
  }

  async finalizeExec(token?: PendingExec): Promise<void> {
    try {
      if (this.params.execContext.config.mode === "mirror") {
        await this.syncWorkspaceFromRemote();
      }
    } finally {
      if (token?.sshSession) {
        await disposeSshSandboxSession(token.sshSession);
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
    const stats = await fs.lstat(localPath).catch(() => null);
    if (!stats) {
      await this.runRemoteShellScript({
        script: 'rm -rf -- "$1"',
        args: [remotePath],
        allowFailure: true,
      });
      return;
    }
    if (stats.isSymbolicLink()) {
      await this.runRemoteShellScript({
        script: 'rm -rf -- "$1"',
        args: [remotePath],
        allowFailure: true,
      });
      return;
    }
    if (stats.isDirectory()) {
      await this.runRemoteShellScript({
        script: 'mkdir -p -- "$1"',
        args: [remotePath],
      });
      return;
    }
    await this.runRemoteShellScript({
      script: 'mkdir -p -- "$(dirname -- "$1")"',
      args: [remotePath],
    });
    const result = await runOpenShellCli({
      context: this.params.execContext,
      args: [
        "sandbox",
        "upload",
        "--no-git-ignore",
        this.params.execContext.sandboxName,
        localPath,
        path.posix.dirname(remotePath),
      ],
      cwd: this.params.createParams.workspaceDir,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
    }
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
      return;
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
      script: `${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\nfind "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
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
        await stageDirectoryContents({
          sourceDir: localPath,
          targetDir: tmpDir,
        });
        const result = await runOpenShellCli({
          context: this.params.execContext,
          args: [
            "sandbox",
            "upload",
            "--no-git-ignore",
            this.params.execContext.sandboxName,
            tmpDir,
            remotePath,
          ],
          cwd: this.params.createParams.workspaceDir,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
        }
      },
    );
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

export function buildOpenShellSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
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
