/**
 * SSH sandbox backend implementation.
 *
 * Creates remote workspace copies, builds remote exec specs, and exposes a backend-neutral filesystem bridge.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import { assertSshSandboxSecretOwnerAvailable } from "./secret-owner.js";
import { resolveSandboxAgentId } from "./shared.js";
import {
  buildRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildSshSandboxArgv,
  buildValidatedExecRemoteCommand,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT,
  runSshSandboxCommand,
  uploadDirectoryToSshTarget,
  type SshSandboxSession,
} from "./ssh.js";

type PendingExec = {
  sshSession: SshSandboxSession;
};

type ResolvedSshRuntimePaths = {
  runtimeId: string;
  runtimeRootDir: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  remoteSkillsWorkspaceDir: string;
};

/** SSH backend lifecycle hooks for probing and removing remote sandbox copies. */
export const sshSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const effectiveAgentId = agentId ?? resolveSandboxAgentId(entry.sessionKey);
    const cfg = resolveSandboxConfigForAgent(config, effectiveAgentId);
    if (cfg.backend !== "ssh" || !cfg.ssh.target) {
      return {
        running: false,
        actualConfigLabel: cfg.ssh.target,
        configLabelMatch: false,
      };
    }
    assertSshSandboxSecretOwnerAvailable({
      config,
      scope: cfg.scope,
      agentId: effectiveAgentId,
    });
    const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
    const session = await createSshSandboxSessionFromSettings({
      ...cfg.ssh,
      target: cfg.ssh.target,
    });
    try {
      const result = await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
          "openclaw-sandbox-check",
          runtimePaths.runtimeRootDir,
        ]),
      });
      return {
        running: result.stdout.toString("utf8").trim() === "1",
        actualConfigLabel: cfg.ssh.target,
        configLabelMatch: entry.image === cfg.ssh.target,
      };
    } finally {
      await disposeSshSandboxSession(session);
    }
  },
  async removeRuntime({ entry, config, agentId }) {
    const effectiveAgentId = agentId ?? resolveSandboxAgentId(entry.sessionKey);
    const cfg = resolveSandboxConfigForAgent(config, effectiveAgentId);
    if (cfg.backend !== "ssh" || !cfg.ssh.target) {
      return;
    }
    assertSshSandboxSecretOwnerAvailable({
      config,
      scope: cfg.scope,
      agentId: effectiveAgentId,
    });
    const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
    const session = await createSshSandboxSessionFromSettings({
      ...cfg.ssh,
      target: cfg.ssh.target,
    });
    try {
      await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'rm -rf -- "$1"',
          "openclaw-sandbox-remove",
          runtimePaths.runtimeRootDir,
        ]),
        allowFailure: true,
      });
    } finally {
      await disposeSshSandboxSession(session);
    }
  },
};

/** Create an SSH sandbox backend that mirrors the workspace to a remote target. */
export async function createSshSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  if ((params.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("SSH sandbox backend does not support sandbox.docker.binds.");
  }
  const target = params.cfg.ssh.target;
  if (!target) {
    throw new Error('Sandbox backend "ssh" requires agents.defaults.sandbox.ssh.target.');
  }

  const runtimePaths = resolveSshRuntimePaths(params.cfg.ssh.workspaceRoot, params.scopeKey);
  const impl = new SshSandboxBackendImpl({
    createParams: params,
    target,
    runtimePaths,
  });
  return impl.asHandle();
}

class SshSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;
  private refreshedSkillsForNextExecWorkdir: string | null = null;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      target: string;
      runtimePaths: ResolvedSshRuntimePaths;
    },
  ) {}

  asHandle(): SandboxBackendHandle & RemoteShellSandboxHandle {
    return {
      id: "ssh",
      runtimeId: this.params.runtimePaths.runtimeId,
      runtimeLabel: this.params.runtimePaths.runtimeId,
      workdir: this.params.runtimePaths.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.target,
      configLabelKind: "Target",
      workdirValidation: "backend",
      validateWorkdir: async (workdir) => await this.validateWorkdir(workdir),
      discardPreparedWorkdir: (workdir) => this.discardPreparedWorkdir(workdir),
      workdirRoots: [
        this.params.runtimePaths.remoteWorkspaceDir,
        this.params.runtimePaths.remoteAgentWorkspaceDir,
      ],
      remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        const remoteWorkdir = workdir ?? this.params.runtimePaths.remoteWorkspaceDir;
        const remoteCommand = buildValidatedExecRemoteCommand({
          command,
          workdir: remoteWorkdir,
          env,
        });
        await this.ensureRuntime();
        const sshSession = await this.createSession();
        try {
          if (!this.consumeRefreshedSkillsForNextExec(remoteWorkdir)) {
            await this.refreshRemoteSkillsWorkspace(sshSession);
          }
          return {
            argv: buildSshSandboxArgv({
              session: sshSession,
              remoteCommand,
              tty: usePty,
            }),
            env: sanitizeEnvVars(process.env).allowed,
            stdinMode: "pipe-open",
            finalizeToken: { sshSession } satisfies PendingExec,
          };
        } catch (error) {
          await disposeSshSandboxSession(sshSession);
          throw error;
        }
      },
      finalizeExec: async ({ token }) => {
        const sshSession = (token as PendingExec | undefined)?.sshSession;
        if (sshSession) {
          await disposeSshSandboxSession(sshSession);
        }
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: this.asHandle(),
        }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
    };
  }

  private async createSession(): Promise<SshSandboxSession> {
    return await createSshSandboxSessionFromSettings({
      ...this.params.createParams.cfg.ssh,
      target: this.params.target,
    });
  }

  private async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    // Concurrent exec/fs calls share one remote copy bootstrap; failures reset
    // the promise so the next call can retry after transient SSH errors.
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<void> {
    const session = await this.createSession();
    try {
      const exists = await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
          "openclaw-sandbox-check",
          this.params.runtimePaths.runtimeRootDir,
        ]),
      });
      if (exists.stdout.toString("utf8").trim() === "1") {
        return;
      }
      await this.replaceRemoteDirectoryFromLocal(
        session,
        this.params.createParams.workspaceDir,
        this.params.runtimePaths.remoteWorkspaceDir,
      );
      if (
        this.params.createParams.cfg.workspaceAccess !== "none" &&
        path.resolve(this.params.createParams.agentWorkspaceDir) !==
          path.resolve(this.params.createParams.workspaceDir)
      ) {
        await this.replaceRemoteDirectoryFromLocal(
          session,
          this.params.createParams.agentWorkspaceDir,
          this.params.runtimePaths.remoteAgentWorkspaceDir,
        );
      }
    } finally {
      await disposeSshSandboxSession(session);
    }
  }

  private async validateWorkdir(workdir: string): Promise<string | null> {
    await this.ensureRuntime();
    const session = await this.createSession();
    let refreshedSkillsForWorkdir: string | null = null;
    try {
      if (isRemotePathInsideRoot(this.params.runtimePaths.remoteSkillsWorkspaceDir, workdir)) {
        await this.refreshRemoteSkillsWorkspace(session);
        refreshedSkillsForWorkdir = workdir;
        this.refreshedSkillsForNextExecWorkdir = workdir;
      }
      const result = await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteWorkdirValidationCommand({
          workdir,
          root: this.resolveWorkdirValidationRoot(workdir),
        }),
        allowFailure: true,
      });
      const resolvedWorkdir = result.code === 0 ? result.stdout.toString("utf8").trim() : "";
      if (refreshedSkillsForWorkdir) {
        this.refreshedSkillsForNextExecWorkdir = resolvedWorkdir || null;
      }
      return resolvedWorkdir || null;
    } catch (error) {
      if (
        refreshedSkillsForWorkdir &&
        this.refreshedSkillsForNextExecWorkdir === refreshedSkillsForWorkdir
      ) {
        this.refreshedSkillsForNextExecWorkdir = null;
      }
      throw error;
    } finally {
      await disposeSshSandboxSession(session);
    }
  }

  private discardPreparedWorkdir(workdir: string): void {
    if (this.refreshedSkillsForNextExecWorkdir === workdir) {
      this.refreshedSkillsForNextExecWorkdir = null;
    }
  }

  private consumeRefreshedSkillsForNextExec(workdir: string): boolean {
    if (this.refreshedSkillsForNextExecWorkdir !== workdir) {
      this.refreshedSkillsForNextExecWorkdir = null;
      return false;
    }
    this.refreshedSkillsForNextExecWorkdir = null;
    return true;
  }

  private resolveWorkdirValidationRoot(workdir: string): string {
    const roots = [
      this.params.runtimePaths.remoteAgentWorkspaceDir,
      this.params.runtimePaths.remoteWorkspaceDir,
    ];
    return (
      roots.find((root) => isRemotePathInsideRoot(root, workdir)) ??
      this.params.runtimePaths.remoteWorkspaceDir
    );
  }

  private async refreshRemoteSkillsWorkspace(session: SshSandboxSession): Promise<void> {
    if (
      this.params.createParams.cfg.workspaceAccess !== "rw" ||
      !this.params.createParams.skillsWorkspaceDir
    ) {
      return;
    }
    await this.clearRemoteDirectory(session, this.params.runtimePaths.remoteSkillsWorkspaceDir);
    if (!(await isExistingDirectory(this.params.createParams.skillsWorkspaceDir))) {
      return;
    }
    await uploadDirectoryToSshTarget({
      session,
      localDir: this.params.createParams.skillsWorkspaceDir,
      remoteDir: this.params.runtimePaths.remoteSkillsWorkspaceDir,
      remoteRootDir: this.params.runtimePaths.runtimeRootDir,
    });
  }

  private async clearRemoteDirectory(session: SshSandboxSession, remoteDir: string): Promise<void> {
    await runSshSandboxCommand({
      session,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        `${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\nfind "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
        "openclaw-sandbox-clear",
        remoteDir,
        this.params.runtimePaths.runtimeRootDir,
      ]),
    });
  }

  private async replaceRemoteDirectoryFromLocal(
    session: SshSandboxSession,
    localDir: string,
    remoteDir: string,
  ): Promise<void> {
    await this.clearRemoteDirectory(session, remoteDir);
    await uploadDirectoryToSshTarget({
      session,
      localDir,
      remoteDir,
      remoteRootDir: this.params.runtimePaths.runtimeRootDir,
    });
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureRuntime();
    const session = await this.createSession();
    try {
      await this.refreshRemoteSkillsWorkspace(session);
      return await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-sandbox-fs",
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
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRemotePath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
}

function isRemotePathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedCandidate = normalizeRemotePath(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    (normalizedRoot === "/"
      ? normalizedCandidate.startsWith("/")
      : normalizedCandidate.startsWith(`${normalizedRoot}/`))
  );
}

export function resolveSshRuntimePaths(
  workspaceRoot: string,
  scopeKey: string,
): ResolvedSshRuntimePaths {
  const runtimeId = buildSshSandboxRuntimeId(scopeKey);
  const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
  return {
    runtimeId,
    runtimeRootDir,
    remoteWorkspaceDir: path.posix.join(runtimeRootDir, "workspace"),
    remoteAgentWorkspaceDir: path.posix.join(runtimeRootDir, "agent"),
    remoteSkillsWorkspaceDir: path.posix.join(
      runtimeRootDir,
      "workspace",
      ".openclaw",
      "sandbox-skills",
    ),
  };
}

function buildSshSandboxRuntimeId(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  // Keep the path human-readable while hashing the original scope to avoid
  // collisions after normalization and truncation.
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-ssh-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
