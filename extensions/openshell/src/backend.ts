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
  buildExecRemoteCommand,
  buildRemoteCommand,
  createOpenShellSshSession,
  runOpenShellCli,
  type OpenShellExecContext,
} from "./cli.js";
import { resolveOpenShellPluginConfig, type ResolvedOpenShellPluginConfig } from "./config.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";
import {
  DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
  replaceDirectoryContents,
  stageDirectoryContents,
} from "./mirror.js";

type CreateOpenShellSandboxBackendFactoryParams = {
  pluginConfig: ResolvedOpenShellPluginConfig;
};

type PendingExec = {
  sshSession: SshSandboxSession;
};

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
    await this.ensureSandboxExists();
    if (this.params.execContext.config.mode === "mirror") {
      await this.syncWorkspaceToRemote();
    } else {
      await this.maybeSeedRemoteWorkspace();
    }
    const sshSession = await createOpenShellSshSession({
      context: this.params.execContext,
    });
    const remoteCommand = buildExecRemoteCommand({
      command: params.command,
      workdir: params.workdir ?? this.params.remoteWorkspaceDir,
      env: params.env,
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
    await this.maybeSeedRemoteWorkspace();
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
        await replaceDirectoryContents({
          sourceDir: tmpDir,
          targetDir: this.params.createParams.workspaceDir,
          // Never sync trusted host hook directories or repository metadata from
          // the remote sandbox.
          excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
        });
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

  private async maybeSeedRemoteWorkspace(): Promise<void> {
    if (!this.remoteSeedPending) {
      return;
    }
    this.remoteSeedPending = false;
    try {
      await this.syncWorkspaceToRemote();
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
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}

function resolveOpenShellTmpRoot(): string {
  return path.resolve(resolvePreferredOpenClawTmpDir());
}
