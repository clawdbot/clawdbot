// Sbx plugin module implements backend behavior.
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { createRemoteShellSandboxFsBridge, sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import type { SbxSandboxBackend } from "./backend.types.js";
import { buildSbxSandboxName, findSbxSandboxByName, runSbxCli } from "./cli.js";
import { resolveSbxPluginConfig, type ResolvedSbxPluginConfig } from "./config.js";
import { spawnSbx } from "./spawn.js";

const CREATE_TIMEOUT_FLOOR_MS = 300_000;

function buildSbxExecArgs(params: {
  sandboxName: string;
  command: string;
  workdir: string;
  env: Record<string, string>;
  usePty: boolean;
}): string[] {
  const args = ["exec", "-i"];
  if (params.usePty) {
    args.push("-t");
  }
  args.push("-w", params.workdir);
  for (const [key, value] of Object.entries(params.env)) {
    // Skip PATH: a host PATH value (Windows paths in particular) can poison
    // the sandbox's own executable lookup. Prepend it explicitly instead.
    if (key === "PATH") {
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }
  const hasCustomPath = typeof params.env.PATH === "string" && params.env.PATH.length > 0;
  if (hasCustomPath) {
    args.push("-e", `OPENCLAW_PREPEND_PATH=${params.env.PATH}`);
  }
  const pathExport = hasCustomPath
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  args.push(params.sandboxName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
  return args;
}

export function createSbxSandboxBackendFactory(params: {
  pluginConfig: ResolvedSbxPluginConfig;
}): SandboxBackendFactory {
  return async (createParams) =>
    (await createSbxSandboxBackend({ ...params, createParams })).asHandle();
}

export function createSbxSandboxBackendManager(params: {
  pluginConfig: ResolvedSbxPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config }) {
      const pluginConfig = resolveSbxPluginConfigFromConfig(config, params.pluginConfig);
      const found = await findSbxSandboxByName({ config: pluginConfig, name: entry.containerName });
      return {
        running: found !== null,
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === pluginConfig.agent,
      };
    },
    async removeRuntime({ entry, config }) {
      const pluginConfig = resolveSbxPluginConfigFromConfig(config, params.pluginConfig);
      await runSbxCli({
        config: pluginConfig,
        args: ["rm", entry.containerName, "--force"],
        allowFailure: true,
      });
    },
  };
}

async function createSbxSandboxBackend(params: {
  pluginConfig: ResolvedSbxPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<SbxSandboxBackendImpl> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("sbx sandbox backend does not support sandbox.docker.binds.");
  }
  const sandboxName = buildSbxSandboxName(params.createParams.scopeKey);
  return new SbxSandboxBackendImpl({
    createParams: params.createParams,
    pluginConfig: params.pluginConfig,
    sandboxName,
    remoteWorkspaceDir: path.resolve(params.createParams.workspaceDir),
    remoteAgentWorkspaceDir: path.resolve(params.createParams.agentWorkspaceDir),
  });
}

class SbxSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      pluginConfig: ResolvedSbxPluginConfig;
      sandboxName: string;
      remoteWorkspaceDir: string;
      remoteAgentWorkspaceDir: string;
    },
  ) {}

  asHandle(): SbxSandboxBackend {
    return {
      id: "sbx",
      runtimeId: this.params.sandboxName,
      runtimeLabel: this.params.sandboxName,
      workdir: this.params.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.pluginConfig.agent,
      configLabelKind: "Agent",
      remoteWorkspaceDir: this.params.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        await this.ensureSandboxExists();
        return {
          argv: [
            this.params.pluginConfig.command,
            ...buildSbxExecArgs({
              sandboxName: this.params.sandboxName,
              command,
              workdir: workdir ?? this.params.remoteWorkspaceDir,
              env,
              usePty,
            }),
          ],
          env: sanitizeEnvVars(process.env).allowed,
          stdinMode: "pipe-open",
        };
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({ sandbox, runtime: this.asHandle() }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
    };
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureSandboxExists();
    return await spawnSbx(
      [
        this.params.pluginConfig.command,
        "exec",
        "-i",
        this.params.sandboxName,
        "/bin/sh",
        "-c",
        params.script,
        "openclaw-sbx-fs",
        ...(params.args ?? []),
      ],
      {
        input: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      },
    );
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
    const existing = await findSbxSandboxByName({
      config: this.params.pluginConfig,
      name: this.params.sandboxName,
    });
    if (existing) {
      return;
    }

    const workspaceAccess = this.params.createParams.cfg.workspaceAccess;
    const primaryArg = `${this.params.remoteWorkspaceDir}${workspaceAccess !== "rw" ? ":ro" : ""}`;
    const args = ["create", this.params.pluginConfig.agent, primaryArg];
    if (
      workspaceAccess !== "none" &&
      this.params.remoteAgentWorkspaceDir !== this.params.remoteWorkspaceDir
    ) {
      args.push(`${this.params.remoteAgentWorkspaceDir}${workspaceAccess === "ro" ? ":ro" : ""}`);
    }
    args.push("--name", this.params.sandboxName, "--pull", this.params.pluginConfig.pull);
    if (this.params.pluginConfig.template) {
      args.push("--template", this.params.pluginConfig.template);
    }

    const result = await runSbxCli({
      config: this.params.pluginConfig,
      args,
      timeoutMs: Math.max(this.params.pluginConfig.timeoutMs, CREATE_TIMEOUT_FLOOR_MS),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "sbx create failed");
    }
  }
}

function resolveSbxPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedSbxPluginConfig,
): ResolvedSbxPluginConfig {
  const pluginConfig = config.plugins?.entries?.sbx?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveSbxPluginConfig(pluginConfig);
}
