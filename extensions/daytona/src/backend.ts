// Daytona sandbox backend: sandbox lifecycle, exec spec building, and remote shell transport.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  resolvePreferredOpenClawTmpDir,
  sanitizeEnvVars,
  type CreateSandboxBackendParams,
  type OpenClawConfig,
  type RemoteShellSandboxHandle,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
  type SandboxBackendFactory,
  type SandboxBackendHandle,
  type SandboxBackendManager,
  type SandboxBackendRuntimeInfo,
} from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createDaytonaClient,
  isDaytonaNotFoundError,
  resolveDaytonaConnection,
  withDaytonaRetry,
  type Daytona,
  type Sandbox,
} from "./client.js";
import { resolveDaytonaPluginConfig, type ResolvedDaytonaPluginConfig } from "./config.js";
import { resolveDaytonaLauncherPath } from "./launcher-path.js";
import { uploadDirectoryToDaytonaSandbox } from "./upload.js";

type DaytonaExecLauncherPayload = {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  sandboxId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  usePty: boolean;
};

type PendingDaytonaExec = {
  payloadDir: string;
};

// Snapshot label shown when the sandbox uses the Daytona org default snapshot.
const DEFAULT_SNAPSHOT_LABEL = "default";

// Image-based creates pull or build the image before the sandbox starts, so
// they get a higher timeout floor than snapshot creates.
const IMAGE_CREATE_TIMEOUT_FLOOR_SECONDS = 600;

function resolveConfiguredBaseLabel(pluginConfig: ResolvedDaytonaPluginConfig): string {
  return pluginConfig.snapshot ?? pluginConfig.image ?? DEFAULT_SNAPSHOT_LABEL;
}

// Sandboxes in these states cannot be started again; adoption skips them so a
// fresh sandbox replaces the retired runtime id in the registry. Stopped,
// archived, paused, transitional, and unknown states stay adoptable on
// purpose: start() either recovers them or fails loudly, while skipping
// unknown states would silently mint a new sandbox per run on SDK/server
// version skew.
const UNUSABLE_SANDBOX_STATES = new Set(["destroyed", "destroying", "error", "build_failed"]);

// Seeded sandbox ids for this process. Skips one remote existence probe per
// factory call; a fresh process re-probes, so stale entries only cost a probe.
const seededDaytonaSandboxes = new Set<string>();

// Factories for the same scope can be constructed concurrently from the same
// empty registry snapshot. Share provisioning across implementations so only
// one remote sandbox is created before core records the returned runtime id.
const daytonaProvisioningByScope = new Map<string, Promise<Sandbox>>();

function hashScopeKey(scopeKey: string): string {
  return createHash("sha256").update(scopeKey).digest("hex").slice(0, 32);
}

function isRemotePathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.posix.normalize(root).replace(/\/+$/, "") || "/";
  const normalizedCandidate = path.posix.normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export function createDaytonaSandboxBackendFactory(params: {
  pluginConfig: ResolvedDaytonaPluginConfig;
  hostConfig: OpenClawConfig;
}): SandboxBackendFactory {
  return async (createParams) =>
    await createDaytonaSandboxBackend({
      pluginConfig: params.pluginConfig,
      hostConfig: params.hostConfig,
      createParams,
    });
}

async function createDaytonaSandboxBackend(params: {
  pluginConfig: ResolvedDaytonaPluginConfig;
  hostConfig: OpenClawConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<SandboxBackendHandle> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("Daytona sandbox backend does not support sandbox.docker.binds.");
  }
  const impl = new DaytonaSandboxBackendImpl(params);
  // The Daytona sandbox id is the runtime id, so the factory must resolve or
  // create the sandbox before it can hand out a handle (docker does the same).
  await impl.ensureSandbox();
  return impl.asHandle();
}

class DaytonaSandboxBackendImpl {
  private ensurePromise: Promise<Sandbox> | null = null;
  private ensuredSandbox: Sandbox | null = null;
  private client: Daytona | null = null;
  private refreshedSkillsForNextExecWorkdir: string | null = null;

  constructor(
    private readonly params: {
      pluginConfig: ResolvedDaytonaPluginConfig;
      hostConfig: OpenClawConfig;
      createParams: CreateSandboxBackendParams;
    },
  ) {}

  private get pluginConfig(): ResolvedDaytonaPluginConfig {
    return this.params.pluginConfig;
  }

  private get remoteSkillsWorkspaceDir(): string {
    return path.posix.join(this.pluginConfig.remoteWorkspaceDir, ".openclaw", "sandbox-skills");
  }

  private get timeoutSeconds(): number {
    return Math.max(1, Math.ceil(this.pluginConfig.timeoutMs / 1000));
  }

  asHandle(): SandboxBackendHandle & RemoteShellSandboxHandle {
    const sandbox = this.requireSandbox();
    return {
      id: "daytona",
      runtimeId: sandbox.id,
      runtimeLabel: sandbox.name || sandbox.id,
      workdir: this.pluginConfig.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: resolveConfiguredBaseLabel(this.pluginConfig),
      configLabelKind: this.pluginConfig.image ? "Image" : "Snapshot",
      workdirValidation: "backend",
      validateWorkdir: async (workdir) => await this.validateWorkdir(workdir),
      discardPreparedWorkdir: (workdir) => this.discardPreparedWorkdir(workdir),
      workdirRoots: [
        this.pluginConfig.remoteWorkspaceDir,
        this.pluginConfig.remoteAgentWorkspaceDir,
      ],
      remoteWorkspaceDir: this.pluginConfig.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.pluginConfig.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        const remoteWorkdir = workdir ?? this.pluginConfig.remoteWorkspaceDir;
        const remoteCommand = buildValidatedExecRemoteCommand({
          command,
          workdir: remoteWorkdir,
          env: {},
        });
        const ensured = await this.ensureSandbox();
        if (!this.consumeRefreshedSkillsForNextExec(remoteWorkdir)) {
          await this.refreshRemoteSkillsWorkspace();
        }
        const connection = await resolveDaytonaConnection({
          config: this.params.hostConfig,
          pluginConfig: this.pluginConfig,
        });
        const payload: DaytonaExecLauncherPayload = {
          apiKey: connection.apiKey,
          apiUrl: connection.apiUrl,
          target: connection.target,
          sandboxId: ensured.id,
          command: remoteCommand,
          cwd: remoteWorkdir,
          env,
          usePty,
        };
        const payloadDir = await fs.mkdtemp(
          path.join(resolvePreferredOpenClawTmpDir(), "openclaw-daytona-"),
        );
        const payloadFile = path.join(payloadDir, "payload.json");
        // The payload carries the API key: owner-only fresh file, deleted by
        // the launcher on read and by finalizeExec when the spawn never ran.
        await fs.writeFile(payloadFile, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
        return {
          argv: [process.execPath, resolveDaytonaLauncherPath(), "--payload-file", payloadFile],
          env: sanitizeEnvVars(process.env).allowed,
          stdinMode: "pipe-open",
          finalizeToken: { payloadDir } satisfies PendingDaytonaExec,
        };
      },
      finalizeExec: async ({ token }) => {
        const payloadDir = isRecord(token) ? token.payloadDir : undefined;
        if (typeof payloadDir === "string") {
          await fs.rm(payloadDir, { recursive: true, force: true });
        }
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox: sandboxContext }) =>
        createRemoteShellSandboxFsBridge({
          sandbox: sandboxContext,
          runtime: this.asHandle(),
        }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
    };
  }

  private requireSandbox(): Sandbox {
    if (!this.ensuredSandbox) {
      throw new Error("Daytona sandbox runtime is not provisioned yet.");
    }
    return this.ensuredSandbox;
  }

  async ensureSandbox(): Promise<Sandbox> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    const scopeKey = this.params.createParams.scopeKey;
    // Concurrent exec/fs calls and separate factory implementations share one
    // provisioning attempt. Failures reset both owners for a later retry.
    const pending = daytonaProvisioningByScope.get(scopeKey) ?? this.ensureSandboxInner();
    this.ensurePromise = pending;
    daytonaProvisioningByScope.set(scopeKey, pending);
    try {
      const sandbox = await pending;
      this.ensuredSandbox = sandbox;
      return sandbox;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    } finally {
      if (daytonaProvisioningByScope.get(scopeKey) === pending) {
        daytonaProvisioningByScope.delete(scopeKey);
      }
    }
  }

  private async getClient(): Promise<Daytona> {
    if (this.client) {
      return this.client;
    }
    const connection = await resolveDaytonaConnection({
      config: this.params.hostConfig,
      pluginConfig: this.pluginConfig,
    });
    this.client = await createDaytonaClient(connection);
    return this.client;
  }

  private async ensureSandboxInner(): Promise<Sandbox> {
    const client = await this.getClient();
    const adopted = await this.adoptRegisteredSandbox(client);
    if (adopted) {
      await this.startSandboxIfNeeded(adopted);
      if (!seededDaytonaSandboxes.has(adopted.id)) {
        await this.seedWorkspaceIfMissing(adopted);
        seededDaytonaSandboxes.add(adopted.id);
      }
      return adopted;
    }
    const baseParams = {
      labels: {
        "openclaw.sandbox": "1",
        "openclaw.scope": hashScopeKey(this.params.createParams.scopeKey),
      },
      user: this.pluginConfig.user,
      volumes: this.pluginConfig.volumes,
      autoStopInterval: this.pluginConfig.autoStopInterval,
      autoPauseInterval: this.pluginConfig.autoPauseInterval,
      autoArchiveInterval: this.pluginConfig.autoArchiveInterval,
      autoDeleteInterval: this.pluginConfig.autoDeleteInterval,
      networkBlockAll: this.pluginConfig.networkBlockAll,
      networkAllowList: this.pluginConfig.networkAllowList,
      domainAllowList: this.pluginConfig.domainAllowList,
    };
    // Config resolution rejects snapshot+image together, so this branch picks
    // the create overload rather than encoding a precedence policy.
    const sandbox = this.pluginConfig.image
      ? await client.create(
          {
            ...baseParams,
            image: this.pluginConfig.image,
            resources: this.pluginConfig.resources,
          },
          { timeout: Math.max(this.timeoutSeconds, IMAGE_CREATE_TIMEOUT_FLOOR_SECONDS) },
        )
      : await client.create(
          { ...baseParams, snapshot: this.pluginConfig.snapshot },
          { timeout: this.timeoutSeconds },
        );
    try {
      await this.seedWorkspace(sandbox);
    } catch (error) {
      // Core cannot register a handle until seeding succeeds, so a newly
      // created runtime must be deleted here or it becomes undiscoverable.
      await sandbox.delete(this.timeoutSeconds).catch(() => {});
      throw error;
    }
    seededDaytonaSandboxes.add(sandbox.id);
    return sandbox;
  }

  private async adoptRegisteredSandbox(client: Daytona): Promise<Sandbox | null> {
    for (const runtimeId of this.params.createParams.registeredRuntimeIds ?? []) {
      let sandbox: Sandbox;
      try {
        sandbox = await withDaytonaRetry("daytona get", () => client.get(runtimeId));
      } catch (error) {
        if (isDaytonaNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      if (sandbox.state && UNUSABLE_SANDBOX_STATES.has(sandbox.state)) {
        continue;
      }
      return sandbox;
    }
    return null;
  }

  private async startSandboxIfNeeded(sandbox: Sandbox): Promise<void> {
    if (sandbox.state === "started") {
      return;
    }
    try {
      await sandbox.start(this.timeoutSeconds);
    } catch (error) {
      // start() races sandbox auto-start and concurrent adopters; a sandbox
      // that reports started after the failure is usable.
      await sandbox.refreshData().catch(() => {});
      const refreshedState: string | undefined = sandbox.state;
      if (refreshedState !== "started") {
        throw error;
      }
    }
  }

  private async seedWorkspaceIfMissing(sandbox: Sandbox): Promise<void> {
    const probe = await this.runWrappedRemoteCommand(
      sandbox,
      buildRemoteCommand([
        "/bin/sh",
        "-c",
        'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
        "openclaw-sandbox-check",
        this.pluginConfig.remoteWorkspaceDir,
      ]),
      {},
    );
    if (probe.stdout.toString("utf8").trim() === "1") {
      return;
    }
    await this.seedWorkspace(sandbox);
  }

  private async seedWorkspace(sandbox: Sandbox): Promise<void> {
    await this.uploadDirectory(
      sandbox,
      this.params.createParams.workspaceDir,
      this.pluginConfig.remoteWorkspaceDir,
    );
    if (
      this.params.createParams.cfg.workspaceAccess !== "none" &&
      path.resolve(this.params.createParams.agentWorkspaceDir) !==
        path.resolve(this.params.createParams.workspaceDir)
    ) {
      await this.uploadDirectory(
        sandbox,
        this.params.createParams.agentWorkspaceDir,
        this.pluginConfig.remoteAgentWorkspaceDir,
      );
    }
  }

  private async uploadDirectory(
    sandbox: Sandbox,
    localDir: string,
    remoteDir: string,
  ): Promise<void> {
    await uploadDirectoryToDaytonaSandbox({
      sandbox,
      localDir,
      remoteDir,
      timeoutMs: this.pluginConfig.timeoutMs,
      runRemoteShellScript: async ({ script, args }) =>
        await this.runWrappedRemoteCommand(
          sandbox,
          buildRemoteCommand(["/bin/sh", "-c", script, "openclaw-sandbox-upload", ...(args ?? [])]),
          {},
        ),
      runRemoteOperation: async (run) => await this.withStartedSandbox(sandbox, run),
    });
  }

  private async validateWorkdir(workdir: string): Promise<string | null> {
    const sandbox = await this.ensureSandbox();
    let refreshedSkillsForWorkdir: string | null = null;
    try {
      if (isRemotePathInsideRoot(this.remoteSkillsWorkspaceDir, workdir)) {
        await this.refreshRemoteSkillsWorkspace();
        refreshedSkillsForWorkdir = workdir;
        this.refreshedSkillsForNextExecWorkdir = workdir;
      }
      const result = await this.runWrappedRemoteCommand(
        sandbox,
        buildRemoteWorkdirValidationCommand({
          workdir,
          root: this.resolveWorkdirValidationRoot(workdir),
        }),
        { allowFailure: true },
      );
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
    const roots = [this.pluginConfig.remoteAgentWorkspaceDir, this.pluginConfig.remoteWorkspaceDir];
    return (
      roots.find((root) => isRemotePathInsideRoot(root, workdir)) ??
      this.pluginConfig.remoteWorkspaceDir
    );
  }

  private async refreshRemoteSkillsWorkspace(): Promise<void> {
    if (
      this.params.createParams.cfg.workspaceAccess !== "rw" ||
      !this.params.createParams.skillsWorkspaceDir
    ) {
      return;
    }
    const sandbox = await this.ensureSandbox();
    await this.runWrappedRemoteCommand(
      sandbox,
      buildRemoteCommand([
        "/bin/sh",
        "-c",
        'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        "openclaw-sandbox-clear",
        this.remoteSkillsWorkspaceDir,
      ]),
      {},
    );
    if (!(await isExistingDirectory(this.params.createParams.skillsWorkspaceDir))) {
      return;
    }
    await this.uploadDirectory(
      sandbox,
      this.params.createParams.skillsWorkspaceDir,
      this.remoteSkillsWorkspaceDir,
    );
  }

  private async runRemoteShellScript(
    command: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    const sandbox = await this.ensureSandbox();
    await this.refreshRemoteSkillsWorkspace();
    return await this.runWrappedRemoteCommand(
      sandbox,
      buildRemoteCommand([
        "/bin/sh",
        "-c",
        command.script,
        "openclaw-sandbox-fs",
        ...(command.args ?? []),
      ]),
      {
        stdin: command.stdin,
        allowFailure: command.allowFailure,
        signal: command.signal,
      },
    );
  }

  /**
   * Run a shell command through a per-call Daytona session with separated,
   * binary-safe streams. The session transport exists for cancellation:
   * deleting the session kills the running remote command, so an abort stops
   * the mutation before the caller is told it stopped. Session output is not
   * binary-safe, so the command redirects both streams to files and emits
   * them base64-encoded on stdout.
   */
  private async runWrappedRemoteCommand(
    sandbox: Sandbox,
    rawCommand: string,
    options: { stdin?: Buffer | string; allowFailure?: boolean; signal?: AbortSignal },
  ): Promise<SandboxBackendCommandResult> {
    options.signal?.throwIfAborted();
    const token = randomBytes(8).toString("hex");
    const stdinPath = options.stdin === undefined ? null : `/tmp/openclaw-in-${token}`;
    const outPath = `/tmp/openclaw-out-${token}`;
    const errPath = `/tmp/openclaw-err-${token}`;
    const stagedPaths = stdinPath ? [stdinPath, outPath, errPath] : [outPath, errPath];
    const separator = `__openclaw-daytona-${token}__`;
    const wrapped = [
      `{ ${rawCommand}${stdinPath ? ` < ${stdinPath}` : ""} ; } > ${outPath} 2> ${errPath}`,
      "oc_ec=$?",
      `base64 < ${outPath}`,
      `printf '%s' '${separator}'`,
      `base64 < ${errPath}`,
      `rm -f ${outPath} ${errPath}${stdinPath ? ` ${stdinPath}` : ""}`,
      // Subshell exit reports the command status without killing the session
      // shell; a top-level exit hangs the synchronous session response.
      "( exit $oc_ec )",
    ].join("; ");
    const sessionId = `openclaw-fs-${token}`;
    let response: { stdout?: string; exitCode?: number | null };
    try {
      if (stdinPath) {
        const data =
          typeof options.stdin === "string" ? Buffer.from(options.stdin, "utf8") : options.stdin;
        await this.withStartedSandbox(sandbox, () =>
          sandbox.fs.uploadFile(data ?? Buffer.alloc(0), stdinPath, this.timeoutSeconds),
        );
        options.signal?.throwIfAborted();
      }
      await this.withStartedSandbox(sandbox, () => sandbox.process.createSession(sessionId));
      response = await this.runCancellableSessionCommand(
        sandbox,
        sessionId,
        wrapped,
        options.signal,
      );
    } catch (error) {
      // Deleting the session terminates a still-running remote command, and
      // the sandbox persists per scope, so staged transport files must not
      // outlive a failed or aborted operation. Missing files are ignored.
      await sandbox.process.deleteSession(sessionId).catch(() => {});
      await this.removeRemoteStagingFiles(sandbox, stagedPaths);
      throw error;
    }
    // Per-call sessions are single use; release the daemon-side shell.
    await sandbox.process.deleteSession(sessionId).catch(() => {});
    const merged = response.stdout ?? "";
    const separatorIndex = merged.indexOf(separator);
    if (separatorIndex < 0) {
      throw new Error(
        `Daytona sandbox command transport produced unexpected output: ${merged.slice(0, 200)}`,
      );
    }
    const stdout = Buffer.from(merged.slice(0, separatorIndex), "base64");
    const stderr = Buffer.from(merged.slice(separatorIndex + separator.length), "base64");
    const code = response.exitCode ?? 1;
    if (code !== 0 && !options.allowFailure) {
      throw new Error(
        stderr.toString("utf8").trim() || `Daytona sandbox command failed with exit code ${code}`,
      );
    }
    return { stdout, stderr, code };
  }

  /**
   * Execute one session command synchronously; on abort, kill the remote
   * command by deleting its session and only then report the abort, so a
   * cancelled mutation cannot keep changing sandbox state after rejection.
   */
  private async runCancellableSessionCommand(
    sandbox: Sandbox,
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ stdout?: string; exitCode?: number | null }> {
    signal?.throwIfAborted();
    const execution = sandbox.process.executeSessionCommand(
      sessionId,
      { command, runAsync: false, suppressInputEcho: true },
      this.timeoutSeconds,
    );
    if (!signal) {
      return await execution;
    }
    let removeAbortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        void sandbox.process
          .deleteSession(sessionId)
          .catch(() => {})
          .then(() => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Daytona sandbox command aborted"),
            );
          });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([execution, aborted]);
    } finally {
      removeAbortListener?.();
      // Silence rejections from the losing branch after settle.
      execution.catch(() => {});
    }
  }

  /**
   * Daytona auto-stops idle sandboxes, and a cached handle can outlive that.
   * First-touch failures get one refresh-start-retry so a sandbox stopped
   * between tool calls restarts on next use, matching the documented model.
   */
  private async withStartedSandbox<T>(sandbox: Sandbox, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isDaytonaNotFoundError(error)) {
        throw error;
      }
      await sandbox.refreshData().catch(() => {});
      const state: string | undefined = sandbox.state;
      if (state === "started" || (state && UNUSABLE_SANDBOX_STATES.has(state))) {
        throw error;
      }
      await sandbox.start(this.timeoutSeconds);
      return await run();
    }
  }

  private async removeRemoteStagingFiles(sandbox: Sandbox, stagedPaths: string[]): Promise<void> {
    for (const stagedPath of stagedPaths) {
      await sandbox.fs.deleteFile(stagedPath).catch(() => {});
    }
  }
}

function resolveDaytonaPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedDaytonaPluginConfig,
): ResolvedDaytonaPluginConfig {
  const raw = config.plugins?.entries?.daytona?.config;
  if (raw === undefined) {
    return fallback;
  }
  try {
    return resolveDaytonaPluginConfig(raw);
  } catch {
    return fallback;
  }
}

export function createDaytonaSandboxBackendManager(params: {
  pluginConfig: ResolvedDaytonaPluginConfig;
  hostConfig: OpenClawConfig;
}): SandboxBackendManager {
  const getSandboxForEntry = async (config: OpenClawConfig, containerName: string) => {
    const pluginConfig = resolveDaytonaPluginConfigFromConfig(config, params.pluginConfig);
    const connection = await resolveDaytonaConnection({ config, pluginConfig });
    const client = await createDaytonaClient(connection);
    return {
      pluginConfig,
      sandbox: await withDaytonaRetry("daytona get", () => client.get(containerName)),
    };
  };
  return {
    async describeRuntime({ entry, config }): Promise<SandboxBackendRuntimeInfo> {
      const pluginConfig = resolveDaytonaPluginConfigFromConfig(config, params.pluginConfig);
      const configuredLabel = resolveConfiguredBaseLabel(pluginConfig);
      try {
        const { sandbox } = await getSandboxForEntry(config, entry.containerName);
        return {
          running: sandbox.state === "started",
          actualConfigLabel: sandbox.snapshot ?? DEFAULT_SNAPSHOT_LABEL,
          configLabelMatch: entry.image === configuredLabel,
        };
      } catch (error) {
        if (isDaytonaNotFoundError(error)) {
          return { running: false, configLabelMatch: entry.image === configuredLabel };
        }
        throw error;
      }
    },
    async removeRuntime({ entry, config }): Promise<void> {
      let sandbox: Sandbox;
      try {
        ({ sandbox } = await getSandboxForEntry(config, entry.containerName));
      } catch (error) {
        if (isDaytonaNotFoundError(error)) {
          return;
        }
        throw error;
      }
      const timeoutSeconds = Math.max(
        1,
        Math.ceil(
          resolveDaytonaPluginConfigFromConfig(config, params.pluginConfig).timeoutMs / 1000,
        ),
      );
      await withDaytonaRetry("daytona delete", () => sandbox.delete(timeoutSeconds));
    },
  };
}
